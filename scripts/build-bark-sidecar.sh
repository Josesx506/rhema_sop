#!/usr/bin/env bash
# Builds the Bark STT sidecar (Swift + FluidAudio) in release mode for Apple
# Silicon and copies it to src-tauri/binaries/ under the target-triple name
# that Tauri's externalBin bundling expects.
#
# Usage: scripts/build-bark-sidecar.sh
# Requires: macOS, Swift 6 toolchain (Xcode 16+ or swift.org 6.x).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/src-tauri/sidecars/bark-sidecar"
out_dir="$repo_root/src-tauri/binaries"
out_name="bark-sidecar-aarch64-apple-darwin"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: the Bark sidecar can only be built on macOS" >&2
  exit 1
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "error: swift not found on PATH. Install Xcode 16+ or a Swift 6 toolchain from swift.org" >&2
  exit 1
fi

version_line="$(swift --version 2>&1 | head -n 1)"
# Matches both "Apple Swift version 6.0.2" and "Swift version 6.1".
swift_major="$(printf '%s\n' "$version_line" | sed -nE 's/.*Swift version ([0-9]+)\.[0-9]+.*/\1/p')"
if [[ -z "$swift_major" ]]; then
  echo "error: could not parse the Swift version from: $version_line" >&2
  exit 1
fi
if (( swift_major < 6 )); then
  echo "error: Swift 6 or later is required to build the Bark sidecar (FluidAudio is a swift-tools-version 6.0 package)." >&2
  echo "       Found: $version_line" >&2
  echo "       Install Xcode 16+ and run 'sudo xcode-select -s /Applications/Xcode.app', or install a 6.x toolchain from https://www.swift.org/install/" >&2
  exit 1
fi

echo "Building bark-sidecar with: $version_line"
cd "$package_dir"
swift build -c release --arch arm64

bin_path="$(swift build -c release --arch arm64 --show-bin-path)/bark-sidecar"
if [[ ! -x "$bin_path" ]]; then
  echo "error: expected binary not found at $bin_path" >&2
  exit 1
fi

mkdir -p "$out_dir"
cp "$bin_path" "$out_dir/$out_name"
chmod +x "$out_dir/$out_name"
echo "Copied sidecar to $out_dir/$out_name"
