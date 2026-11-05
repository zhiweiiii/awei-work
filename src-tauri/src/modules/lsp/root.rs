use quick_xml::{events::Event, Reader};
use std::io::Read;
use std::path::{Path, PathBuf};

pub(super) fn resolve(path: &str, markers: &[String], java: bool) -> Option<String> {
    if markers.len() > 100
        || markers
            .iter()
            .any(|m| m.is_empty() || m.contains(['/', '\\']) || m == "..")
    {
        return None;
    }
    let start = std::fs::canonicalize(path).ok()?;
    let home = dirs::home_dir().and_then(|p| std::fs::canonicalize(p).ok());
    let mut dir = if start.is_dir() {
        start.as_path()
    } else {
        start.parent()?
    };
    let mut candidate: Option<PathBuf> = None;
    let mut gradle_root: Option<PathBuf> = None;
    let mut maven = false;
    for _ in 0..128 {
        if home.as_deref() == Some(dir) || dir.parent().is_none() {
            break;
        }
        if !java {
            if markers.iter().any(|m| dir.join(m).exists()) {
                return Some(crate::modules::fs::to_canon(dir));
            }
        } else {
            if candidate.is_none() && markers.iter().any(|m| dir.join(m).exists()) {
                candidate = Some(dir.to_path_buf());
                maven = dir.join("pom.xml").is_file();
            }
            if !maven
                && gradle_root.is_none()
                && (dir.join("settings.gradle").is_file()
                    || dir.join("settings.gradle.kts").is_file())
            {
                gradle_root = Some(dir.to_path_buf());
            }
            if gradle_root.is_none() && dir.join("pom.xml").is_file() {
                if let Some(current) = &candidate {
                    if dir != current && maven_contains(dir, current) {
                        candidate = Some(dir.to_path_buf());
                        maven = true;
                    }
                }
            }
            if dir.join(".git").exists() {
                break;
            }
        }
        dir = dir.parent()?;
    }
    gradle_root.or(candidate).map(crate::modules::fs::to_canon)
}

fn is_module(stack: &[Vec<u8>]) -> bool {
    let simple = stack.len() == 3 && stack[0] == b"project";
    let profile = stack.len() == 5
        && stack[0] == b"project"
        && stack[1] == b"profiles"
        && stack[2] == b"profile";
    (simple || profile)
        && stack[stack.len() - 2] == b"modules"
        && stack[stack.len() - 1] == b"module"
}

fn maven_contains(parent: &Path, child: &Path) -> bool {
    let Ok(file) = std::fs::File::open(parent.join("pom.xml")) else {
        return false;
    };
    let mut bytes = Vec::new();
    if file.take(1024 * 1024 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > 1024 * 1024 {
        return false;
    }
    let mut reader = Reader::from_reader(bytes.as_slice());
    reader.config_mut().trim_text(false);
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut text = String::new();
    let mut count = 0;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                if stack.len() > 64 {
                    return false;
                }
                stack.push(event.local_name().as_ref().to_vec());
                if stack.last().is_some_and(|tag| tag == b"module") {
                    text.clear();
                }
            }
            Ok(Event::Text(event)) if is_module(&stack) => {
                let Ok(decoded) = event.decode() else {
                    return false;
                };
                let Ok(decoded) = quick_xml::escape::unescape(&decoded) else {
                    return false;
                };
                text.push_str(&decoded);
            }
            Ok(Event::CData(event)) if is_module(&stack) => {
                let Ok(decoded) = event.decode() else {
                    return false;
                };
                text.push_str(&decoded);
            }
            Ok(Event::GeneralRef(event)) if is_module(&stack) => {
                let Ok(reference) = event.decode() else {
                    return false;
                };
                let encoded = format!("&{reference};");
                let Ok(decoded) = quick_xml::escape::unescape(&encoded) else {
                    return false;
                };
                text.push_str(&decoded);
            }
            Ok(Event::End(_)) => {
                if is_module(&stack) {
                    count += 1;
                    if count > 1000 {
                        return false;
                    }
                    let module = text.trim();
                    if !module.is_empty() && !module.contains("${") {
                        if let Ok(module) = std::fs::canonicalize(parent.join(module)) {
                            if module.starts_with(parent) && child.starts_with(module) {
                                return true;
                            }
                        }
                    }
                }
                stack.pop();
            }
            Ok(Event::Eof) => return false,
            Err(_) => return false,
            _ => {}
        }
    }
}
