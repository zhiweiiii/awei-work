use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const RECORD: &str = "awei-project.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRecord {
    root: String,
    created_at: u64,
    last_used_at: u64,
    indexed_at: Option<u64>,
    shared_index: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    pub id: String,
    pub project_root: Option<String>,
    pub path: String,
    pub bytes: u64,
    pub files: u64,
    pub last_used_at: Option<u64>,
    pub indexed_at: Option<u64>,
    pub active: bool,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(super) fn workspace_path(cache: &Path, root: &Path) -> PathBuf {
    let identity = crate::modules::fs::to_canon(root).to_lowercase();
    cache
        .join("lsp/jdtls")
        .join(format!("{:x}", Sha256::digest(identity.as_bytes())))
}

pub(super) fn shared_path(cache: &Path) -> PathBuf {
    cache.join("lsp/jdtls-shared")
}

fn read_record(directory: &Path) -> Option<ProjectRecord> {
    let file = std::fs::File::open(directory.join(RECORD)).ok()?;
    serde_json::from_reader(std::io::Read::take(file, 64 * 1024)).ok()
}

fn write_record(directory: &Path, record: &ProjectRecord) -> Result<(), String> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, record).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    file.persist(directory.join(RECORD))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn prepare(directory: &Path, root: &Path) -> Result<bool, String> {
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let timestamp = now();
    let mut record = read_record(directory).unwrap_or(ProjectRecord {
        root: crate::modules::fs::to_canon(root),
        created_at: timestamp,
        last_used_at: timestamp,
        indexed_at: None,
        shared_index: None,
    });
    record.last_used_at = timestamp;
    let cached = record.indexed_at.is_some();
    write_record(directory, &record)?;
    Ok(cached)
}

pub(super) fn mark_indexed(directory: &Path, shared: Option<&Path>) -> Result<(), String> {
    if let Some(mut record) = read_record(directory) {
        record.indexed_at = Some(now());
        record.shared_index = shared.map(crate::modules::fs::to_canon);
        write_record(directory, &record)?;
    }
    Ok(())
}

pub(super) fn is_cached(cache: &Path, root: &Path) -> bool {
    let directory = workspace_path(cache, root);
    read_record(&directory).is_some_and(|record| {
        record.indexed_at.is_some()
            && record
                .shared_index
                .is_none_or(|shared| Path::new(&shared).is_dir())
    }) && directory
        .join(".metadata/.plugins/org.eclipse.jdt.core")
        .is_dir()
}

pub(super) fn data_argument(args: &[String]) -> Option<PathBuf> {
    args.windows(2)
        .find(|pair| pair[0] == "-data")
        .map(|pair| PathBuf::from(&pair[1]))
        .or_else(|| {
            args.iter()
                .find_map(|arg| arg.strip_prefix("-data=").map(PathBuf::from))
        })
}

fn project_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn directory(cache: &Path, id: &str) -> Result<PathBuf, String> {
    if id == "shared" {
        Ok(shared_path(cache))
    } else if project_id(id) {
        Ok(cache.join("lsp/jdtls").join(id))
    } else {
        Err("Invalid Java cache identity".into())
    }
}

fn reparse(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn measure(directory: &Path) -> Result<(u64, u64), String> {
    let mut pending = vec![directory.to_path_buf()];
    let (mut bytes, mut files) = (0, 0);
    while let Some(path) = pending.pop() {
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.to_string()),
            };
            if reparse(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                bytes += metadata.len();
                files += 1;
            }
        }
    }
    Ok((bytes, files))
}

pub(super) fn list(cache: &Path) -> Result<Vec<CacheEntry>, String> {
    let mut entries = Vec::new();
    let project_base = cache.join("lsp/jdtls");
    let mut directories = Vec::new();
    if project_base.is_dir() {
        for entry in std::fs::read_dir(project_base).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if project_id(&id) {
                directories.push((id, entry.path()));
            }
        }
    }
    let shared = shared_path(cache);
    if shared.is_dir() {
        directories.push(("shared".into(), shared));
    }
    for (id, path) in directories {
        let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || reparse(&metadata) {
            continue;
        }
        let record = read_record(&path);
        let (bytes, files) = measure(&path)?;
        entries.push(CacheEntry {
            id,
            project_root: record.as_ref().map(|record| record.root.clone()),
            path: crate::modules::fs::to_canon(&path),
            bytes,
            files,
            last_used_at: record.as_ref().map(|record| record.last_used_at),
            indexed_at: record.and_then(|record| record.indexed_at),
            active: false,
        });
    }
    entries.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at).then(a.id.cmp(&b.id)));
    Ok(entries)
}

pub(super) fn delete(cache: &Path, id: &str) -> Result<(), String> {
    let path = directory(cache, id)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if reparse(&metadata) {
        return Err("Refusing to delete a redirected Java cache".into());
    }
    let base = std::fs::canonicalize(cache.join("lsp")).map_err(|e| e.to_string())?;
    let resolved = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if resolved == base || !resolved.starts_with(&base) {
        return Err("Java cache path is outside the application cache".into());
    }
    std::fs::remove_dir_all(resolved).map_err(|e| e.to_string())
}
