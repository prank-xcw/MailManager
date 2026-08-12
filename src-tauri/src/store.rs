use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

const STORAGE_FILE: &str = "accounts.enc";
const SALT_FILE: &str = "accounts.salt";
const NONCE_SIZE: usize = 12;
const SALT_SIZE: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredential {
    pub email: String,
    #[serde(default)]
    pub password: String,
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

/// 使用 Argon2id 派生加密密钥，salt 持久化到文件确保重启后密钥一致
fn derive_key(data_dir: &PathBuf) -> Result<[u8; 32], String> {
    let salt_path = data_dir.join(SALT_FILE);
    let enc_path = data_dir.join(STORAGE_FILE);

    let salt = if salt_path.exists() {
        let salt_b64 = fs::read_to_string(&salt_path)
            .map_err(|e| format!("读取 salt 文件失败: {e}"))?;
        let salt_bytes = BASE64
            .decode(salt_b64.trim().as_bytes())
            .map_err(|e| format!("Salt 解码失败: {e}"))?;
        if salt_bytes.len() != SALT_SIZE {
            return Err(format!(
                "Salt 长度异常: 期望 {} 字节, 实际 {} 字节",
                SALT_SIZE,
                salt_bytes.len()
            ));
        }
        let mut s = [0u8; SALT_SIZE];
        s.copy_from_slice(&salt_bytes);
        s
    } else {
        // salt 不存在 → 生成新随机 salt
        if enc_path.exists() {
            // 加密数据存在但 salt 丢失 → 先备份旧密文，避免数据静默丢失
            let backup = enc_path.with_extension("enc.lost-salt");
            let _ = fs::copy(&enc_path, &backup);
            eprintln!(
                "[WARN] ⚠️ {} 丢失但 {} 仍存在！已备份旧密文到 {}，旧账号将无法解密。请从备份恢复 {} 文件。",
                SALT_FILE, STORAGE_FILE, backup.display(), SALT_FILE
            );
        }
        let mut s = [0u8; SALT_SIZE];
        rand::rngs::OsRng.fill_bytes(&mut s);
        fs::write(&salt_path, BASE64.encode(s))
            .map_err(|e| format!("写入 salt 文件失败: {e}"))?;
        s
    };

    // 密码材料：仅使用固定前缀，不再依赖 hostname/exe_path
    // 这两个值会随网络环境或安装路径变化，曾导致密钥失效和数据丢失
    // salt 是 32 字节随机值，已提供充分的唯一性保证
    let password = b"ccmtc-mail-encryption-key-v3";

    let argon2 = Argon2::default();
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password, &salt, &mut key)
        .map_err(|e| format!("Argon2id 密钥派生失败: {e}"))?;

    Ok(key)
}

/// 收集当前机器可能的 hostname 变体，覆盖 DHCP 动态变化场景
fn hostname_variants() -> Vec<String> {
    use std::process::Command;
    let mut hosts = Vec::new();

    // 1. Rust hostname API（当前值）
    if let Ok(h) = hostname::get() {
        let s = h.to_string_lossy().to_string();
        hosts.push(s.clone());
        if let Some(base) = s.strip_suffix(".local") {
            hosts.push(base.to_string());
        }
    }

    // 2. macOS 系统主机名（通过 scutil 获取，覆盖 hostname::get 与系统名不一致的情况）
    for cmd in &["LocalHostName", "ComputerName"] {
        if let Ok(output) = Command::new("scutil").args(["--get", cmd]).output() {
            if output.status.success() {
                let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !s.is_empty() && !hosts.contains(&s) {
                    hosts.push(s.clone());
                    let with_local = format!("{}.local", s);
                    if !hosts.contains(&with_local) {
                        hosts.push(with_local);
                    }
                }
            }
        }
    }

    // 3. 常见网络分配名和边界情况（hostname::get 可能返回这些值或失败）
    for h in &["bogon", "localhost", ""] {
        let s = h.to_string();
        if !hosts.contains(&s) {
            hosts.push(s);
        }
    }

    hosts
}

/// 收集可能的 exe 路径变体
fn exe_path_variants() -> Vec<String> {
    let mut paths = Vec::new();

    // 1. 当前 exe 路径
    if let Ok(exe) = std::env::current_exe() {
        let s = exe.to_string_lossy().to_string();
        if !paths.contains(&s) {
            paths.push(s);
        }
    }

    // 2. 编译时已知的 debug 路径（覆盖开发模式启动）
    let debug_path = format!("{}/target/debug/ccmtc-mail", env!("CARGO_MANIFEST_DIR"));
    if !paths.contains(&debug_path) {
        paths.push(debug_path);
    }

    // 3. 空字符串（current_exe 可能失败）
    paths.push(String::new());

    paths
}

/// 旧版密钥派生 v0：原始单次 SHA-256，枚举 hostname × exe 变体
fn old_v0_key_variants() -> Vec<[u8; 32]> {
    let hosts = hostname_variants();
    let exes = exe_path_variants();
    let mut keys = Vec::with_capacity(hosts.len() * exes.len());
    for host in &hosts {
        for exe in &exes {
            let mut hasher = Sha256::new();
            hasher.update(b"ccmtc-mail-encryption-key-v1");
            hasher.update(host.as_bytes());
            hasher.update(exe.as_bytes());
            let result = hasher.finalize();
            let mut key = [0u8; 32];
            key.copy_from_slice(&result);
            keys.push(key);
        }
    }
    keys
}

/// 旧版密钥派生 v1：1024 轮 SHA-256，枚举 hostname × exe 变体
fn old_v1_key_variants() -> Vec<[u8; 32]> {
    let hosts = hostname_variants();
    let exes = exe_path_variants();
    let mut keys = Vec::with_capacity(hosts.len() * exes.len());
    for host in &hosts {
        for exe in &exes {
            let mut hasher = Sha256::new();
            hasher.update(b"ccmtc-mail-encryption-key-v1");
            hasher.update(host.as_bytes());
            hasher.update(exe.as_bytes());
            let mut result = hasher.finalize();
            for _ in 0..1023 {
                let mut h = Sha256::new();
                h.update(&result);
                result = h.finalize();
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&result);
            keys.push(key);
        }
    }
    keys
}

/// 尝试用所有旧版密钥变体解密数据，返回解密后的明文
fn try_decrypt_with_any_old_key(path: &PathBuf) -> Result<Option<Vec<u8>>, String> {
    let encrypted = fs::read(path).map_err(|e| format!("读取存储文件失败: {e}"))?;
    if encrypted.len() < NONCE_SIZE {
        return Ok(None);
    }
    let (nonce_bytes, ciphertext) = encrypted.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);

    // 尝试 v0 所有变体（原始单次 SHA-256）
    for key in old_v0_key_variants() {
        if let Ok(cipher) = Aes256Gcm::new_from_slice(&key) {
            if let Ok(plaintext) = cipher.decrypt(nonce, ciphertext) {
                eprintln!("[Recovery] 使用原始单次 SHA-256 密钥解密成功（hostname 变体匹配）");
                return Ok(Some(plaintext));
            }
        }
    }

    // 尝试 v1 所有变体（1024 轮 SHA-256）
    for key in old_v1_key_variants() {
        if let Ok(cipher) = Aes256Gcm::new_from_slice(&key) {
            if let Ok(plaintext) = cipher.decrypt(nonce, ciphertext) {
                eprintln!("[Recovery] 使用 1024 轮 SHA-256 密钥解密成功（hostname 变体匹配）");
                return Ok(Some(plaintext));
            }
        }
    }

    Ok(None)
}

/// 尝试用旧版密钥解密已有数据，成功则返回解密后的存储
fn try_migrate_old_storage(path: &PathBuf) -> Option<HashMap<String, StoredCredential>> {
    match try_decrypt_with_any_old_key(path) {
        Ok(Some(plaintext)) => serde_json::from_slice(&plaintext).ok(),
        _ => None,
    }
}

/// 检测旧版 FNV-1a 账号 ID（mail- 后跟纯十进制数字）
fn needs_id_migration(store: &HashMap<String, StoredCredential>) -> bool {
    store.keys().any(|id| {
        id.starts_with("mail-") && id["mail-".len()..].chars().all(|c| c.is_ascii_digit())
    })
}

pub fn init_storage(app_data_dir: PathBuf) -> Result<(), String> {
    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("创建数据目录失败: {e}"))?;

    let enc_path = app_data_dir.join(STORAGE_FILE);
    let salt_path = app_data_dir.join(SALT_FILE);

    // 密钥迁移：已有加密数据但无 salt 文件 → 用旧密钥解密后用 Argon2id 重新加密
    if enc_path.exists() && !salt_path.exists() {
        if let Some(old_store) = try_migrate_old_storage(&enc_path) {
            // 迁移专用：生成新 salt 和 Argon2id 密钥
            let new_key = derive_key(&app_data_dir)?;
            let new_cipher = Aes256Gcm::new_from_slice(&new_key)
                .map_err(|e| format!("创建加密器失败: {e}"))?;

            // 用新密钥加密旧数据
            let plaintext = serde_json::to_vec(&old_store)
                .map_err(|e| format!("序列化存储数据失败: {e}"))?;
            let nonce_bytes: [u8; NONCE_SIZE] = rand::random();
            let nonce = Nonce::from_slice(&nonce_bytes);
            let ciphertext = new_cipher
                .encrypt(nonce, plaintext.as_ref())
                .map_err(|_| "加密存储失败".to_string())?;

            let mut output = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
            output.extend_from_slice(&nonce_bytes);
            output.extend_from_slice(&ciphertext);
            fs::write(&enc_path, &output)
                .map_err(|e| format!("写入存储文件失败: {e}"))?;

            eprintln!("[Migrate] 已从旧版 SHA-256 密钥迁移到 Argon2id");
        } else {
            eprintln!(
                "[Migrate] ⚠️ 旧版密钥迁移失败，salt 已丢失且旧密钥无法解密。将在首次读取时尝试恢复"
            );
        }
    }

    let key = derive_key(&app_data_dir)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("创建加密器失败: {e}"))?;

    let mut state = STATE.lock().map_err(|e| format!("存储锁错误: {e}"))?;
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
    // 读取并解密存储，在块作用域内释放锁
    let (store, needs_save, recovered) = {
        let state_guard = STATE.lock().map_err(|e| format!("存储锁错误: {e}"))?;
        let state = state_guard
            .as_ref()
            .ok_or_else(|| "存储未初始化".to_string())?;
        let path = storage_path(&state.data_dir);

        if !path.exists() {
            return Ok(HashMap::new());
        }

        let encrypted = fs::read(&path).map_err(|e| format!("读取存储文件失败: {e}"))?;

        if encrypted.len() < NONCE_SIZE {
            return Ok(HashMap::new());
        }

        let (nonce_bytes, ciphertext) = encrypted.split_at(NONCE_SIZE);
        let nonce = Nonce::from_slice(nonce_bytes);

        // 先尝试当前 Argon2id 密钥，失败则回退到旧版密钥恢复
        let (plaintext, recovered) = match state.cipher.decrypt(nonce, ciphertext) {
            Ok(p) => (p, false),
            Err(_) => {
                eprintln!("[Recovery] Argon2id 解密失败，尝试旧版密钥恢复...");
                match try_decrypt_with_any_old_key(&path)? {
                    Some(p) => (p, true),
                    None => {
                        // 所有密钥均无法解密 → 备份旧密文，返回空存储，不阻塞新导入
                        let backup = path.with_extension("enc.unreadable");
                        let _ = fs::copy(&path, &backup);
                        eprintln!(
                            "[Recovery] ⚠️ 所有密钥版本均无法解密，旧密文已备份到 {}。返回空存储，可重新导入账号。",
                            backup.display()
                        );
                        return Ok(HashMap::new());
                    }
                }
            }
        };

        let store: HashMap<String, StoredCredential> = serde_json::from_slice(&plaintext)
            .map_err(|e| format!("解析存储数据失败: {e}"))?;

        // 检测是否需要账号 ID 迁移或重新加密
        let needs_save = recovered || needs_id_migration(&store);
        (store, needs_save, recovered)
    }; // 锁在此释放

    // 重新加密（旧密钥恢复后）和/或账号 ID 迁移
    if needs_save {
        let mut final_store = store;
        if needs_id_migration(&final_store) {
            let mut migrated = HashMap::with_capacity(final_store.len());
            for (_, cred) in final_store.drain() {
                let new_id =
                    create_account_id(&cred.email, &cred.client_id, &cred.refresh_token);
                migrated.insert(new_id, cred);
            }
            final_store = migrated;
            eprintln!("[Migrate] 已迁移账号 ID 到 SHA-256 格式");
        }
        // save_store 会重新获取锁，此处锁已释放不会死锁
        save_store(&final_store)?;
        if recovered {
            eprintln!("[Recovery] 已用 Argon2id 重新加密恢复的存储数据");
        }
        Ok(final_store)
    } else {
        Ok(store)
    }
}

fn save_store(store: &HashMap<String, StoredCredential>) -> Result<(), String> {
    let state_guard = STATE.lock().map_err(|e| format!("存储锁错误: {e}"))?;
    let state = state_guard
        .as_ref()
        .ok_or_else(|| "存储未初始化".to_string())?;
    let path = storage_path(&state.data_dir);

    let plaintext =
        serde_json::to_vec(store).map_err(|e| format!("序列化存储数据失败: {e}"))?;

    let nonce_bytes: [u8; NONCE_SIZE] = rand::random();
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = state
        .cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|_| "加密存储失败".to_string())?;

    let mut output = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);

    fs::write(&path, &output).map_err(|e| format!("写入存储文件失败: {e}"))?;

    Ok(())
}

fn create_account_id(email: &str, client_id: &str, refresh_token: &str) -> String {
    let seed = format!(
        "{}::{}::{}",
        email.to_lowercase(),
        client_id,
        &refresh_token[..std::cmp::min(18, refresh_token.len())]
    );
    let digest = sha2::Sha256::digest(seed.as_bytes());
    // 取 SHA-256 前 8 字节（64 位）的十六进制表示，碰撞概率远低于 FNV-1a 32 位
    let hex_id: String = digest[..8].iter().map(|b| format!("{:02x}", b)).collect();
    format!("mail-{}", hex_id)
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
        let password = parts[1].to_string();
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
                password,
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
        .ok_or_else(|| format!("账号不存在: {account_id}"))
}

pub fn update_refresh_token(account_id: &str, new_refresh_token: &str) -> Result<(), String> {
    let mut store = load_store()?;
    if let Some(cred) = store.get_mut(account_id) {
        cred.refresh_token = new_refresh_token.to_string();
        save_store(&store)?;
        Ok(())
    } else {
        Err(format!("账号不存在: {account_id}"))
    }
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

/// 导出账号为 4 段格式文本（邮箱----密码----Client ID----Refresh Token）。
///
/// `account_ids` 为 `None` 或空列表时导出全部账号（向后兼容）；
/// 提供非空列表时只导出指定 ID 的账号（配合前端“导出选中行”功能）。
pub fn export_accounts(account_ids: Option<&[String]>) -> Result<String, String> {
    let store = load_store()?;
    let mut lines = Vec::new();

    // 安全警告注释（导入时自动跳过 # 开头的行）
    lines.push(
        "# ⚠️ 安全警告：本文件包含明文 refresh_token，请妥善保管，勿通过不安全渠道传输".to_string(),
    );

    let mut exported_count = 0usize;
    for (_, cred) in store.iter().filter(|(id, _)| match &account_ids {
        None => true,
        Some(ids) => ids.is_empty() || ids.contains(id),
    }) {
        // 导出4段格式与导入兼容：邮箱----密码----Client ID----Refresh Token
        lines.push(format!(
            "{}----{}----{}----{}",
            cred.email, cred.password, cred.client_id, cred.refresh_token
        ));
        exported_count += 1;
    }

    if exported_count == 0 {
        return Err("没有可导出的账号".to_string());
    }

    Ok(lines.join("\n"))
}
