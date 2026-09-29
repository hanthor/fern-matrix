#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;

// Session secrets (#29): crypto-store passphrases plus Matrix access/refresh
// tokens live in the OS keychain (Secret Service / Keychain / Credential
// Manager via the keyring crate). Missing entries resolve to None so the app
// can ask for sign-in again; every other keychain failure is an error.
#[tauri::command]
fn secret_get(service: String, name: String) -> Result<Option<String>, String> {
    let entry = Entry::new(&service, &name).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn secret_set(service: String, name: String, value: String) -> Result<(), String> {
    let entry = Entry::new(&service, &name).map_err(|error| error.to_string())?;
    entry.set_password(&value).map_err(|error| error.to_string())
}

#[tauri::command]
fn secret_delete(service: String, name: String) -> Result<(), String> {
    let entry = Entry::new(&service, &name).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![secret_get, secret_set, secret_delete])
        .run(tauri::generate_context!())
        .expect("error while running fern-matrix");
}
