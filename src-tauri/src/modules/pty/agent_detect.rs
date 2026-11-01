const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const OSC_INTRO: u8 = b']';
const ST_FINAL: u8 = b'\\';

const OSC_MAX: usize = 2048;

const DEFAULT_AGENTS: &[&str] = &["claude", "codex", "gemini", "pi", "opencode", "grok"];

// OSC 777 marker our agent hooks emit. Legacy 3-field `notify;Terax;<event>`
// (Claude) or 4-field `notify;Terax;<agent>;<event>` (Codex/Gemini/Pi).
const TERAX_MARKER: &[u8] = b"notify;Terax;";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Ground,
    Esc,
    Osc,
    OscEsc,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Status {
    Idle,
    Working,
    Waiting,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Transition {
    Started {
        agent: String,
        session_id: Option<String>,
        started_at_ms: Option<u64>,
    },
    Working,
    Attention,
    Finished,
    Exited,
}

#[derive(Clone, serde::Serialize)]
pub struct AgentSignal {
    pub id: u32,
    pub kind: &'static str,
    pub agent: Option<String>,
}

impl Transition {
    pub fn into_signal(self, id: u32) -> AgentSignal {
        match self {
            Transition::Started { agent, .. } => AgentSignal {
                id,
                kind: "started",
                agent: Some(agent),
            },
            Transition::Working => AgentSignal {
                id,
                kind: "working",
                agent: None,
            },
            Transition::Attention => AgentSignal {
                id,
                kind: "attention",
                agent: None,
            },
            Transition::Finished => AgentSignal {
                id,
                kind: "finished",
                agent: None,
            },
            Transition::Exited => AgentSignal {
                id,
                kind: "exited",
                agent: None,
            },
        }
    }
}

pub struct AgentDetector {
    agents: Vec<String>,
    state: State,
    osc: Vec<u8>,
    armed: bool,
    status: Status,
}

impl AgentDetector {
    pub fn new() -> Self {
        Self::with_agents(DEFAULT_AGENTS.iter().map(|s| s.to_string()).collect())
    }

    pub fn with_agents(agents: Vec<String>) -> Self {
        Self {
            agents,
            state: State::Ground,
            osc: Vec::new(),
            armed: false,
            status: Status::Idle,
        }
    }

    /// Feed a chunk of raw PTY output. Transitions come only from OSC sequences
    /// (`133` prompt boundaries, our `777` hook marker), never from raw output,
    /// so a TUI agent that repaints continuously never flaps working/waiting.
    pub fn process<F: FnMut(Transition)>(&mut self, input: &[u8], mut emit: F) {
        if self.state == State::Ground && !input.contains(&ESC) {
            return;
        }

        for &b in input {
            match self.state {
                State::Ground => {
                    if b == ESC {
                        self.state = State::Esc;
                    }
                }
                State::Esc => match b {
                    OSC_INTRO => {
                        self.state = State::Osc;
                        self.osc.clear();
                    }
                    ESC => {}
                    _ => self.state = State::Ground,
                },
                State::Osc => match b {
                    BEL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => self.state = State::OscEsc,
                    _ => {
                        if self.osc.len() < OSC_MAX {
                            self.osc.push(b);
                        } else {
                            self.osc.clear();
                            self.state = State::Ground;
                        }
                    }
                },
                State::OscEsc => match b {
                    ST_FINAL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => {}
                    _ => {
                        self.osc.clear();
                        self.state = State::Ground;
                    }
                },
            }
        }
    }

    /// Called when the underlying PTY closes. Reports the agent as exited so the
    /// UI doesn't leave a stale entry if the shell died mid-command.
    pub fn finish<F: FnMut(Transition)>(&mut self, mut emit: F) {
        if self.armed {
            self.disarm();
            emit(Transition::Exited);
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
        self.status = Status::Idle;
    }

    fn finish_osc<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        let body = std::mem::take(&mut self.osc);
        let (ps, pt) = match body.iter().position(|&c| c == b';') {
            Some(i) => (&body[..i], &body[i + 1..]),
            None => (&body[..], &body[0..0]),
        };
        match ps {
            b"133" => self.handle_osc133(pt, emit),
            // OSC 9;4 is taskbar progress, not a notification.
            b"9" if !pt.starts_with(b"4;") && pt != b"4" => self.generic_attention(emit),
            b"777" => self.handle_osc777(pt, emit),
            _ => {}
        }
    }

    fn handle_osc777<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        if let Some(tail) = pt.strip_prefix(TERAX_MARKER) {
            // PTY output is untrusted: only self-arm for known agents.
            let (agent, event) = match tail.iter().position(|&c| c == b';') {
                Some(i) => {
                    let Ok(name) = std::str::from_utf8(&tail[..i]) else {
                        return;
                    };
                    if !self.agents.iter().any(|a| a == name) {
                        return;
                    }
                    (name, &tail[i + 1..])
                }
                None => ("claude", tail),
            };
            // Self-arms when no shell preexec fired (bash, Windows, tmux).
            match event {
                b"working" => {
                    self.ensure_armed(agent, emit);
                    self.set_working(emit);
                }
                b"attention" => {
                    self.ensure_armed(agent, emit);
                    self.status = Status::Waiting;
                    emit(Transition::Attention);
                }
                b"finished" => {
                    self.ensure_armed(agent, emit);
                    self.status = Status::Waiting;
                    emit(Transition::Finished);
                }
                _ => {}
            }
            return;
        }
        self.generic_attention(emit);
    }

    fn handle_osc133<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        match pt.first() {
            Some(b'C') => {
                if self.armed {
                    return;
                }
                let cmd = pt.strip_prefix(b"C;").unwrap_or(b"");
                let (started_at_ms, cmd) = command_start(cmd);
                if let Some(agent) = self.match_agent(cmd) {
                    self.armed = true;
                    self.status = Status::Idle;
                    emit(Transition::Started {
                        session_id: resume_id(cmd),
                        agent,
                        started_at_ms,
                    });
                }
            }
            Some(b'D') if self.armed => {
                self.disarm();
                emit(Transition::Exited);
            }
            _ => {}
        }
    }

    fn ensure_armed<F: FnMut(Transition)>(&mut self, agent: &str, emit: &mut F) {
        if !self.armed {
            self.armed = true;
            self.status = Status::Idle;
            emit(Transition::Started {
                agent: agent.to_string(),
                session_id: None,
                started_at_ms: None,
            });
        }
    }

    fn set_working<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if self.status != Status::Working {
            self.status = Status::Working;
            emit(Transition::Working);
        }
    }

    fn generic_attention<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if self.armed {
            self.status = Status::Waiting;
            emit(Transition::Attention);
        }
    }

    fn match_agent(&self, cmd: &[u8]) -> Option<String> {
        let cmd = std::str::from_utf8(cmd).ok()?;
        let mut command = true;
        let mut option_value = false;
        for token in command_words(cmd) {
            if matches!(token.as_str(), ";" | "|" | "&") {
                command = true;
                option_value = false;
                continue;
            }
            if !command {
                continue;
            }
            if option_value {
                option_value = false;
                continue;
            }
            if token.starts_with('-') {
                option_value = matches!(
                    token.as_str(),
                    "-u" | "--user" | "-g" | "--group" | "--package" | "-p"
                );
                continue;
            }
            if token.split_once('=').is_some_and(|(name, _)| {
                !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            }) {
                continue;
            }
            let base = token
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(&token)
                .to_ascii_lowercase();
            let base = [".exe", ".cmd", ".bat", ".ps1", ".js"]
                .iter()
                .find_map(|extension| base.strip_suffix(extension))
                .unwrap_or(&base);
            if matches!(
                base,
                "env"
                    | "exec"
                    | "command"
                    | "sudo"
                    | "npx"
                    | "npm"
                    | "pnpm"
                    | "bun"
                    | "node"
                    | "dlx"
            ) || matches!(base, "run" | "x")
            {
                continue;
            }
            if let Some(agent) = self.agents.iter().find(|a| {
                base.strip_prefix(a.as_str())
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
            }) {
                return Some(agent.clone());
            }
            command = false;
        }
        None
    }
}

fn command_words(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut characters = command.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '`' && quote != Some('\'') {
            if let Some(escaped) = characters.next() {
                word.push(escaped);
            }
            continue;
        }
        if character == '\\'
            && quote != Some('\'')
            && characters.peek().is_some_and(|next| {
                matches!(next, '"' | '\'' | ';' | '|' | '&')
                    || (quote.is_none() && next.is_whitespace())
            })
        {
            word.push(characters.next().expect("peeked character"));
            continue;
        }
        if let Some(delimiter) = quote {
            if character == delimiter {
                quote = None;
            } else {
                word.push(character);
            }
        } else if matches!(character, '\'' | '"') {
            quote = Some(character);
        } else if character.is_whitespace() || matches!(character, ';' | '|' | '&') {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            if matches!(character, ';' | '|' | '&') {
                words.push(character.to_string());
            }
        } else {
            word.push(character);
        }
    }
    if quote.is_some() {
        return Vec::new();
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

fn resume_id(cmd: &[u8]) -> Option<String> {
    let tokens = command_words(std::str::from_utf8(cmd).ok()?);
    tokens.windows(2).find_map(|pair| {
        if !matches!(pair[0].as_str(), "resume" | "--resume" | "--session-id") {
            return None;
        }
        let id = pair[1].as_str();
        crate::modules::sessions::valid_id(id).then(|| id.to_string())
    })
}

fn command_start(cmd: &[u8]) -> (Option<u64>, &[u8]) {
    let Some(rest) = cmd.strip_prefix(b"terax-start=") else {
        return (None, cmd);
    };
    let Some(separator) = rest.iter().position(|b| *b == b';') else {
        return (None, cmd);
    };
    let at = std::str::from_utf8(&rest[..separator])
        .ok()
        .and_then(|s| s.parse().ok());
    (at, &rest[separator + 1..])
}
