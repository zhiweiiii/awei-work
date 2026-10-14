use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

use crate::modules::workspace::{self, WorkspaceEnv};

#[cfg(windows)]
const BASHRC_SCRIPT: &str = include_str!("scripts/bashrc.bash");
#[cfg(windows)]
const ZSHENV_SCRIPT: &str = include_str!("scripts/zshenv.zsh");
#[cfg(windows)]
const ZPROFILE_SCRIPT: &str = include_str!("scripts/zprofile.zsh");
#[cfg(windows)]
const ZLOGIN_SCRIPT: &str = include_str!("scripts/zlogin.zsh");
#[cfg(windows)]
const ZSHRC_SCRIPT: &str = include_str!("scripts/zshrc.zsh");
#[cfg(windows)]
const FISH_INIT_SCRIPT: &str = include_str!("scripts/init.fish");
const FISH_REINSTALL_PROMPT: &str =
    "functions -q __terax_install_prompt; and __terax_install_prompt";

#[cfg(windows)]
fn bashrc_script() -> &'static str {
    BASHRC_SCRIPT
}

#[cfg(windows)]
fn zshenv_script() -> &'static str {
    ZSHENV_SCRIPT
}

#[cfg(windows)]
fn zprofile_script() -> &'static str {
    ZPROFILE_SCRIPT
}

#[cfg(windows)]
fn zlogin_script() -> &'static str {
    ZLOGIN_SCRIPT
}

#[cfg(windows)]
fn zshrc_script() -> &'static str {
    ZSHRC_SCRIPT
}

#[cfg(windows)]
fn fish_init_script() -> &'static str {
    FISH_INIT_SCRIPT
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellQuoteKind {
    Powershell,
    Posix,
    Fish,
    Cmd,
    Unknown,
}

pub fn build_command(
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    blocks: bool,
    shell: Option<String>,
    gateway_provider: Option<String>,
) -> Result<(CommandBuilder, ShellQuoteKind), String> {
    let shell = sanitize_shell_override(shell);
    #[cfg(windows)]
    {
        windows::build(cwd, workspace, blocks, shell, gateway_provider)
    }
}

// Honor the override only if it matches an enumerated shell, so a tampered
// setting can't spawn an arbitrary binary across the IPC boundary.
fn sanitize_shell_override(shell: Option<String>) -> Option<String> {
    let candidate = shell
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let target = std::fs::canonicalize(&candidate).ok();
    let allowed = list_shells().into_iter().any(|s| {
        s.path == candidate || (target.is_some() && std::fs::canonicalize(&s.path).ok() == target)
    });
    if allowed {
        Some(candidate)
    } else {
        log::warn!("ignoring non-enumerated shell override '{candidate}'");
        None
    }
}

pub fn detect_shell_name() -> String {
    #[cfg(windows)]
    {
        windows_shell_path()
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default()
    }
}

#[derive(serde::Serialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    /// True when awei-work injects OSC 7/133 integration for this shell (cwd
    /// tracking, command blocks, agent detection). Others spawn bare.
    pub integrated: bool,
}

pub fn list_shells() -> Vec<ShellInfo> {
    #[cfg(windows)]
    {
        windows::list_shells()
    }
}

fn ensure_utf8_locale(cmd: &mut CommandBuilder) {
    let is_utf8 = |v: &str| {
        let up = v.to_ascii_uppercase();
        up.contains("UTF-8") || up.contains("UTF8")
    };
    let already_utf8 = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .any(|k| std::env::var(k).ok().as_deref().is_some_and(is_utf8));
    if already_utf8 {
        return;
    }
    #[cfg(windows)]
    let fallback = "en_US.UTF-8";
    cmd.env("LANG", fallback);
}

/// Point this shell's Claude Code at the local gateway, or make sure nothing
/// inherited still points it somewhere else.
///
/// The two removals matter as much as the assignments. ANTHROPIC_MODEL would
/// pin every role to one model and defeat the gateway's per-role routing, and
/// ANTHROPIC_API_KEY is sent as `x-api-key`, which the gateway reads in
/// preference to the Bearer header, so one left in the user's profile would
/// outrank the token set here and turn every request into a 401.
fn apply_gateway(cmd: &mut CommandBuilder, provider_id: Option<&str>) {
    let Some(provider_id) = provider_id else {
        return;
    };
    let Some((base_url, token)) = crate::modules::gateway::shell_env(provider_id) else {
        log::warn!("pty gateway: provider {provider_id} unavailable, shell left unrouted");
        return;
    };
    log::info!("pty gateway: routing this shell through {base_url}");
    cmd.env("ANTHROPIC_BASE_URL", base_url);
    cmd.env("ANTHROPIC_AUTH_TOKEN", token);
    cmd.env_remove("ANTHROPIC_MODEL");
    cmd.env_remove("ANTHROPIC_API_KEY");
}

fn apply_common(
    cmd: &mut CommandBuilder,
    cwd: Option<String>,
    blocks: bool,
    gateway_provider: Option<&str>,
) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERAX_TERMINAL", "1");
    apply_gateway(cmd, gateway_provider);
    if blocks {
        cmd.env("TERAX_BLOCKS", "1");
    }
    ensure_utf8_locale(cmd);

    let resolved_cwd = cwd
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| workspace::launch_cwd_snapshot().filter(|p| p.is_dir()))
        .or_else(|| dirs::home_dir().filter(|p| p.is_dir()));
    if let Some(cwd) = resolved_cwd {
        #[cfg(windows)]
        let cwd = PathBuf::from(cwd.to_string_lossy().replace('/', "\\"));
        log::info!("pty cwd: {}", cwd.display());
        cmd.cwd(cwd);
    } else {
        log::warn!("pty cwd: no usable directory, inheriting from process");
    }
}

#[cfg(windows)]
mod windows {
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    use crate::modules::workspace::WorkspaceEnv;
    use portable_pty::CommandBuilder;

    const PROFILE_PS1: &str = include_str!("scripts/profile.ps1");

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum ShellKind {
        Zsh,
        Bash,
        Fish,
        Other,
    }

    impl ShellKind {
        fn from_path(path: &str) -> Self {
            match path.rsplit('/').next().unwrap_or("") {
                "zsh" => Self::Zsh,
                "bash" => Self::Bash,
                "fish" => Self::Fish,
                _ => Self::Other,
            }
        }
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum WslShellIntegration {
        Zsh {
            zdotdir: String,
            user_zdotdir: Option<String>,
        },
        Bash {
            rcfile: String,
        },
        Fish,
        None,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct WslLaunchSpec {
        args: Vec<String>,
    }

    pub fn build(
        cwd: Option<String>,
        workspace: WorkspaceEnv,
        blocks: bool,
        shell: Option<String>,
        gateway_provider: Option<String>,
    ) -> Result<(CommandBuilder, super::ShellQuoteKind), String> {
        if let WorkspaceEnv::Wsl { distro } = workspace {
            // A WSL shell cannot reach a Windows loopback listener by
            // 127.0.0.1, so routing it through the gateway would hand it a URL
            // that never connects.
            let _ = (blocks, shell, gateway_provider);
            return build_wsl(cwd, distro);
        }
        let shell_path = shell
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .filter(|p| super::is_real_executable(p))
            .unwrap_or_else(super::windows_shell_path);
        let shell_name = shell_path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        let is_powershell = shell_name == "pwsh.exe" || shell_name == "powershell.exe";
        let is_bash = shell_name == "bash.exe";

        let mut cmd = CommandBuilder::new(&shell_path);
        super::apply_common(&mut cmd, cwd, blocks, gateway_provider.as_deref());

        if is_powershell {
            match prepare_ps_profile() {
                Ok(profile) => {
                    cmd.arg("-NoLogo");
                    cmd.arg("-NoExit");
                    cmd.arg("-ExecutionPolicy");
                    cmd.arg("Bypass");
                    cmd.arg("-File");
                    cmd.arg(profile);
                }
                Err(e) => {
                    log::warn!("powershell shell integration disabled: {e}");
                }
            }
        } else if is_bash {
            // git-bash's /etc/profile cd's to $HOME unless CHERE_INVOKING is
            // set; keep the cwd we configured in apply_common.
            cmd.env("CHERE_INVOKING", "1");
            // Native git-bash: same OSC 7/133 rcfile as Unix bash, in the
            // forward-slash form MSYS bash accepts.
            match prepare_bash_rcfile() {
                Ok(rc) => {
                    cmd.arg("--rcfile");
                    cmd.arg(rc.to_string_lossy().replace('\\', "/"));
                    cmd.arg("-i");
                }
                Err(e) => {
                    log::warn!("bash shell integration disabled: {e}");
                }
            }
        } else {
            log::info!("spawning {} without shell integration", shell_name);
        }

        log::info!("spawning Windows shell: {}", shell_path.display());
        let quote_kind = if is_powershell {
            super::ShellQuoteKind::Powershell
        } else if is_bash {
            super::ShellQuoteKind::Posix
        } else if shell_name == "cmd.exe" {
            super::ShellQuoteKind::Cmd
        } else {
            super::ShellQuoteKind::Unknown
        };
        Ok((cmd, quote_kind))
    }

    fn build_wsl(
        cwd: Option<String>,
        distro: String,
    ) -> Result<(CommandBuilder, super::ShellQuoteKind), String> {
        crate::modules::workspace::validate_wsl_distro_name(&distro)?;
        let shell_path = crate::modules::workspace::wsl_login_shell(distro.clone())?;
        let shell_kind = ShellKind::from_path(&shell_path);
        let integration = match shell_kind {
            ShellKind::Zsh => match prepare_wsl_zdotdir(&distro) {
                Ok(zdotdir) => {
                    let user_zdotdir = match probe_wsl_zdotdir(&distro, &shell_path) {
                        Ok(path) if !path.is_empty() && path != zdotdir => Some(path),
                        Ok(_) => None,
                        Err(e) => {
                            log::warn!("WSL zsh ZDOTDIR probe failed for {distro}: {e}");
                            None
                        }
                    };
                    WslShellIntegration::Zsh {
                        zdotdir,
                        user_zdotdir,
                    }
                }
                Err(e) => {
                    log::warn!("WSL zsh shell integration disabled for {distro}: {e}");
                    WslShellIntegration::None
                }
            },
            ShellKind::Bash => match prepare_wsl_bash_rcfile(&distro) {
                Ok(rcfile) => WslShellIntegration::Bash { rcfile },
                Err(e) => {
                    log::warn!("WSL bash shell integration disabled for {distro}: {e}");
                    WslShellIntegration::None
                }
            },
            ShellKind::Fish => match prepare_wsl_fish_conf_d(&distro) {
                Ok(()) => WslShellIntegration::Fish,
                Err(e) => {
                    log::warn!("WSL fish shell integration disabled for {distro}: {e}");
                    WslShellIntegration::None
                }
            },
            ShellKind::Other => {
                log::info!(
                    "unsupported WSL shell '{}', spawning without integration",
                    shell_path
                );
                WslShellIntegration::None
            }
        };
        let spec = build_wsl_launch_spec(
            cwd.as_deref(),
            &distro,
            &shell_path,
            shell_kind,
            integration,
        );
        let mut cmd = CommandBuilder::new("wsl.exe");
        for arg in &spec.args {
            cmd.arg(arg);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERAX_TERMINAL", "1");
        super::ensure_utf8_locale(&mut cmd);
        log::info!("spawning WSL shell: {distro} ({shell_path})");
        let quote_kind = match shell_kind {
            ShellKind::Zsh | ShellKind::Bash => super::ShellQuoteKind::Posix,
            ShellKind::Fish => super::ShellQuoteKind::Fish,
            ShellKind::Other => match shell_path.rsplit('/').next().unwrap_or("") {
                "sh" | "dash" | "ksh" | "ash" => super::ShellQuoteKind::Posix,
                _ => super::ShellQuoteKind::Unknown,
            },
        };
        Ok((cmd, quote_kind))
    }

    fn build_wsl_launch_spec(
        cwd: Option<&str>,
        distro: &str,
        shell_path: &str,
        shell_kind: ShellKind,
        integration: WslShellIntegration,
    ) -> WslLaunchSpec {
        let mut args = vec![
            "-d".to_string(),
            distro.to_string(),
            "--cd".to_string(),
            cwd.filter(|s| !s.is_empty()).unwrap_or("~").to_string(),
            "--exec".to_string(),
        ];
        match (shell_kind, integration) {
            (
                ShellKind::Zsh,
                WslShellIntegration::Zsh {
                    zdotdir,
                    user_zdotdir,
                },
            ) => {
                args.push("env".to_string());
                if let Some(user_zdotdir) = user_zdotdir {
                    args.push(format!("TERAX_USER_ZDOTDIR={user_zdotdir}"));
                }
                args.push(format!("ZDOTDIR={zdotdir}"));
                args.push(shell_path.to_string());
                args.push("-l".to_string());
            }
            (ShellKind::Bash, WslShellIntegration::Bash { rcfile }) => {
                args.push(shell_path.to_string());
                args.push("--rcfile".to_string());
                args.push(rcfile);
                args.push("-i".to_string());
            }
            (ShellKind::Fish, WslShellIntegration::Fish) => {
                args.push("env".to_string());
                args.push("fish_features=no-mark-prompt".to_string());
                args.push(shell_path.to_string());
                args.push("-i".to_string());
                args.push("-C".to_string());
                args.push(super::FISH_REINSTALL_PROMPT.to_string());
            }
            (ShellKind::Zsh, WslShellIntegration::None) => {
                args.push(shell_path.to_string());
                args.push("-l".to_string());
            }
            (ShellKind::Bash, WslShellIntegration::None)
            | (ShellKind::Fish, WslShellIntegration::None) => {
                args.push(shell_path.to_string());
                args.push("-i".to_string());
            }
            (ShellKind::Other, _) => args.push(shell_path.to_string()),
            _ => {
                args.push(shell_path.to_string());
            }
        }
        WslLaunchSpec { args }
    }

    fn probe_wsl_zdotdir(distro: &str, shell_path: &str) -> Result<String, String> {
        let out = crate::modules::workspace::wsl_exec_capture(
            distro,
            shell_path,
            &["-c", r#"printf %s "${ZDOTDIR:-$HOME}""#],
        )?;
        Ok(crate::modules::workspace::normalize_wsl_value(out, ""))
    }

    fn prepare_wsl_integration_dir(distro: &str, shell: &str) -> Result<(String, PathBuf), String> {
        let home = crate::modules::workspace::wsl_home_blocking(distro)?;
        let linux_dir = format!(
            "{}/.cache/terax/shell-integration/{shell}",
            home.trim_end_matches('/')
        );
        let unc_dir = crate::modules::workspace::wsl_path_to_unc(distro, &linux_dir);
        fs::create_dir_all(&unc_dir).map_err(|e| format!("create {}: {e}", unc_dir.display()))?;
        Ok((linux_dir, unc_dir))
    }

    fn normalize_script(content: &str) -> String {
        content.replace("\r\n", "\n")
    }

    fn prepare_wsl_zdotdir(distro: &str) -> Result<String, String> {
        let (linux_dir, unc_dir) = prepare_wsl_integration_dir(distro, "zsh")?;
        write_if_changed(
            &unc_dir.join(".zshenv"),
            &normalize_script(super::zshenv_script()),
        )?;
        write_if_changed(
            &unc_dir.join(".zprofile"),
            &normalize_script(super::zprofile_script()),
        )?;
        write_if_changed(
            &unc_dir.join(".zshrc"),
            &normalize_script(super::zshrc_script()),
        )?;
        write_if_changed(
            &unc_dir.join(".zlogin"),
            &normalize_script(super::zlogin_script()),
        )?;
        Ok(linux_dir)
    }

    fn prepare_wsl_bash_rcfile(distro: &str) -> Result<String, String> {
        let (linux_dir, _unc_dir) = prepare_wsl_integration_dir(distro, "bash")?;
        let linux_rc = format!("{linux_dir}/bashrc");
        let unc_file = crate::modules::workspace::wsl_path_to_unc(distro, &linux_rc);
        let content = normalize_script(super::bashrc_script());
        write_if_changed(&unc_file, &content)?;
        Ok(linux_rc)
    }

    fn prepare_wsl_fish_conf_d(distro: &str) -> Result<(), String> {
        let home = crate::modules::workspace::wsl_home_blocking(distro)?;
        let linux_dir = format!("{}/.config/fish/conf.d", home.trim_end_matches('/'));
        let unc_dir = crate::modules::workspace::wsl_path_to_unc(distro, &linux_dir);
        fs::create_dir_all(&unc_dir).map_err(|e| format!("create {}: {e}", unc_dir.display()))?;
        let unc_file = unc_dir.join("terax.fish");
        let content = normalize_script(super::fish_init_script());
        write_if_changed(&unc_file, &content)?;
        Ok(())
    }

    fn integration_root() -> Result<PathBuf, String> {
        let home = dirs::home_dir().ok_or_else(|| "could not resolve home dir".to_string())?;
        let root = home.join(".cache").join("terax").join("shell-integration");
        fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
        Ok(root)
    }

    fn prepare_ps_profile() -> Result<PathBuf, String> {
        let dir = integration_root()?.join("powershell");
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let file = dir.join("profile.ps1");
        write_if_changed(&file, PROFILE_PS1)?;
        Ok(file)
    }

    fn prepare_bash_rcfile() -> Result<PathBuf, String> {
        let dir = integration_root()?.join("bash");
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let rc = dir.join("bashrc");
        write_if_changed(&rc, &normalize_script(super::bashrc_script()))?;
        Ok(rc)
    }

    pub fn list_shells() -> Vec<super::ShellInfo> {
        fn add(out: &mut Vec<super::ShellInfo>, name: &str, path: PathBuf, integrated: bool) {
            // Offering an app-execution alias here would let the user pick a
            // shell that opens and then takes no input.
            if super::is_real_executable(&path) {
                out.push(super::ShellInfo {
                    name: name.to_string(),
                    path: path.to_string_lossy().into_owned(),
                    integrated,
                });
            }
        }

        let mut out = Vec::new();
        if let Some(p) = super::which_in_path("pwsh.exe") {
            add(&mut out, "PowerShell", p, true);
        } else if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
            add(
                &mut out,
                "PowerShell",
                pf.join("PowerShell").join("7").join("pwsh.exe"),
                true,
            );
        }
        let system32 = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("System32");
        add(
            &mut out,
            "Windows PowerShell",
            system32
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
            true,
        );
        add(&mut out, "Command Prompt", system32.join("cmd.exe"), false);
        if let Some(p) = git_bash_path() {
            add(&mut out, "Git Bash", p, true);
        }
        out
    }

    fn git_bash_path() -> Option<PathBuf> {
        // Git for Windows install locations only. A bash.exe on PATH is usually
        // the WSL launcher in System32, which is the separate WSL switcher.
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
            if let Some(base) = std::env::var_os(var).map(PathBuf::from) {
                for rel in [
                    r"Git\bin\bash.exe",
                    r"Git\usr\bin\bash.exe",
                    r"Programs\Git\bin\bash.exe",
                ] {
                    let candidate = base.join(rel);
                    if super::is_real_executable(&candidate) {
                        return Some(candidate);
                    }
                }
            }
        }
        None
    }

    fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
        if let Ok(existing) = fs::read_to_string(path) {
            if existing == content {
                return Ok(());
            }
        }
        let parent = path
            .parent()
            .ok_or_else(|| "missing script directory".to_string())?;
        let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        tmp.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        tmp.as_file().sync_all().map_err(|e| e.to_string())?;
        tmp.persist(path)
            .map_err(|e| format!("replace {}: {}", path.display(), e.error))?;
        Ok(())
    }
}

#[cfg(windows)]
pub fn windows_shell_path() -> PathBuf {
    if let Some(p) = which_in_path("pwsh.exe") {
        return p;
    }

    if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
        let candidate = pf.join("PowerShell").join("7").join("pwsh.exe");
        if is_real_executable(&candidate) {
            return candidate;
        }
    }

    let system32 = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32");
    let ps5 = system32
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if is_real_executable(&ps5) {
        return ps5;
    }

    system32.join("cmd.exe")
}

#[cfg(windows)]
fn which_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if is_real_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Whether a PATH hit is something we can actually spawn.
///
/// A Microsoft Store "app execution alias" is a **zero-length reparse point**
/// that Explorer resolves on your behalf. ConPTY spawns through
/// `CreateProcessW`, which does not: the child comes up broken, so a terminal
/// opens and then accepts no input at all.
///
/// These aliases live in `%LOCALAPPDATA%\Microsoft\WindowsApps`, which sits
/// AHEAD of `C:\Program Files\PowerShell` in the PATH a process inherits
/// from Explorer. That is why this only ever bit the packaged build: launched
/// from a dev shell, the real pwsh comes first and the alias is never reached.
///
/// Length is the honest test. A real executable is never zero bytes, and
/// checking the size covers any other alias rather than just the ones that
/// happen to live in that folder.
fn is_real_executable(path: &Path) -> bool {
    path.metadata()
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}
