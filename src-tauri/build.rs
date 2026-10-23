use std::path::Path;

/// Fork: the macOS bundle ships the Bark STT sidecar as a Tauri `externalBin`
/// (`tauri.macos.conf.json`), and tauri-build refuses to compile the app crate
/// while that file is missing. Building the real sidecar needs a Swift 6
/// toolchain, so on a Mac without one every `cargo` build would fail. Stand
/// in a tiny executable placeholder that speaks just enough of the sidecar
/// protocol to say why it is a placeholder; the Bark provider surfaces that
/// message when the user selects Bark. `scripts/build-bark-sidecar.sh`
/// overwrites it with the real binary.
const PLACEHOLDER_MARKER: &str = "# rhema: placeholder written by src-tauri/build.rs";

fn ensure_bark_sidecar_placeholder() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let (Ok(target), Ok(manifest_dir)) =
        (std::env::var("TARGET"), std::env::var("CARGO_MANIFEST_DIR"))
    else {
        return;
    };
    let path = Path::new(&manifest_dir)
        .join("binaries")
        .join(format!("bark-sidecar-{target}"));

    if path.exists() {
        let is_placeholder = std::fs::read_to_string(&path)
            .is_ok_and(|contents| contents.contains(PLACEHOLDER_MARKER));
        if is_placeholder {
            println!(
                "cargo:warning=Bark sidecar is a placeholder at {}. Run: bun run build:bark-sidecar",
                path.display()
            );
        }
        return;
    }

    let script = format!(
        "#!/bin/sh\n{PLACEHOLDER_MARKER}\n\
         printf '%s\\n' '{{\"type\":\"error\",\"id\":0,\"message\":\"Bark sidecar not built. Run: bun run build:bark-sidecar\"}}'\n\
         exit 1\n"
    );
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&path, script))
        .and_then(|()| set_executable(&path));
    match written {
        Ok(()) => println!(
            "cargo:warning=Bark sidecar not built; wrote a placeholder at {}. Run: bun run build:bark-sidecar",
            path.display()
        ),
        Err(e) => println!(
            "cargo:warning=Could not write the Bark sidecar placeholder at {}: {e}",
            path.display()
        ),
    }
}

#[cfg(unix)]
fn set_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn main() {
    ensure_bark_sidecar_placeholder();
    tauri_build::build();
}
