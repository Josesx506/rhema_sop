/**
 * Dedicated pdf.js worker with the ArrayBuffer.transfer polyfill loaded
 * FIRST (fork-owned). The stock pdf.js worker throws
 * "transferToFixedLength is not a function" on WKWebView/macOS 14 while
 * building page operator lists, silently dropping all text ops — the
 * polyfill must exist inside the worker's own scope before pdf.js runs.
 *
 * Vite bundles this file (and its imports) into a self-contained module
 * worker; pdf-import.ts hands it to pdf.js via `new PDFWorker({ port })`.
 * The pdf.js worker module self-initializes its message handling when it
 * detects a worker scope.
 */
import "./arraybuffer-transfer-polyfill"
import "pdfjs-dist/legacy/build/pdf.worker.mjs"
