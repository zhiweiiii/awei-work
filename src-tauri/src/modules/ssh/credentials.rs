use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

fn target(id: &str) -> Result<Vec<u16>, String> {
    if id.is_empty()
        || id.len() > 100
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid SSH connection identifier".into());
    }
    Ok(format!("awei-work/ssh/{id}")
        .encode_utf16()
        .chain(Some(0))
        .collect())
}

pub fn read(id: &str) -> Result<Option<String>, String> {
    let target = target(id)?;
    let mut credential = std::ptr::null_mut();
    unsafe {
        if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 {
            let code = GetLastError();
            return if code == 1168 {
                Ok(None)
            } else {
                Err(format!("Windows credential read failed ({code})"))
            };
        }
        let value = if (*credential).CredentialBlobSize == 0 {
            Ok(String::new())
        } else {
            String::from_utf8(
                std::slice::from_raw_parts(
                    (*credential).CredentialBlob,
                    (*credential).CredentialBlobSize as usize,
                )
                .to_vec(),
            )
            .map_err(|_| "Invalid saved SSH credential".to_string())
        };
        CredFree(credential.cast());
        value.map(Some)
    }
}

pub fn save(id: &str, secret: Option<String>) -> Result<(), String> {
    let mut target = target(id)?;
    unsafe {
        let Some(secret) = secret else {
            if CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) == 0 && GetLastError() != 1168 {
                return Err("Windows credential deletion failed".into());
            }
            return Ok(());
        };
        if secret.len() > 2560 {
            return Err("SSH password or passphrase is too long".into());
        }
        let mut bytes = secret.into_bytes();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..std::mem::zeroed()
        };
        let success = CredWriteW(&credential, 0) != 0;
        bytes.fill(0);
        if !success {
            return Err("Windows credential save failed".into());
        }
        Ok(())
    }
}
