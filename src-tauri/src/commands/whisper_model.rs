//! Fork: in-app Whisper model management.
//!
//! Downloads ggml models from the official whisper.cpp Hugging Face repo
//! into the app-data directory, so a machine the app was merely installed
//! on (no bun, no dev tree) can get local STT working from Settings.
//! Model resolution order everywhere: dev tree, app-data, bundled
//! resources — see `resolve_whisper_model` (used by `start_transcription`).

#![expect(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors require pass-by-value"
)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};

const MODEL_REPO_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const PROGRESS_EVENT: &str = "whisper-download-progress";

/// One download at a time; a cancel request flips the second flag.
static DOWNLOAD_ACTIVE: AtomicBool = AtomicBool::new(false);
static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Reject anything that isn't a plain ggml model filename — the value is
/// user-influenced and joined into paths and URLs.
fn validate_filename(filename: &str) -> Result<(), String> {
    let valid = filename.starts_with("ggml-")
        && filename.ends_with(".bin")
        && filename
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !filename.contains("..");
    if valid {
        Ok(())
    } else {
        Err(format!("Invalid model filename: {filename}"))
    }
}

/// App-data location the downloader writes to (and the resolver prefers
/// over bundled resources).
fn app_data_model_path(app: &AppHandle, filename: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models")
        .join("whisper")
        .join(filename))
}

/// Resolve an installed model: dev tree first (matches the pre-existing
/// dev workflow), then app-data (downloaded in-app), then bundled
/// resources (legacy manual placement next to the install).
pub(crate) fn resolve_whisper_model(
    app: &AppHandle,
    filename: &str,
) -> Option<(PathBuf, &'static str)> {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("models")
        .join("whisper")
        .join(filename);
    if dev_path.exists() {
        return Some((dev_path, "dev"));
    }
    if let Ok(p) = app_data_model_path(app, filename) {
        if p.exists() {
            return Some((p, "app-data"));
        }
    }
    if let Ok(p) = app.path().resource_dir() {
        let p = p.join("models").join("whisper").join(filename);
        if p.exists() {
            return Some((p, "bundled"));
        }
    }
    None
}

#[derive(serde::Serialize)]
pub struct WhisperModelStatus {
    installed: bool,
    /// Where the resolved file lives: "dev" | "app-data" | "bundled".
    location: Option<String>,
    path: Option<String>,
    size_bytes: Option<u64>,
}

fn status_for(app: &AppHandle, filename: &str) -> Result<WhisperModelStatus, String> {
    validate_filename(filename)?;
    Ok(match resolve_whisper_model(app, filename) {
        Some((path, location)) => WhisperModelStatus {
            installed: true,
            location: Some(location.to_string()),
            size_bytes: std::fs::metadata(&path).map(|m| m.len()).ok(),
            path: Some(path.display().to_string()),
        },
        None => WhisperModelStatus {
            installed: false,
            location: None,
            path: None,
            size_bytes: None,
        },
    })
}

#[tauri::command]
pub fn whisper_model_status(
    app: AppHandle,
    filename: String,
) -> Result<WhisperModelStatus, String> {
    status_for(&app, &filename)
}

#[derive(serde::Serialize, Clone)]
struct DownloadProgress {
    filename: String,
    downloaded: u64,
    total: Option<u64>,
}

/// Stream a model from the whisper.cpp Hugging Face repo into app-data.
/// Writes to a `.part` file and renames on completion, so an interrupted
/// download never masquerades as an installed model.
#[tauri::command]
pub async fn download_whisper_model(
    app: AppHandle,
    filename: String,
) -> Result<WhisperModelStatus, String> {
    validate_filename(&filename)?;

    if DOWNLOAD_ACTIVE.swap(true, Ordering::SeqCst) {
        return Err("A model download is already in progress".into());
    }
    DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst);

    let result = download_inner(&app, &filename).await;
    DOWNLOAD_ACTIVE.store(false, Ordering::SeqCst);
    result
}

async fn download_inner(app: &AppHandle, filename: &str) -> Result<WhisperModelStatus, String> {
    let target = app_data_model_path(app, filename)?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let part = target.with_extension("bin.part");

    let url = format!("{MODEL_REPO_URL}/{filename}");
    log::info!("[WHISPER-DL] Downloading {url} -> {}", target.display());

    let response = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }
    let total = response.content_length();

    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;

    while let Some(chunk) = stream.next().await {
        if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            log::info!("[WHISPER-DL] Cancelled; removed partial file");
            return Err("Download cancelled".into());
        }
        let chunk = chunk.map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        // ~every 2 MB is plenty for a progress bar and keeps event volume low.
        if downloaded - last_emit >= 2 * 1024 * 1024 {
            last_emit = downloaded;
            let _ = app.emit(
                PROGRESS_EVENT,
                DownloadProgress {
                    filename: filename.to_string(),
                    downloaded,
                    total,
                },
            );
        }
    }
    drop(file);

    if let Some(expected) = total {
        let actual = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if actual != expected {
            let _ = std::fs::remove_file(&part);
            return Err(format!(
                "Download incomplete: got {actual} of {expected} bytes"
            ));
        }
    }

    std::fs::rename(&part, &target).map_err(|e| e.to_string())?;
    let _ = app.emit(
        PROGRESS_EVENT,
        DownloadProgress {
            filename: filename.to_string(),
            downloaded,
            total: Some(downloaded),
        },
    );
    log::info!("[WHISPER-DL] Completed: {} ({downloaded} bytes)", target.display());
    status_for(app, filename)
}

#[tauri::command]
pub fn cancel_whisper_download() {
    DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
}

/// Remove a model downloaded into app-data (bundled/dev copies are never
/// touched). Lets an operator swap model sizes without hunting for files.
#[tauri::command]
pub fn delete_whisper_model(app: AppHandle, filename: String) -> Result<(), String> {
    validate_filename(&filename)?;
    let path = app_data_model_path(&app, &filename)?;
    if !path.exists() {
        return Err("Model is not installed in app data".into());
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}
