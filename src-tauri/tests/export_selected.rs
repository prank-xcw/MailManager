//! 集成测试：导出选中行逻辑
//!
//! 需求：列表页勾选部分行后导出，应只导出选中账号；
//! 未勾选任何行时保持原有行为（导出全部，向后兼容）。
//!
//! 1) `export_accounts(Some(&[id1, id2]))` 只导出这两个账号；
//! 2) `export_accounts(None)` 导出全部（向后兼容）；
//! 3) `export_accounts(Some(&[]))` 视为导出全部（防御前端误传空数组）。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use ccmtc_mail_lib::store::{export_accounts, import_accounts, init_storage};

static SEQ: AtomicU32 = AtomicU32::new(0);

/// 存储层使用进程级全局状态（`init_storage` 会覆盖 `STATE`），
/// 两个测试并行执行时会互相覆盖数据目录。用互斥锁串行化对存储的
/// 访问，保证测试在默认并行执行下依然确定。
static STORAGE_LOCK: Mutex<()> = Mutex::new(());

fn temp_data_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "ccmtc-mail-export-selected-test-{}-{}",
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

/// 去掉安全警告注释行，返回纯数据行
fn data_lines(exported: &str) -> Vec<&str> {
    exported
        .lines()
        .filter(|line| !line.starts_with('#'))
        .collect()
}

#[test]
fn export_only_selected_accounts() {
    let _storage_guard = STORAGE_LOCK.lock().unwrap();
    let dir = temp_data_dir();
    let _cleanup = Cleanup(dir.clone());
    init_storage(dir.clone()).expect("初始化存储失败");

    let imported = import_accounts(
        concat!(
            "alpha@example.com----pw-1----client-a----token-1\n",
            "beta@example.com----pw-2----client-b----token-2\n",
            "gamma@example.com----pw-3----client-c----token-3\n",
        )
        .to_string(),
    )
    .expect("导入失败");
    assert_eq!(imported.len(), 3, "应导入 3 个账号");

    // 勾选前两个账号 → 只导出这两个
    let selected: Vec<String> = vec![imported[0].id.clone(), imported[1].id.clone()];
    let exported = export_accounts(Some(&selected)).expect("导出选中账号失败");

    let lines = data_lines(&exported);
    assert_eq!(lines.len(), 2, "应只导出 2 个选中账号，实际内容:\n{exported}");
    assert!(
        lines.iter().any(|l| l.contains("alpha@example.com")),
        "选中的 alpha 应出现在导出中:\n{exported}"
    );
    assert!(
        lines.iter().any(|l| l.contains("beta@example.com")),
        "选中的 beta 应出现在导出中:\n{exported}"
    );
    assert!(
        lines.iter().all(|l| !l.contains("gamma@example.com")),
        "未选中的 gamma 不应出现在导出中:\n{exported}"
    );
}

#[test]
fn export_all_when_nothing_selected() {
    let _storage_guard = STORAGE_LOCK.lock().unwrap();
    let dir = temp_data_dir();
    let _cleanup = Cleanup(dir.clone());
    init_storage(dir.clone()).expect("初始化存储失败");

    let imported = import_accounts(
        concat!(
            "alpha@example.com----pw-1----client-a----token-1\n",
            "beta@example.com----pw-2----client-b----token-2\n",
        )
        .to_string(),
    )
    .expect("导入失败");
    assert_eq!(imported.len(), 2, "应导入 2 个账号");

    // 未勾选任何行（None）→ 导出全部，保持向后兼容
    let exported = export_accounts(None).expect("导出全部失败");
    let lines = data_lines(&exported);
    assert_eq!(lines.len(), 2, "未选中时应导出全部账号:\n{exported}");

    // 空列表同样视为导出全部，防御前端误传空数组
    let exported_empty = export_accounts(Some(&[])).expect("导出全部失败");
    let lines_empty = data_lines(&exported_empty);
    assert_eq!(lines_empty.len(), 2, "空 ID 列表应导出全部账号:\n{exported_empty}");
}
