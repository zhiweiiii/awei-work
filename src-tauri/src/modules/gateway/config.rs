//! Relay definitions and the credential that guards the local gateway.

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

/// The wire format a relay speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiFormat {
    /// Native Anthropic Messages. Bodies pass through untouched.
    Anthropic,
    /// OpenAI Chat Completions. Bodies are converted in both directions.
    OpenaiChat,
    OpenaiResponses,
}

/// How a relay wants its credential presented. It cannot be inferred from the
/// format: OpenCode Zen serves Anthropic on `/zen/go` but silently ignores a
/// Bearer header there and only honours `x-api-key`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStyle {
    Bearer,
    ApiKey,
}

/// Upstream model per Claude Code role. An empty field falls back to
/// `default`, and an empty `default` passes the requested name through.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoutes {
    #[serde(default)]
    pub default: String,
    #[serde(default)]
    pub opus: String,
    #[serde(default)]
    pub sonnet: String,
    #[serde(default)]
    pub haiku: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub api_format: ApiFormat,
    pub auth_style: AuthStyle,
    #[serde(default)]
    pub models: ModelRoutes,
    /// The model's real context window, in tokens. Absent leaves Claude Code to
    /// its own assumption, which is 200k for any model it does not know.
    #[serde(default)]
    pub context_window: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub providers: Vec<Provider>,
    #[serde(default)]
    pub current: Option<String>,
}

impl Config {
    pub fn current_provider(&self) -> Option<&Provider> {
        let id = self.current.as_deref()?;
        self.providers.iter().find(|p| p.id == id)
    }
}

fn state() -> &'static RwLock<Config> {
    static STATE: OnceLock<RwLock<Config>> = OnceLock::new();
    STATE.get_or_init(|| RwLock::new(Config::default()))
}

pub fn replace(config: Config) {
    *state().write().expect("gateway config lock") = config;
}

pub fn current_provider() -> Option<Provider> {
    state()
        .read()
        .expect("gateway config lock")
        .current_provider()
        .cloned()
}

/// Look one up by the id carried in the request path. This is what keeps two
/// terminals independent: each shell was pointed at its own provider's URL, so
/// selecting a different one elsewhere cannot redirect a session already
/// running.
pub fn provider_by_id(id: &str) -> Option<Provider> {
    state()
        .read()
        .expect("gateway config lock")
        .providers
        .iter()
        .find(|provider| provider.id == id)
        .cloned()
}

impl Provider {
    pub(super) fn text_model(&self, selected: &str) -> Option<&str> {
        [
            &self.models.default,
            &self.models.sonnet,
            &self.models.haiku,
            &self.models.opus,
        ]
        .into_iter()
        .map(|model| strip_context_marker(model))
        .find(|model| !model.is_empty() && *model == selected)
    }

    /// The upstream URL for an Anthropic Messages request.
    pub fn messages_url(&self) -> String {
        let base = self.base_url.trim().trim_end_matches('/');
        match self.api_format {
            ApiFormat::Anthropic => join_once(base, "/v1/messages"),
            ApiFormat::OpenaiChat => join_once(base, "/chat/completions"),
            ApiFormat::OpenaiResponses => join_once(base, "/v1/responses"),
        }
    }

    /// OpenCode Zen's Go plan rejects any request without `x-opencode-session`
    /// ("cannot be routed efficiently"), which it uses to keep a conversation on
    /// one backend. Matched on the host because the requirement belongs to that
    /// service, not to the wire format.
    pub fn wants_session_header(&self) -> bool {
        reqwest::Url::parse(self.base_url.trim())
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .is_some_and(|host| host == "opencode.ai" || host.ends_with(".opencode.ai"))
    }

    /// Resolve what Claude Code asked for into what this relay serves.
    pub fn upstream_model(&self, requested: &str) -> String {
        let requested = strip_context_marker(requested);
        let role = role_of(requested);
        if role.is_none()
            && [
                &self.models.default,
                &self.models.opus,
                &self.models.sonnet,
                &self.models.haiku,
            ]
            .into_iter()
            .any(|model| !model.trim().is_empty() && strip_context_marker(model) == requested)
        {
            return requested.to_string();
        }
        let by_role = match role {
            Some("opus") => self.models.opus.trim(),
            Some("sonnet") => self.models.sonnet.trim(),
            Some("haiku") => self.models.haiku.trim(),
            _ => "",
        };
        for candidate in [by_role, self.models.default.trim()] {
            let candidate = strip_context_marker(candidate);
            if !candidate.is_empty() {
                return candidate.to_string();
            }
        }
        requested.to_string()
    }
}

/// Append `suffix` unless the base already ends with it, which is what happens
/// when a user pastes a full endpoint into the base URL field.
fn join_once(base: &str, suffix: &str) -> String {
    let lower = base.to_ascii_lowercase();
    if lower.ends_with(suffix) {
        return base.to_string();
    }
    // `/v1/messages` under a base that already ends in `/v1` would double the
    // version segment.
    if let Some(tail) = suffix.strip_prefix("/v1") {
        if lower.ends_with("/v1") {
            return format!("{base}{tail}");
        }
    }
    format!("{base}{suffix}")
}

/// Claude Code appends `[1m]` to declare a 1M context window. It is a client
/// side marker and upstreams reject it as part of a model name.
pub(super) fn strip_context_marker(model: &str) -> &str {
    let model = model.trim();
    let marker = "[1m]";
    if model.len() >= marker.len()
        && model
            .get(model.len() - marker.len()..)
            .is_some_and(|tail| tail.eq_ignore_ascii_case(marker))
    {
        return model[..model.len() - marker.len()].trim_end();
    }
    model
}

/// Claude Code also asks for dated full names such as
/// `claude-haiku-4-5-20251001`, so match on the role word rather than equality.
fn role_of(model: &str) -> Option<&'static str> {
    let model = model.to_ascii_lowercase();
    ["opus", "haiku", "sonnet"]
        .into_iter()
        .find(|role| model.contains(role))
}

fn token_path() -> Option<PathBuf> {
    let dir = dirs::data_local_dir()?.join("terax");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("gateway-token"))
}

/// The bearer value Claude Code must present. Persisted so a shell configured
/// before a restart keeps working; without that every restart would silently
/// break every open terminal.
pub fn token() -> Result<String, String> {
    static TOKEN: OnceLock<Result<String, String>> = OnceLock::new();
    TOKEN
        .get_or_init(|| {
            let path = token_path().ok_or("gateway token directory unavailable")?;
            match read_token(&path) {
                Ok(existing) => return Ok(existing),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("gateway token unavailable: {error}")),
            }
            let mut bytes = [0u8; 16];
            getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
            let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let mut tmp =
                tempfile::NamedTempFile::new_in(path.parent().ok_or("missing token directory")?)
                    .map_err(|e| e.to_string())?;
            tmp.write_all(token.as_bytes()).map_err(|e| e.to_string())?;
            tmp.as_file().sync_all().map_err(|e| e.to_string())?;
            match tmp.persist_noclobber(&path) {
                Ok(_) => Ok(token),
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    read_token(&path).map_err(|e| e.to_string())
                }
                Err(error) => Err(error.error.to_string()),
            }
        })
        .clone()
}

fn read_token(path: &std::path::Path) -> std::io::Result<String> {
    let mut text = String::new();
    fs::File::open(path)?.take(65).read_to_string(&mut text)?;
    let token = text.trim();
    if text.len() > 64 || token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(std::io::Error::other("invalid gateway token"));
    }
    Ok(token.to_string())
}
