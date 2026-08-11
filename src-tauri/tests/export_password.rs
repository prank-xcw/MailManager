//! 集成测试：验证导出账号时包含密码字段（邮箱----密码----Client ID----Refresh Token）
//!
//! 回归背景：`import_accounts` 曾解析密码后直接丢弃，`StoredCredential` 不保存
//! 密码，导致 `export_accounts` 导出的第 2 段密码永远为空。本测试确保：
//! 1) 导入的密码被保存并在导出时出现在第 2 段；
//! 2) 导出保持 4 段格式（与导入解析兼容）；
//! 3) 导出内容可被再次导入（往返兼容）。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use ccmtc_mail_lib::store::{export_accounts, import_accounts, init_storage};

static SEQ: AtomicU32 = AtomicU32::new(0);

fn temp_data_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "ccmtc-mail-export-test-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed),
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn exported_accounts_include_password_field() {
    let dir = temp_data_dir();
    let _cleanup = Cleanup(dir.clone());

    init_storage(dir.clone()).expect("初始化存储失败");

    // 密码包含空格与特殊字符，验证导出不丢失
    let imported = import_accounts(
        concat!(
            "user@example.com----secret-pass-123----client-abc----refresh-token-1\n",
            "other@example.com----p@ss w0rd!----client-xyz----refresh-token-2\n",
        )
        .to_string(),
    )
    .expect("导入失败");
    assert_eq!(imported.len(), 2, "应导入 2 个账号");

    let exported = export_accounts().expect("导出失败");

    // 1) 导出的行必须包含密码段（不再是空占位）
    assert!(
        exported.contains("user@example.com----secret-pass-123----client-abc----refresh-token-1"),
        "导出结果缺少密码字段，实际导出内容:\n{exported}",
    );
    assert!(
        exported.contains("other@example.com----p@ss w0rd!----client-xyz----refresh-token-2"),
        "导出结果缺少密码字段，实际导出内容:\n{exported}",
    );

    // 2) 保持 4 段格式与导入兼容（邮箱----密码----Client ID----Refresh Token）
    let data_lines: Vec<&str> = exported.lines().filter(|l| !l.starts_with('#')).collect();
    assert!(!data_lines.is_empty(), "导出不能为空");
    for line in &data_lines {
        assert_eq!(
            line.split("----").count(),
            4,
            "导出行必须保持 4 段格式: {line}",
        );
    }

    // 3) 往返兼容：导出的内容可被再次导入，且密码保留
    let reimported = import_accounts(exported).expect("再导入失败");
    assert_eq!(reimported.len(), 2, "往返导入后账号数应保持不变");
}
