mod mail;
pub mod store;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    mail::install_crypto_provider();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Initialize encrypted storage with app data directory
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");
            store::init_storage(app_data_dir).expect("Failed to initialize storage");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mail::fetch_mailbox,
            mail::import_accounts,
            mail::delete_account,
            mail::list_accounts,
            mail::clear_all_accounts,
            mail::export_accounts
        ])
        .run(tauri::generate_context!())
        .expect("error while running CCMTC Mail");
}
