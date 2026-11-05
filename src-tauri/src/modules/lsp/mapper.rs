use quick_xml::{events::Event, Reader};
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

pub(super) fn files(root: &Path, namespace: &str, kind: &str) -> Result<Vec<String>, String> {
    if !matches!(kind, "java" | "xml")
        || namespace.len() > 512
        || namespace.split('.').any(|part| part.is_empty())
        || !namespace
            .chars()
            .all(|character| character.is_alphanumeric() || "._$".contains(character))
    {
        return Err("Invalid Mapper namespace or file kind".into());
    }
    let class = namespace.rsplit('.').next().unwrap_or(namespace);
    let name = if kind == "java" {
        class.split('$').next().unwrap_or(class)
    } else {
        class
    };
    let expected = format!("{name}.{kind}");
    let mut exact = Vec::new();
    let mut others = Vec::new();
    let started = Instant::now();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .follow_links(false)
        .max_depth(Some(48))
        .filter_entry(|entry| {
            !entry.file_type().is_some_and(|kind| kind.is_dir())
                || !matches!(
                    entry.file_name().to_str(),
                    Some(
                        ".git"
                            | ".idea"
                            | ".gradle"
                            | "node_modules"
                            | "target"
                            | "build"
                            | "dist"
                            | "out"
                    )
                )
        })
        .build();
    for (count, entry) in walker.enumerate() {
        if count >= 100_000 || started.elapsed() > Duration::from_secs(4) {
            return Err("Mapper 文件查找超过范围或时间限制，请缩小项目范围".into());
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.into_path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(&expected))
        {
            exact.push(path);
        } else if kind == "xml"
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("xml"))
        {
            others.push(path);
        }
    }
    if kind == "xml" {
        exact.retain(|path| xml_namespace(path).as_deref() == Some(namespace));
        if exact.is_empty() {
            for path in others {
                if started.elapsed() > Duration::from_secs(4) {
                    return Err("Mapper XML 查找超时，请缩小项目范围".into());
                }
                if xml_namespace(&path).as_deref() == Some(namespace) {
                    exact.push(path);
                }
            }
        }
    }
    exact.sort();
    if exact.len() > 32 {
        return Err("存在过多相同 Mapper，请缩小项目范围".into());
    }
    Ok(exact.iter().map(crate::modules::fs::to_canon).collect())
}

fn xml_namespace(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(32 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    let header = String::from_utf8_lossy(&bytes);
    let mut reader = Reader::from_str(&header);
    loop {
        match reader.read_event().ok()? {
            Event::Start(tag) | Event::Empty(tag) => {
                if tag.name().as_ref() != b"mapper" {
                    return None;
                }
                return tag
                    .attributes()
                    .filter_map(Result::ok)
                    .find(|attribute| attribute.key.as_ref() == b"namespace")?
                    .decode_and_unescape_value(reader.decoder())
                    .ok()
                    .map(|value| value.into_owned());
            }
            Event::Eof => return None,
            _ => {}
        }
    }
}
