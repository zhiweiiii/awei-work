//! Loopback endpoints for Claude Code and Codex.
//!
//! Claude Code only speaks the Anthropic Messages API, while most relays sell
//! their capacity through OpenAI Chat Completions. This module accepts the
//! former, converts it to whatever the selected relay speaks, and converts the
//! reply back, so switching provider is a menu choice rather than a different
//! client.
//!
//! Same shape as the web bridge: a blocking accept loop with a thread per
//! connection. It binds loopback only and never 0.0.0.0, because it forwards
//! the user's paid credential; a LAN listener would hand the subscription to
//! anything on the network.

pub mod config;
mod convert;
mod sse;
mod stream;
mod upstream;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use config::{ApiFormat, Config, Provider};

const BIND_ADDR: &str = "127.0.0.1";
/// Distinct from the web bridge's 34268/34269 so both can listen at once, and
/// distinct between dev and release so a debug build never steals the port a
/// packaged install is already serving.
const PORT: u16 = if cfg!(debug_assertions) { 34267 } else { 34266 };

/// Bodies carry images and whole file contents. Generous, but bounded: an
/// unbounded read is a way to make the app allocate until it dies.
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAX_HEAD_BYTES: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 16;
static LISTENER: Mutex<Option<ListenerHandle>> = Mutex::new(None);

struct ListenerHandle {
    shutdown: Arc<AtomicBool>,
    thread: thread::JoinHandle<()>,
}

struct ConnectionGuard;
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
    }
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static BOUND_PORT: AtomicU16 = AtomicU16::new(0);

/// Start the gateway. Errors only if the port cannot be bound; the accept loop
/// runs on its own thread.
pub fn start() -> Result<(), String> {
    let mut owner = LISTENER.lock().map_err(|_| "gateway startup unavailable")?;
    if let Some(handle) = owner.as_ref() {
        if !handle.thread.is_finished() {
            return Ok(());
        }
    }
    if let Some(handle) = owner.take() {
        let _ = handle.thread.join();
    }
    config::token()?;
    let listener = TcpListener::bind((BIND_ADDR, PORT))
        .map_err(|e| format!("gateway: failed to bind {BIND_ADDR}:{PORT}: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    BOUND_PORT.store(PORT, Ordering::Release);
    RUNNING.store(true, Ordering::Release);
    log::info!("claude gateway listening on http://{BIND_ADDR}:{PORT}");
    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = Arc::clone(&shutdown);
    let thread = thread::Builder::new()
        .name("terax-gateway-accept".into())
        .spawn(move || {
            while !thread_shutdown.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if ACTIVE
                            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                                (active < MAX_CONNECTIONS).then_some(active + 1)
                            })
                            .is_err()
                        {
                            continue;
                        }
                        let guard = ConnectionGuard;
                        let _ = stream.set_nodelay(true);
                        if let Err(error) = thread::Builder::new()
                            .name("terax-gateway-conn".into())
                            .spawn(move || {
                                let _guard = guard;
                                handle_connection(stream);
                            })
                        {
                            log::warn!("gateway connection spawn failed: {error}");
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20))
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => {
                        log::warn!("gateway: accept error: {e}");
                        break;
                    }
                }
            }
            drop(listener);
            RUNNING.store(false, Ordering::Release);
        })
        .map_err(|e| {
            RUNNING.store(false, Ordering::Release);
            BOUND_PORT.store(0, Ordering::Release);
            e.to_string()
        })?;
    *owner = Some(ListenerHandle { shutdown, thread });
    Ok(())
}

pub fn stop() {
    let Ok(mut owner) = LISTENER.lock() else {
        return;
    };
    if let Some(handle) = owner.take() {
        handle.shutdown.store(true, Ordering::Release);
        let _ = handle.thread.join();
    }
    RUNNING.store(false, Ordering::Release);
    BOUND_PORT.store(0, Ordering::Release);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    running: bool,
    /// Origin on its own, for display.
    origin: String,
    /// Append a provider id to get what goes in ANTHROPIC_BASE_URL. Pinning the
    /// provider into the URL is what keeps one terminal's choice out of
    /// another's.
    provider_url_prefix: String,
    /// What to put in ANTHROPIC_AUTH_TOKEN.
    token: String,
    active_requests: usize,
    current: Option<String>,
}

#[tauri::command]
pub fn gateway_status() -> Result<Status, String> {
    let origin = format!("http://{BIND_ADDR}:{}", BOUND_PORT.load(Ordering::Acquire));
    Ok(Status {
        running: RUNNING.load(Ordering::Acquire),
        provider_url_prefix: format!("{origin}{PIN_PREFIX}"),
        origin,
        token: config::token()?,
        active_requests: ACTIVE.load(Ordering::Acquire),
        current: config::current_provider().map(|p| p.id),
    })
}

/// The variables a shell needs to reach a given provider through the gateway,
/// as `(ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN)`.
///
/// Injected when the pty is spawned rather than typed into the shell: an
/// assignment typed at the prompt lands in the terminal and in PSReadLine's
/// history, and it cannot apply to a Claude Code that is already running
/// anyway. Starts the listener if it is not up, because a shell is about to
/// depend on it.
pub struct ShellEnv {
    pub base_url: String,
    pub token: String,
    /// The model's real context window, when the provider declares one.
    ///
    /// Claude Code sizes auto-compaction from what it believes a model's window
    /// is. It only knows Anthropic's own models: for a relay's
    /// `deepseek-v4-flash` and the like it assumes 200k, so it lets a
    /// conversation grow to that size and the relay then rejects the request
    /// once input plus output passes its real, smaller limit. Passing the
    /// window explicitly makes the client compact at the right size instead.
    pub context_window: Option<u32>,
    pub model: String,
}

pub fn shell_env(provider_id: &str, responses: bool) -> Option<ShellEnv> {
    let provider = config::provider_by_id(provider_id)?;
    if responses != (provider.api_format == ApiFormat::OpenaiResponses) {
        return None;
    }
    let model = config::strip_context_marker(&provider.models.default).to_string();
    if responses && model.is_empty() {
        return None;
    }
    if !RUNNING.load(Ordering::Acquire) && start().is_err() {
        return None;
    }
    let port = BOUND_PORT.load(Ordering::Acquire);
    Some(ShellEnv {
        base_url: format!("http://{BIND_ADDR}:{port}{PIN_PREFIX}{}", provider.id),
        token: config::token().ok()?,
        context_window: provider.context_window,
        model,
    })
}

/// Replace the provider list and selection. The frontend owns persistence, so
/// this is the whole of the Rust side's state.
#[tauri::command]
pub fn gateway_set_config(config: Config) -> Result<(), String> {
    if config.current.is_some() && config.current_provider().is_none() {
        return Err("选中的供应商不在列表中".to_string());
    }
    // Storing a configuration is not asking for a listener. The socket opens in
    // `shell_env`, when a shell that will actually use it is being spawned, so
    // launching the app routes nothing and binds nothing.
    config::replace(config);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    ok: bool,
    latency_ms: u64,
    http_status: Option<u16>,
    /// What the relay said it answered with, so a silent model substitution is
    /// visible.
    model: Option<String>,
    message: String,
}

/// Send one real, minimal request to a relay and report what happened.
///
/// A reachability probe would be cheaper, but it cannot tell a working
/// configuration from one with the wrong key, the wrong endpoint path or a
/// model the plan does not include, which is what the user is actually asking.
/// One token costs almost nothing and exercises the whole path, conversion
/// included.
#[tauri::command]
pub async fn gateway_test_provider(provider: Provider) -> TestResult {
    let (tx, rx) = tokio::sync::oneshot::channel();
    // A plain thread, not `spawn_blocking`: the upstream helpers call
    // `block_on`, which panics on a thread that already has a runtime context.
    thread::spawn(move || {
        let _ = tx.send(run_test(&provider));
    });
    rx.await.unwrap_or_else(|_| TestResult {
        ok: false,
        latency_ms: 0,
        http_status: None,
        model: None,
        message: "测试线程异常退出".to_string(),
    })
}

pub(crate) fn generate_text(
    provider: Provider,
    selected_model: String,
    prompt: String,
) -> Result<String, String> {
    // The outbound client drives its own runtime from this blocking thread.
    thread::spawn(move || {
        let model = provider
            .text_model(&selected_model)
            .ok_or("所选转发模型不在供应商的配置中")?;
        let converts = provider.api_format == ApiFormat::OpenaiChat;
        let outbound = text_request(&provider, model, &prompt, 256);
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| "无法生成转发请求标识")?;
        let session: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let response = upstream::send(
            &provider,
            &outbound,
            Some(&session),
            Some(Duration::from_secs(120)),
        )
        .map_err(|_| "连接转发供应商失败或请求超时")?;
        let status = response.status;
        let is_sse = response.is_sse;
        let payload = upstream::read_all(response.body).map_err(|_| "读取转发响应失败或超时")?;
        if !status.is_success() {
            let mut detail = upstream_error_message(&payload);
            let key = provider.api_key.trim();
            if !key.is_empty() {
                detail = detail.replace(key, "[已隐藏]");
            }
            return Err(format!(
                "转发请求失败（HTTP {}）：{}",
                status.as_u16(),
                detail.chars().take(300).collect::<String>()
            ));
        }
        let value = if converts && is_sse {
            collect_openai_sse(&payload)
        } else {
            serde_json::from_slice(&payload).map_err(|_| "转发供应商返回了无法解析的响应")?
        };
        let reply = if converts {
            convert::response_to_anthropic(&value).ok_or("无法读取转发模型的回答")?
        } else {
            value
        };
        let mut text = String::new();
        if provider.api_format == ApiFormat::OpenaiResponses {
            if let Some(output) = reply["output"].as_array() {
                for item in output {
                    append_text(&mut text, &item["content"], "output_text");
                }
            }
        } else {
            append_text(&mut text, &reply["content"], "text");
        }
        if text.is_empty() {
            return Err("转发模型未返回文本".into());
        }
        Ok(text)
    })
    .join()
    .map_err(|_| "转发生成任务异常退出")?
}

fn append_text(output: &mut String, content: &Value, kind: &str) {
    for part in content.as_array().into_iter().flatten() {
        if part["type"] == kind {
            if let Some(text) = part["text"].as_str() {
                output.push_str(text);
            }
        }
    }
}

fn text_request(provider: &Provider, model: &str, prompt: &str, max_tokens: u32) -> Value {
    if provider.api_format == ApiFormat::OpenaiResponses {
        return json!({
            "model": model,
            "max_output_tokens": max_tokens,
            "input": prompt,
            "store": false,
        });
    }
    let body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{ "role": "user", "content": prompt }],
    });
    if provider.api_format == ApiFormat::OpenaiChat {
        convert::request_to_openai(&body)
    } else {
        body
    }
}

const PROBE_MAX_TOKENS: u32 = 16;

/// The conversation a request belongs to, which some relays need in order to
/// keep it on one backend.
///
/// Claude Code buries it in `metadata.user_id`, shaped
/// `user_<id>_account_<id>_session_<uuid>`. When it is absent the fallback is a
/// value fixed for the life of the process: still stable enough to group a
/// run's requests, where a fresh one per request would defeat the affinity the
/// header exists for.
fn session_of(body: &Value) -> String {
    let from_body = body.get("metadata").and_then(|metadata| {
        metadata
            .get("user_id")
            .and_then(Value::as_str)
            .and_then(|user_id| user_id.split_once("_session_"))
            .map(|(_, session)| session)
            .or_else(|| metadata.get("session_id").and_then(Value::as_str))
            .filter(|session| !session.is_empty())
            .map(str::to_string)
    });
    from_body.unwrap_or_else(|| fallback_session().to_string())
}

fn fallback_session() -> &'static str {
    static SESSION: OnceLock<String> = OnceLock::new();
    SESSION.get_or_init(|| {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).expect("os random source");
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    })
}

fn run_test(provider: &Provider) -> TestResult {
    // Route through the sonnet slot, the one Claude Code uses most, so the test
    // exercises the mapping the user actually configured.
    let (model, tokens) = if provider.api_format == ApiFormat::OpenaiResponses {
        (
            config::strip_context_marker(&provider.models.default).to_string(),
            32,
        )
    } else {
        (
            provider.upstream_model("claude-sonnet-4-5"),
            PROBE_MAX_TOKENS,
        )
    };
    if model.is_empty() {
        return TestResult {
            ok: false,
            latency_ms: 0,
            http_status: None,
            model: None,
            message: "请填写 Codex 使用的模型 ID".into(),
        };
    }
    let outbound = text_request(provider, &model, "hi", tokens);

    let started = std::time::Instant::now();
    let response = match upstream::send(provider, &outbound, Some(fallback_session()), None) {
        Ok(response) => response,
        Err(message) => {
            return TestResult {
                ok: false,
                latency_ms: started.elapsed().as_millis() as u64,
                http_status: None,
                model: None,
                message: format!("连不上：{}", summarize_transport_error(&message)),
            };
        }
    };

    let status = response.status;
    let payload = upstream::read_all(response.body).unwrap_or_default();
    let latency_ms = started.elapsed().as_millis() as u64;
    if status.is_success() {
        let reply = serde_json::from_slice::<Value>(&payload).ok();
        if provider.api_format == ApiFormat::OpenaiResponses
            && !reply.as_ref().is_some_and(|body| body["output"].is_array())
        {
            return TestResult {
                ok: false,
                latency_ms,
                http_status: Some(status.as_u16()),
                model: Some(model),
                message: "该端点未返回 OpenAI Responses 格式".into(),
            };
        }
        let answered = reply.and_then(|value| {
            value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        return TestResult {
            ok: true,
            latency_ms,
            http_status: Some(status.as_u16()),
            message: format!("正常，{model} 已响应"),
            model: answered.or(Some(model)),
        };
    }

    let detail = upstream_error_message(&payload);
    let code = status.as_u16();
    let message = match code {
        401 | 403 => format!("鉴权失败，检查 API Key 或认证方式：{detail}"),
        404 => format!("端点不存在，检查 Base URL：{detail}"),
        429 => format!("被限流或额度用尽：{detail}"),
        // A relay reports an unknown model as a plain 400, so the body is the
        // only thing that separates it from a malformed request.
        400 if mentions_model(&detail) => format!("模型 {model} 不可用：{detail}"),
        _ => format!("HTTP {code}：{detail}"),
    };
    TestResult {
        ok: false,
        latency_ms,
        http_status: Some(code),
        model: Some(model),
        message,
    }
}

fn mentions_model(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    detail.contains("model") || detail.contains("模型")
}

/// reqwest chains its causes into one long line. Keep the part that says what
/// actually went wrong.
fn summarize_transport_error(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("dns") {
        "域名解析失败".to_string()
    } else if lower.contains("connect") || lower.contains("refused") {
        "无法建立连接".to_string()
    } else if lower.contains("timed out") || lower.contains("timeout") {
        "连接超时".to_string()
    } else if lower.contains("certificate") || lower.contains("tls") {
        "TLS 握手失败".to_string()
    } else {
        message.chars().take(200).collect()
    }
}

// ──────────────────────────────────────────────────────────────────────────
// HTTP
// ──────────────────────────────────────────────────────────────────────────

struct Request {
    method: String,
    path: String,
    credential: Option<String>,
    body: Vec<u8>,
}

fn handle_connection(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let request = match read_request(&mut stream) {
        Ok(Some(request)) => request,
        Ok(None) => return,
        Err(message) => {
            respond_error(&mut stream, 400, "invalid_request_error", &message);
            return;
        }
    };

    let route = (request.method == "POST")
        .then(|| route_of(&request.path))
        .flatten();
    let Some((provider_id, responses)) = route else {
        respond_error(
            &mut stream,
            404,
            "not_found_error",
            "本地网关提供 /v1/messages 和 /v1/responses",
        );
        return;
    };
    if !config::token().is_ok_and(|token| request.credential.as_deref() == Some(token.as_str())) {
        respond_error(&mut stream, 401, "authentication_error", "网关令牌无效");
        return;
    }
    // A pinned URL wins over the current selection, so switching provider in
    // one terminal cannot redirect a Claude Code already running in another.
    let provider = match provider_id {
        Some(id) => config::provider_by_id(id),
        None => config::current_provider(),
    };
    let Some(provider) = provider else {
        respond_error(
            &mut stream,
            503,
            "api_error",
            "供应商不可用，请在状态栏中重新选择",
        );
        return;
    };
    let body: Value = match serde_json::from_slice(&request.body) {
        Ok(body) => body,
        Err(e) => {
            respond_error(&mut stream, 400, "invalid_request_error", &format!("{e}"));
            return;
        }
    };
    if !body.is_object() {
        respond_error(
            &mut stream,
            400,
            "invalid_request_error",
            "请求体必须是 JSON 对象",
        );
        return;
    }

    if responses != (provider.api_format == ApiFormat::OpenaiResponses) {
        respond_error(
            &mut stream,
            400,
            "invalid_request_error",
            "供应商接口格式与客户端不匹配",
        );
        return;
    }
    if responses {
        forward_responses(&mut stream, &provider, body);
    } else {
        forward(&mut stream, &provider, body);
    }
}

/// Recognize the messages endpoint and pull out the provider a shell was
/// pinned to.
///
/// `Some(Some(id))` is a pinned request, `Some(None)` one that leaves the
/// choice to the current selection, `None` is not our endpoint. The id rides in
/// the path because that is the only part of the request Claude Code lets us
/// preset: it appends `/v1/messages` to whatever ANTHROPIC_BASE_URL holds.
fn route_of(path: &str) -> Option<(Option<&str>, bool)> {
    let path = path.split('?').next().unwrap_or(path);
    let (provider, rest) = match path.strip_prefix(PIN_PREFIX) {
        Some(tail) => {
            let (id, rest) = tail.split_once('/')?;
            if id.is_empty() {
                return None;
            }
            (Some(id), rest)
        }
        None => (None, path.trim_start_matches('/')),
    };
    // Claude Code produces the doubled form when the base URL already ends in
    // `/v1`, which users paste often enough to be worth accepting.
    match rest {
        "v1/messages" | "messages" | "v1/v1/messages" => Some((provider, false)),
        "v1/responses" | "responses" if provider.is_some() => Some((provider, true)),
        _ => None,
    }
}

const PIN_PREFIX: &str = "/p/";

fn read_request(stream: &mut TcpStream) -> Result<Option<Request>, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut head = Vec::with_capacity(4096);
    let mut buf = [0u8; 4096];
    let mut head_end = None;
    while head_end.is_none() {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("读取请求超时".into());
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|e| e.to_string())?;
        match stream.read(&mut buf) {
            Ok(0) => return Ok(None),
            Ok(n) => {
                head.extend_from_slice(&buf[..n]);
                if let Some(pos) = head.windows(4).position(|w| w == b"\r\n\r\n") {
                    head_end = Some(pos + 4);
                } else if head.len() > MAX_HEAD_BYTES {
                    return Err("请求头过大".to_string());
                }
            }
            Err(_) => return Ok(None),
        }
    }
    let head_end = head_end.expect("loop exits only once set");
    if head_end > MAX_HEAD_BYTES {
        return Err("请求头过大".into());
    }
    let text = std::str::from_utf8(&head[..head_end]).map_err(|_| "无效请求头编码")?;
    let mut lines = text.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_ascii_uppercase();
    let path = parts.next().unwrap_or("/").to_string();
    if !matches!(parts.next(), Some("HTTP/1.0" | "HTTP/1.1")) || parts.next().is_some() {
        return Err("无效 HTTP 请求行".into());
    }

    let mut content_length = None;
    let mut credential = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => {
                if content_length.is_some() || !value.bytes().all(|b| b.is_ascii_digit()) {
                    return Err("无效 Content-Length".into());
                }
                content_length = Some(value.parse::<usize>().map_err(|_| "无效 Content-Length")?);
            }
            "transfer-encoding" => return Err("不支持 Transfer-Encoding".into()),
            // Claude Code sends x-api-key; a user who set ANTHROPIC_AUTH_TOKEN
            // instead gets a Bearer header. Accept either.
            "x-api-key" => credential = Some(value.to_string()),
            "authorization" => {
                let token = value
                    .strip_prefix("Bearer ")
                    .or_else(|| value.strip_prefix("bearer "))
                    .unwrap_or(value);
                credential.get_or_insert_with(|| token.trim().to_string());
            }
            _ => {}
        }
    }
    let content_length = content_length.unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        return Err("请求体过大".to_string());
    }

    if !config::token().is_ok_and(|token| credential.as_deref() == Some(token.as_str())) {
        return Ok(Some(Request {
            method,
            path,
            credential,
            body: Vec::new(),
        }));
    }
    let mut body = head[head_end..head.len().min(head_end + content_length)].to_vec();
    body.reserve(content_length.saturating_sub(body.len()));
    while body.len() < content_length {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("读取请求超时".into());
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|e| e.to_string())?;
        let count = buf.len().min(content_length - body.len());
        match stream.read(&mut buf[..count]) {
            Ok(0) => return Err("请求体不完整".into()),
            Ok(n) => body.extend_from_slice(&buf[..n]),
            Err(e) => return Err(format!("读取请求体失败：{e}")),
        }
    }

    Ok(Some(Request {
        method,
        path,
        credential,
        body,
    }))
}

fn forward_responses(stream: &mut TcpStream, provider: &Provider, body: Value) {
    let response = match upstream::send(provider, &body, Some(fallback_session()), None) {
        Ok(response) => response,
        Err(error) => {
            respond_error(stream, 502, "api_error", &format!("上游请求失败：{error}"));
            return;
        }
    };
    let status = response.status;
    if !status.is_success() {
        let payload = upstream::read_all(response.body).unwrap_or_default();
        let mut detail = upstream_error_message(&payload);
        let key = provider.api_key.trim();
        if !key.is_empty() {
            detail = detail.replace(key, "[已隐藏]");
        }
        respond_error(stream, status.as_u16(), "api_error", &detail);
    } else if response.is_sse {
        stream_response(stream, response, false);
    } else {
        buffered_response(stream, response, false, status.as_u16());
    }
}

fn forward(stream: &mut TcpStream, provider: &Provider, mut body: Value) {
    let requested = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let outbound_model = provider.upstream_model(&requested);
    let wants_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    // One line per request: without it there is no way to tell a shell that is
    // routed from one that only looks routed, and asking the model what it is
    // does not answer that (the client's own prompt tells it what to say).
    log::info!(
        "gateway: {} {requested} -> {outbound_model}{}",
        provider.name,
        if wants_stream { " (stream)" } else { "" }
    );
    body["model"] = json!(outbound_model);

    // Read before converting: the OpenAI body has no `metadata` to carry it.
    let session = session_of(&body);

    let converts = provider.api_format == ApiFormat::OpenaiChat;
    let outbound = if converts {
        convert::request_to_openai(&body)
    } else {
        body
    };

    let response = match upstream::send(provider, &outbound, Some(&session), None) {
        Ok(response) => response,
        Err(message) => {
            respond_error(
                stream,
                502,
                "api_error",
                &format!("上游请求失败：{message}"),
            );
            return;
        }
    };

    let status = response.status.as_u16();
    if !response.status.is_success() {
        let payload = upstream::read_all(response.body).unwrap_or_default();
        let message = upstream_error_message(&payload);
        respond_error(stream, status, "api_error", &message);
        return;
    }

    if wants_stream {
        stream_response(stream, response, converts);
    } else {
        buffered_response(stream, response, converts, status);
    }
}

fn stream_response(stream: &mut TcpStream, response: upstream::Response, converts: bool) {
    // No Content-Length: the body ends when the connection does, which is what
    // lets bytes go out as they arrive.
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\n\
                Cache-Control: no-cache\r\nConnection: close\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let _ = stream.flush();

    if !converts {
        let _ = upstream::for_each_chunk(response.body, |chunk| {
            stream.write_all(chunk).map_err(|e| format!("{e}"))?;
            stream.flush().map_err(|e| format!("{e}"))
        });
        return;
    }

    let mut converter = stream::Converter::new();
    let result = upstream::for_each_chunk(response.body, |chunk| {
        let out = converter.push(chunk)?;
        if out.is_empty() {
            return Ok(());
        }
        stream.write_all(&out).map_err(|e| format!("{e}"))?;
        stream.flush().map_err(|e| format!("{e}"))
    });
    let tail = match result {
        Ok(()) => converter.finish(),
        Err(message) => {
            log::warn!("gateway: upstream stream ended early: {message}");
            converter.error(&message)
        }
    };
    if !tail.is_empty() {
        let _ = stream.write_all(&tail);
        let _ = stream.flush();
    }
}

fn buffered_response(
    stream: &mut TcpStream,
    response: upstream::Response,
    converts: bool,
    status: u16,
) {
    let is_sse = response.is_sse;
    let payload = match upstream::read_all(response.body) {
        Ok(payload) => payload,
        Err(message) => {
            respond_error(
                stream,
                502,
                "api_error",
                &format!("读取上游响应失败：{message}"),
            );
            return;
        }
    };
    if !converts {
        respond(stream, status, "application/json", &payload);
        return;
    }

    // A relay may answer a non-streaming request with SSE anyway. Collapsing the
    // chunks is better than handing the client a body it cannot parse.
    let source = if is_sse {
        collect_openai_sse(&payload)
    } else {
        serde_json::from_slice::<Value>(&payload).unwrap_or(Value::Null)
    };
    match convert::response_to_anthropic(&source) {
        Some(converted) => respond(
            stream,
            status,
            "application/json",
            converted.to_string().as_bytes(),
        ),
        None => respond_error(
            stream,
            502,
            "api_error",
            &format!("无法解析上游响应：{}", preview(&payload)),
        ),
    }
}

/// Fold an OpenAI SSE transcript back into the single response object the
/// non-streaming converter expects.
fn collect_openai_sse(payload: &[u8]) -> Value {
    let text = String::from_utf8_lossy(payload);
    let mut id = String::new();
    let mut model = String::new();
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut finish_reason: Option<String> = None;
    let mut usage = Value::Null;
    let mut tools: Vec<(String, String, String)> = Vec::new();

    for line in text.lines() {
        let Some(data) = sse::strip_field(line, "data") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            continue;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if id.is_empty() {
            id = chunk["id"].as_str().unwrap_or_default().to_string();
        }
        if model.is_empty() {
            model = chunk["model"].as_str().unwrap_or_default().to_string();
        }
        if chunk["usage"].is_object() {
            usage = chunk["usage"].clone();
        }
        let Some(choice) = chunk["choices"].as_array().and_then(|c| c.first()) else {
            continue;
        };
        if let Some(reason) = choice["finish_reason"].as_str() {
            finish_reason = Some(reason.to_string());
        }
        let delta = &choice["delta"];
        if let Some(text) = delta["content"].as_str() {
            content.push_str(text);
        }
        for key in ["reasoning", "reasoning_content"] {
            if let Some(text) = delta[key].as_str() {
                reasoning.push_str(text);
            }
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let index = call["index"].as_u64().unwrap_or(0);
                if index >= 128 {
                    return Value::Null;
                }
                let index = index as usize;
                while tools.len() <= index {
                    tools.push((String::new(), String::new(), String::new()));
                }
                let entry = &mut tools[index];
                if let Some(value) = call["id"].as_str() {
                    entry.0 = value.to_string();
                }
                if let Some(value) = call["function"]["name"].as_str() {
                    entry.1 = value.to_string();
                }
                if let Some(value) = call["function"]["arguments"].as_str() {
                    entry.2.push_str(value);
                }
            }
        }
    }

    let mut message = json!({ "role": "assistant", "content": content });
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    if !tools.is_empty() {
        message["tool_calls"] = Value::Array(
            tools
                .into_iter()
                .map(|(id, name, arguments)| {
                    json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": arguments }
                    })
                })
                .collect(),
        );
    }
    json!({
        "id": id,
        "model": model,
        "choices": [{ "finish_reason": finish_reason, "message": message }],
        "usage": usage,
    })
}

/// Pull a human message out of whatever error envelope the relay used, so the
/// user sees the reason rather than a status code.
fn upstream_error_message(payload: &[u8]) -> String {
    let Ok(value) = serde_json::from_slice::<Value>(payload) else {
        return preview(payload);
    };
    for pointer in ["/error/message", "/message", "/error"] {
        if let Some(text) = value.pointer(pointer).and_then(Value::as_str) {
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    preview(payload)
}

fn preview(payload: &[u8]) -> String {
    let text = String::from_utf8_lossy(payload);
    let text = text.trim();
    if text.is_empty() {
        return "上游返回了空响应".to_string();
    }
    text.chars().take(300).collect()
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Connection: close\r\n\r\n",
        reason_phrase(status),
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn respond_error(stream: &mut TcpStream, status: u16, kind: &str, message: &str) {
    let body = json!({
        "type": "error",
        "error": { "type": kind, "message": message }
    });
    respond(
        stream,
        status,
        "application/json",
        body.to_string().as_bytes(),
    );
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Error",
    }
}
