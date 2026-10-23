//! Fork: in-app Bark model management (macOS only).
//!
//! Downloads the Underdog Bark 3.0 Core ML model from the
//! `FluidInference/bark-3.0-coreml` Hugging Face repo into the app-data
//! directory, so a machine the app was merely installed on (no bun, no dev
//! tree) can get local Bark STT working from Settings. The model is a tree
//! of `.mlmodelc` directories, so the downloader walks the Hugging Face tree
//! API and mirrors the structure on disk. `Encoder_lut3.mlmodelc` (a 252 MB
//! GPU-only encoder variant that `FluidAudio`'s `loadLocal` never reads) is
//! skipped; the rest is about 437 MB.
//!
//! Model resolution order everywhere: dev tree, app-data, bundled resources
//! (see `resolve_bark_model`, used by `start_transcription`). The sidecar
//! executable is resolved separately by `resolve_bark_sidecar`.

#![expect(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors require pass-by-value"
)]

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};

/// Folder inside the Hugging Face repo that holds the verbatim model. The
/// sibling `bark-3.0-clean/` drops fillers and repeated words and must not
/// be used: it can delete an intentionally repeated verse number.
const HF_FOLDER: &str = "bark-3.0";
const TREE_API_URL: &str =
    "https://huggingface.co/api/models/FluidInference/bark-3.0-coreml/tree/main";
const RESOLVE_URL: &str = "https://huggingface.co/FluidInference/bark-3.0-coreml/resolve/main";
/// Top-level entries under the model folder that are never fetched.
const SKIP_DIRS: &[&str] = &["Encoder_lut3.mlmodelc"];
/// Files that must all be present for a directory to count as installed.
/// Checked at file level (the weights inside each `.mlmodelc`, not just the
/// directory) because both downloaders create a `.mlmodelc` directory before
/// its files finish, so an interrupted download would otherwise resolve as
/// installed and fail later inside the sidecar.
const REQUIRED_ENTRIES: &[&str] = &[
    "Encoder.mlmodelc/coremldata.bin",
    "Encoder.mlmodelc/weights/weight.bin",
    "Decoder.mlmodelc/coremldata.bin",
    "Decoder.mlmodelc/weights/weight.bin",
    "JointDecisionv3.mlmodelc/coremldata.bin",
    "JointDecisionv3.mlmodelc/weights/weight.bin",
    "Preprocessor.mlmodelc/coremldata.bin",
    "Preprocessor.mlmodelc/weights/weight.bin",
    "parakeet_vocab.json",
];
const PROGRESS_EVENT: &str = "bark-download-progress";

/// Dev-tree sidecar built by `bun run build:bark-sidecar` (Tauri's
/// `externalBin` naming requires the target-triple suffix).
const DEV_SIDECAR_FILENAME: &str = "bark-sidecar-aarch64-apple-darwin";
/// Name Tauri gives the sidecar next to the app executable in a bundle.
const BUNDLED_SIDECAR_FILENAME: &str = "bark-sidecar";

/// One download at a time; a cancel request flips the second flag.
static DOWNLOAD_ACTIVE: AtomicBool = AtomicBool::new(false);
static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

/// True when every required model file is present in `dir`.
fn is_installed(dir: &Path) -> bool {
    dir.is_dir() && REQUIRED_ENTRIES.iter().all(|e| dir.join(e).is_file())
}

/// App-data location the downloader writes to (and the resolver prefers
/// over bundled resources).
fn app_data_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models")
        .join("bark")
        .join(HF_FOLDER))
}

/// Resolve an installed model directory: dev tree first (matches the
/// Whisper dev workflow), then app-data (downloaded in-app), then bundled
/// resources (manual placement next to the install). A directory only
/// counts when all of `REQUIRED_ENTRIES` are present, so a partial
/// download never resolves.
pub(crate) fn resolve_bark_model(app: &AppHandle) -> Option<(PathBuf, &'static str)> {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("models")
        .join("bark")
        .join(HF_FOLDER);
    if is_installed(&dev_path) {
        return Some((dev_path, "dev"));
    }
    if let Ok(p) = app_data_model_dir(app) {
        if is_installed(&p) {
            return Some((p, "app-data"));
        }
    }
    if let Ok(p) = app.path().resource_dir() {
        let p = p.join("models").join("bark").join(HF_FOLDER);
        if is_installed(&p) {
            return Some((p, "bundled"));
        }
    }
    None
}

/// Resolve the sidecar executable: the dev-tree build first, then the copy
/// Tauri places next to the app executable for `externalBin` (both in
/// `cargo tauri dev`, where it lands in the target dir, and in a bundle,
/// where it lands in `Contents/MacOS`).
pub(crate) fn resolve_bark_sidecar() -> Option<PathBuf> {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(DEV_SIDECAR_FILENAME);
    if dev_path.is_file() {
        return Some(dev_path);
    }
    let exe = std::env::current_exe().ok()?;
    let prod_path = exe.parent()?.join(BUNDLED_SIDECAR_FILENAME);
    if prod_path.is_file() {
        return Some(prod_path);
    }
    None
}

/// Total size of every regular file under `dir`, recursively. Errors on
/// individual entries are skipped: the number is informational only.
fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            match entry.metadata() {
                Ok(m) if m.is_dir() => dir_size(&path),
                Ok(m) if m.is_file() => m.len(),
                _ => 0,
            }
        })
        .sum()
}

#[derive(serde::Serialize)]
pub struct BarkModelStatus {
    installed: bool,
    /// Where the resolved directory lives: "dev" | "app-data" | "bundled".
    location: Option<String>,
    path: Option<String>,
    /// Recursive size of the model directory.
    size_bytes: Option<u64>,
}

fn status_for(app: &AppHandle) -> BarkModelStatus {
    match resolve_bark_model(app) {
        Some((path, location)) => BarkModelStatus {
            installed: true,
            location: Some(location.to_string()),
            size_bytes: Some(dir_size(&path)),
            path: Some(path.display().to_string()),
        },
        None => BarkModelStatus {
            installed: false,
            location: None,
            path: None,
            size_bytes: None,
        },
    }
}

#[expect(
    clippy::unnecessary_wraps,
    reason = "keeps the invoke contract identical to whisper_model_status"
)]
#[tauri::command]
pub fn bark_model_status(app: AppHandle) -> Result<BarkModelStatus, String> {
    Ok(status_for(&app))
}

#[derive(serde::Serialize, Clone)]
struct DownloadProgress {
    /// Path of the file currently being fetched, relative to the model folder.
    filename: String,
    /// Cumulative bytes across the whole model, not just the current file.
    downloaded: u64,
    /// Sum of the file sizes from the tree listing.
    total: Option<u64>,
}

/// One entry of the Hugging Face tree API response.
#[derive(serde::Deserialize)]
struct TreeEntry {
    #[serde(rename = "type")]
    kind: String,
    path: String,
    #[serde(default)]
    size: u64,
}

/// One file to fetch, with its path relative to the model folder (for
/// example `Encoder.mlmodelc/weights/weight.bin`).
struct ModelFile {
    rel: String,
    size: u64,
}

/// Path of an entry relative to the model folder (the API returns
/// repo-relative paths).
fn relative_to_folder(path: &str) -> &str {
    path.strip_prefix(HF_FOLDER)
        .and_then(|rest| rest.strip_prefix('/'))
        .unwrap_or(path)
}

fn is_skipped(rel: &str) -> bool {
    let top = rel.split('/').next().unwrap_or(rel);
    SKIP_DIRS.contains(&top)
}

/// The listing is remote data that gets joined into the app-data path, so
/// only plain relative paths made of normal components are accepted.
fn is_safe_relative_path(rel: &str) -> bool {
    !rel.is_empty()
        && Path::new(rel)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

async fn list_tree(client: &reqwest::Client, folder: &str) -> Result<Vec<TreeEntry>, String> {
    let url = format!("{TREE_API_URL}/{folder}?recursive=true");
    let response = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Tree listing failed for {folder}: HTTP {}",
            response.status()
        ));
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| format!("Tree listing for {folder} is malformed: {e}"))
}

/// Collect every file under the model folder, honoring `SKIP_DIRS`.
/// `recursive=true` expands the whole subtree in one listing today, but a
/// directory whose files are absent from the listing is walked on its own
/// so a change in how deep the API expands cannot silently drop part of
/// the model. Iterative rather than recursive because async recursion
/// needs boxing.
async fn collect_files(client: &reqwest::Client) -> Result<Vec<ModelFile>, String> {
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut pending = vec![HF_FOLDER.to_string()];

    while let Some(folder) = pending.pop() {
        let entries = list_tree(client, &folder).await?;
        for entry in &entries {
            let rel = relative_to_folder(&entry.path);
            if is_skipped(rel) {
                continue;
            }
            match entry.kind.as_str() {
                "file" => {
                    if !is_safe_relative_path(rel) {
                        return Err(format!("Refusing unsafe path in tree listing: {rel}"));
                    }
                    if seen.insert(entry.path.clone()) {
                        files.push(ModelFile {
                            rel: rel.to_string(),
                            size: entry.size,
                        });
                    }
                }
                "directory" => {
                    let prefix = format!("{}/", entry.path);
                    let expanded = entries
                        .iter()
                        .any(|e| e.kind == "file" && e.path.starts_with(&prefix));
                    if !expanded {
                        pending.push(entry.path.clone());
                    }
                }
                _ => {}
            }
        }
    }

    if files.is_empty() {
        return Err("Tree listing returned no files".into());
    }
    Ok(files)
}

/// Stream the whole model into app-data. Each file is written to a `.part`
/// sibling and renamed on completion, so an interrupted download never
/// masquerades as an installed file, and a file whose size already matches
/// the listing is skipped so a retry resumes where it left off.
#[tauri::command]
pub async fn download_bark_model(app: AppHandle) -> Result<BarkModelStatus, String> {
    if DOWNLOAD_ACTIVE.swap(true, Ordering::SeqCst) {
        return Err("A model download is already in progress".into());
    }
    DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst);

    let result = download_inner(&app).await;
    DOWNLOAD_ACTIVE.store(false, Ordering::SeqCst);
    result
}

/// Cumulative progress shared across the per-file downloads.
struct Progress<'a> {
    app: &'a AppHandle,
    downloaded: u64,
    total: u64,
    last_emit: u64,
}

impl Progress<'_> {
    fn emit(&mut self, filename: &str) {
        self.last_emit = self.downloaded;
        let _ = self.app.emit(
            PROGRESS_EVENT,
            DownloadProgress {
                filename: filename.to_string(),
                downloaded: self.downloaded,
                total: Some(self.total),
            },
        );
    }

    /// Emit at most every ~2 MB: plenty for a progress bar, keeps event
    /// volume low.
    fn maybe_emit(&mut self, filename: &str) {
        if self.downloaded - self.last_emit >= 2 * 1024 * 1024 {
            self.emit(filename);
        }
    }
}

async fn download_inner(app: &AppHandle) -> Result<BarkModelStatus, String> {
    let target_dir = app_data_model_dir(app)?;
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let client = reqwest::Client::new();
    let files = collect_files(&client).await?;
    let total: u64 = files.iter().map(|f| f.size).sum();
    log::info!(
        "[BARK-DL] Downloading {} files ({total} bytes) -> {}",
        files.len(),
        target_dir.display()
    );

    let mut progress = Progress {
        app,
        downloaded: 0,
        total,
        last_emit: 0,
    };
    for file in &files {
        if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
            log::info!("[BARK-DL] Cancelled");
            return Err("Download cancelled".into());
        }
        download_file(&client, &target_dir, file, &mut progress).await?;
    }

    progress.downloaded = total;
    progress.emit("");
    log::info!(
        "[BARK-DL] Completed: {} ({total} bytes)",
        target_dir.display()
    );

    let status = status_for(app);
    if status.installed {
        Ok(status)
    } else {
        Err("Download finished but the model directory is incomplete".into())
    }
}

async fn download_file(
    client: &reqwest::Client,
    target_dir: &Path,
    file: &ModelFile,
    progress: &mut Progress<'_>,
) -> Result<(), String> {
    let dest = target_dir.join(&file.rel);

    if let Ok(m) = std::fs::metadata(&dest) {
        if m.is_file() && m.len() == file.size {
            progress.downloaded += file.size;
            progress.emit(&file.rel);
            return Ok(());
        }
    }

    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let part_name = dest
        .file_name()
        .map(|n| format!("{}.part", n.to_string_lossy()))
        .ok_or_else(|| format!("Invalid file path: {}", file.rel))?;
    let part = dest.with_file_name(part_name);

    let url = format!("{RESOLVE_URL}/{HF_FOLDER}/{}", file.rel);
    log::info!("[BARK-DL] Downloading {url} -> {}", dest.display());

    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Download failed for {}: HTTP {}",
            file.rel,
            response.status()
        ));
    }
    let expected = response.content_length().unwrap_or(file.size);

    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut written: u64 = 0;

    while let Some(chunk) = stream.next().await {
        if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
            drop(out);
            let _ = std::fs::remove_file(&part);
            log::info!(
                "[BARK-DL] Cancelled; removed partial file {}",
                part.display()
            );
            return Err("Download cancelled".into());
        }
        let chunk = chunk.map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut out, &chunk).map_err(|e| e.to_string())?;
        written += chunk.len() as u64;
        progress.downloaded += chunk.len() as u64;
        progress.maybe_emit(&file.rel);
    }
    drop(out);

    if written != expected {
        let _ = std::fs::remove_file(&part);
        return Err(format!(
            "Download incomplete for {}: got {written} of {expected} bytes",
            file.rel
        ));
    }

    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    progress.emit(&file.rel);
    Ok(())
}

#[tauri::command]
pub fn cancel_bark_download() {
    DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
}

/// Remove the model downloaded into app-data (bundled/dev copies are never
/// touched).
#[tauri::command]
pub fn delete_bark_model(app: AppHandle) -> Result<(), String> {
    let dir = app_data_model_dir(&app)?;
    if !dir.is_dir() {
        return Err("Model is not installed in app data".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_to_folder_strips_repo_prefix() {
        assert_eq!(
            relative_to_folder("bark-3.0/Encoder.mlmodelc/weights/weight.bin"),
            "Encoder.mlmodelc/weights/weight.bin"
        );
        assert_eq!(relative_to_folder("bark-3.0/NOTICE"), "NOTICE");
        assert_eq!(relative_to_folder("NOTICE"), "NOTICE");
        assert_eq!(relative_to_folder("bark-3.0-clean/x"), "bark-3.0-clean/x");
    }

    #[test]
    fn skips_the_gpu_encoder_variant_only() {
        assert!(is_skipped("Encoder_lut3.mlmodelc"));
        assert!(is_skipped("Encoder_lut3.mlmodelc/weights/weight.bin"));
        assert!(!is_skipped("Encoder.mlmodelc/weights/weight.bin"));
        assert!(!is_skipped("parakeet_vocab.json"));
    }

    #[test]
    fn rejects_unsafe_listing_paths() {
        assert!(is_safe_relative_path("Encoder.mlmodelc/model.mil"));
        assert!(!is_safe_relative_path(""));
        assert!(!is_safe_relative_path("../escape"));
        assert!(!is_safe_relative_path("/abs/path"));
        assert!(!is_safe_relative_path("a/../b"));
    }

    #[test]
    fn installed_requires_every_entry() {
        let dir = std::env::temp_dir().join(format!("bark-model-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_installed(&dir));
        // The .mlmodelc directories alone (what an interrupted download
        // leaves behind) must not count.
        for entry in REQUIRED_ENTRIES {
            if let Some(parent) = Path::new(entry).parent() {
                std::fs::create_dir_all(dir.join(parent)).unwrap();
            }
        }
        assert!(!is_installed(&dir));
        for entry in REQUIRED_ENTRIES {
            std::fs::write(dir.join(entry), b"x").unwrap();
        }
        assert!(is_installed(&dir));
        assert_eq!(dir_size(&dir), REQUIRED_ENTRIES.len() as u64);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
