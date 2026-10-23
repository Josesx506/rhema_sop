/**
 * Fork: coarse platform detection for the webview.
 *
 * There is no `@tauri-apps/plugin-os` in this project, and the user agent is
 * enough to decide whether to offer macOS-only features such as the local
 * Bark STT provider. Guarded so the module also loads under vitest, where
 * `navigator` may be missing or a stub.
 */
export const isMacOS: boolean =
  typeof navigator !== "undefined" &&
  typeof navigator.userAgent === "string" &&
  navigator.userAgent.includes("Mac OS")
