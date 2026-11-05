//! Replaces `keytar` + `TokenStore` (`app/src/lib/stores/token-store.ts`).
//!
//! On Windows the token is encrypted with DPAPI (`CurrentUser`) before it is
//! written to disk, so the ciphertext is bound to the logged-in Windows
//! account. The plaintext is passed over stdin, never on a command line where
//! it would be visible to other processes. On other platforms a 0600 file is
//! used until the native keychain backends are wired up (see MIGRATION.md).
//!
//! No token ever appears in `AppState` snapshots sent to the webview.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::error::{AppError, Result};

#[derive(Debug, Clone)]
pub struct SecureStore {
    dir: PathBuf,
}

impl SecureStore {
    pub fn new(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    pub fn set_item(&self, key: &str, login: &str, value: &str) -> Result<()> {
        let protected = protect(value)?;
        let record = serde_json::json!({ "login": login, "secret": protected });
        super::json_store::atomic_write(&self.path_for(key), &serde_json::to_vec(&record)?)
    }

    pub fn get_item(&self, key: &str, _login: &str) -> Result<Option<String>> {
        let bytes = match std::fs::read(self.path_for(key)) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(AppError::Io(e)),
        };
        let record: serde_json::Value = serde_json::from_slice(&bytes)?;
        let secret = record
            .get("secret")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::msg("credential record is malformed"))?;
        Ok(Some(unprotect(secret)?))
    }

    pub fn delete_item(&self, key: &str, _login: &str) -> Result<()> {
        match std::fs::remove_file(self.path_for(key)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::Io(e)),
        }
    }

    fn path_for(&self, key: &str) -> PathBuf {
        // Keys are "login@endpoint" and may contain / and : characters.
        let hashed = crate::models::repository::simple_hash(key);
        self.dir.join(format!("{hashed:016x}.cred"))
    }
}

#[cfg(target_os = "windows")]
fn protect(plaintext: &str) -> Result<String> {
    powershell(
        "Add-Type -AssemblyName System.Security; \
         $raw = [Console]::In.ReadToEnd(); \
         $bytes = [Convert]::FromBase64String($raw); \
         $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser'); \
         [Console]::Out.Write([Convert]::ToBase64String($enc))",
        &base64_encode(plaintext.as_bytes()),
    )
}

#[cfg(target_os = "windows")]
fn unprotect(ciphertext: &str) -> Result<String> {
    let plain_b64 = powershell(
        "Add-Type -AssemblyName System.Security; \
         $raw = [Console]::In.ReadToEnd(); \
         $bytes = [Convert]::FromBase64String($raw); \
         $dec = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser'); \
         [Console]::Out.Write([Convert]::ToBase64String($dec))",
        ciphertext,
    )?;
    let bytes = base64_decode(&plain_b64)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(target_os = "windows")]
fn powershell(script: &str, input: &str) -> Result<String> {
    let mut child = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::msg(format!("unable to start PowerShell for DPAPI: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(AppError::msg(format!(
            "DPAPI command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(not(target_os = "windows"))]
fn protect(plaintext: &str) -> Result<String> {
    tracing::warn!("native keychain not wired for this platform; using 0600 file fallback");
    Ok(base64_encode(plaintext.as_bytes()))
}

#[cfg(not(target_os = "windows"))]
fn unprotect(ciphertext: &str) -> Result<String> {
    let bytes = base64_decode(ciphertext)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// Tiny base64 codec; avoids pulling in another dependency just for credentials.
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { B64[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[(n & 63) as usize] as char } else { '=' });
    }
    out
}

pub fn base64_decode(input: &str) -> Result<Vec<u8>> {
    let clean: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if clean.len() % 4 != 0 {
        return Err(AppError::msg("invalid base64 payload in credential store"));
    }
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    for chunk in clean.chunks(4) {
        let mut n = 0u32;
        let mut padding = 0u8;
        for (i, b) in chunk.iter().enumerate() {
            let value = if *b == b'=' {
                padding += 1;
                0
            } else {
                B64.iter().position(|c| c == b).ok_or_else(|| AppError::msg("invalid base64 character"))? as u32
            };
            n |= value << (18 - i * 6);
        }
        out.push((n >> 16) as u8);
        if padding < 2 { out.push((n >> 8) as u8); }
        if padding < 1 { out.push(n as u8); }
    }
    Ok(out)
}
