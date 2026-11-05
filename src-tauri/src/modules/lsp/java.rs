use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

const LOMBOK_FILE: &str = "lombok-1.18.48.jar";
const LOMBOK_URL: &str =
    "https://repo.maven.apache.org/maven2/org/projectlombok/lombok/1.18.48/lombok-1.18.48.jar";
const LOMBOK_SHA256: &str = "85477a4655ebb2c074a9099cfb749be454449fee564d4282610df1b85f7c508b";
const MAX_JAR_BYTES: u64 = 10 * 1024 * 1024;
static PREPARE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaLaunch {
    pub args: Vec<String>,
    pub warning: Option<String>,
    pub cache_generation: u32,
}

fn valid_jar(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut bytes = Vec::new();
    if file
        .take(MAX_JAR_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_JAR_BYTES
    {
        return false;
    }
    format!("{:x}", Sha256::digest(&bytes)) == LOMBOK_SHA256
}

pub(super) fn workspace_path(cache: &Path, root: &Path) -> PathBuf {
    super::java_cache::workspace_path(cache, root)
}

async fn lombok(cache: &Path) -> Result<PathBuf, String> {
    let _guard = PREPARE.lock().await;
    let path = cache.join("lsp/lombok").join(LOMBOK_FILE);
    let check = path.clone();
    if crate::modules::fs::blocking(move || Ok(valid_jar(&check))).await? {
        return Ok(path);
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(LOMBOK_URL)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| e.to_string())?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_JAR_BYTES)
    {
        return Err("Lombok download exceeds 10 MiB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_JAR_BYTES as usize {
            return Err("Lombok download exceeds 10 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if format!("{:x}", Sha256::digest(&bytes)) != LOMBOK_SHA256 {
        return Err("Lombok download checksum mismatch".into());
    }
    let destination = path.clone();
    crate::modules::fs::blocking(move || {
        let parent = destination
            .parent()
            .ok_or("Missing Lombok cache directory")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temporary.write_all(&bytes).map_err(|e| e.to_string())?;
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        temporary.persist(&destination).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await?;
    Ok(path)
}

pub(super) async fn prepare(
    cache: PathBuf,
    root: PathBuf,
    mut args: Vec<String>,
) -> Result<JavaLaunch, String> {
    if !args
        .iter()
        .any(|arg| arg == "-data" || arg.starts_with("-data="))
    {
        let data = workspace_path(&cache, &root);
        let directory = data.clone();
        let project = root.clone();
        crate::modules::fs::blocking(move || {
            super::java_cache::prepare(&directory, &project).map(|_| ())
        })
        .await?;
        args.extend(["-data".into(), crate::modules::fs::to_canon(data)]);
    }
    let mut warnings = Vec::new();
    if !args
        .iter()
        .any(|arg| arg.contains("-Djdt.core.sharedIndexLocation="))
    {
        let shared = super::java_cache::shared_path(&cache);
        let directory = shared.clone();
        match crate::modules::fs::blocking(move || {
            std::fs::create_dir_all(directory).map_err(|e| e.to_string())
        })
        .await
        {
            Ok(()) => args.push(format!(
                "--jvm-arg=-Djdt.core.sharedIndexLocation={}",
                crate::modules::fs::to_canon(shared)
            )),
            Err(error) => warnings.push(format!(
                "Java 共享依赖索引未启用，继续使用项目索引：{error}"
            )),
        }
    }
    if !args.iter().any(|arg| arg.contains("-javaagent:")) {
        match lombok(&cache).await {
            Ok(path) => args.push(format!(
                "--jvm-arg=-javaagent:{}",
                crate::modules::fs::to_canon(path)
            )),
            Err(error) => warnings.push(format!(
                "Lombok 支持未加载：{error}。请恢复网络后重启 Java 语言服务。"
            )),
        }
    }
    Ok(JavaLaunch {
        args,
        warning: (!warnings.is_empty()).then(|| warnings.join("\n")),
        cache_generation: 0,
    })
}
