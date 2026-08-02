use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

const STORAGE_FILE: &str = "accounts.enc";
const NONCE_SIZE: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredential {
    pub email: String,
    pub client_id: String,
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    pub id: String,
    pub email: String,
}

struct StorageState {
    cipher: Aes256Gcm,
    data_dir: PathBuf,
}

static STATE: Mutex<Option<StorageState>> = Mutex::new(None);

fn derive_key() -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"ccmtc-mail-encryption-key-v1");

    // Mix in machine-specific entropy
    if let Ok(hostname) = hostname::get() {
        hasher.update(hostname.to_string_lossy().as_bytes());
    }
    if let Ok(exe_path) = std::env::current_exe() {
        hasher.update(exe_path.to_string_lossy().as_bytes());
    }

    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

pub fn init_storage(app_data_dir: PathBuf) -> Result<(), String> {
    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create data dir: {e}"))?;

    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("Failed to create cipher: {e}"))?;

    let mut state = STATE.lock().map_err(|e| format!("Lock error: {e}"))?;
    *state = Some(StorageState {
        cipher,
        data_dir: app_data_dir,
    });

    Ok(())
}

fn storage_path(data_dir: &PathBuf) -> PathBuf {
    data_dir.join(STORAGE_FILE)
}

fn load_store() -> Result<HashMap<String, StoredCredential>, String> {
    let state_guard = STATE.lock().map_err(|e| format!("Lock error: {e}"))?;
    let state = state_guard
        .as_ref()
        .ok_or_else(|| "Storage not initialized".to_string())?;
    let path = storage_path(&state.data_dir);

    if !path.exists() {
        return Ok(HashMap::new());
    }

    let encrypted = fs::read(&path).map_err(|e| format!("Failed to read storage: {e}"))?;

    if encrypted.len() < NONCE_SIZE {
        return Ok(HashMap::new());
    }

    let (nonce_bytes, ciphertext) = encrypted.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = state
        .cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Failed to decrypt storage".to_string())?;

    serde_json::from_slice(&plaintext)
        .map_err(|e| format!("Failed to parse storage: {e}"))
}

fn save_store(store: &HashMap<String, StoredCredential>) -> Result<(), String> {
    let state_guard = STATE.lock().map_err(|e| format!("Lock error: {e}"))?;
    let state = state_guard
        .as_ref()
        .ok_or_else(|| "Storage not initialized".to_string())?;
    let path = storage_path(&state.data_dir);

    let plaintext =
        serde_json::to_vec(store).map_err(|e| format!("Failed to serialize: {e}"))?;

    let nonce_bytes: [u8; NONCE_SIZE] = rand::random();
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = state
        .cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|_| "Failed to encrypt storage".to_string())?;

    let mut output = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);

    fs::write(&path, &output).map_err(|e| format!("Failed to write storage: {e}"))?;

    Ok(())
}

fn create_account_id(email: &str, client_id: &str, refresh_token: &str) -> String {
    let seed = format!(
        "{}::{}::{}",
        email.to_lowercase(),
        client_id,
        &refresh_token[..std::cmp::min(18, refresh_token.len())]
    );
    let mut hash: u32 = 2166136261;
    for byte in seed.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    format!("mail-{}", hash)
}

pub fn import_accounts(raw_text: String) -> Result<Vec<AccountInfo>, String> {
    let mut store = load_store()?;
    let mut imported = Vec::new();

    for line in raw_text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let parts: Vec<&str> = line.split("----").map(|s| s.trim()).collect();
        if parts.len() < 4 {
            continue;
        }

        let email = parts[0];
        let _password = parts[1]; // Skip password - not needed for OAuth
        let client_id = parts[2];
        let refresh_token = parts[3..].join("----");

        if email.is_empty() || client_id.is_empty() || refresh_token.is_empty() {
            continue;
        }

        let account_id = create_account_id(email, client_id, &refresh_token);

        store.insert(
            account_id.clone(),
            StoredCredential {
                email: email.to_string(),
                client_id: client_id.to_string(),
                refresh_token,
            },
        );

        imported.push(AccountInfo {
            id: account_id,
            email: email.to_string(),
        });
    }

    if !imported.is_empty() {
        save_store(&store)?;
    }

    Ok(imported)
}

pub fn load_credentials(account_id: &str) -> Result<StoredCredential, String> {
    let store = load_store()?;
    store
        .get(account_id)
        .cloned()
        .ok_or_else(|| format!("Account not found: {account_id}"))
}

pub fn update_refresh_token(account_id: &str, new_refresh_token: &str) -> Result<(), String> {
    let mut store = load_store()?;
    if let Some(cred) = store.get_mut(account_id) {
        cred.refresh_token = new_refresh_token.to_string();
        save_store(&store)?;
    }
    Ok(())
}

pub fn delete_account(account_id: &str) -> Result<(), String> {
    let mut store = load_store()?;
    store.remove(account_id);
    save_store(&store)
}

pub fn list_accounts() -> Result<Vec<AccountInfo>, String> {
    let store = load_store()?;
    Ok(store
        .iter()
        .map(|(id, cred)| AccountInfo {
            id: id.clone(),
            email: cred.email.clone(),
        })
        .collect())
}

pub fn clear_all_accounts() -> Result<(), String> {
    save_store(&HashMap::new())
}
