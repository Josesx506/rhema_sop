/**
 * PDF → slide deck import (fork-owned, slides module).
 *
 * PDF is the only supported import format for slide decks: PowerPoint,
 * Keynote and Canva all export to PDF, so we render every page to a
 * broadcast-ready image in-app with pdfjs-dist rather than shelling out to
 * a native converter. Decks are session-only — nothing here touches disk
 * beyond the one-time read of the picked file.
 *
 * WKWebView compatibility notes (hard-won):
 * - The LEGACY pdfjs build, deliberately: the modern build uses ES2025
 *   iterator helpers (the `Iterator` global) that WKWebView on macOS 14
 *   lacks — imports fail with "Can't find variable: Iterator".
 * - Render with `canvas: null` + `canvasContext`: pdf.js v6's preferred
 *   `canvas` param renders via OffscreenCanvas in the worker, which
 *   deadlocks WKWebView. Same reason for isOffscreenCanvasSupported: false,
 *   useWasm: false (wasm image decoding wedged the worker on the first
 *   image-heavy page), and useWorkerFetch: false.
 * - NO WEB WORKER AT ALL: WKWebView's worker message channel proved broken
 *   for pdf.js font/glyph traffic — the first text-heavy page either
 *   wedged the render or "succeeded" instantly with every glyph silently
 *   dropped. Importing the worker module into the main thread makes pdf.js
 *   run in-process (globalThis.pdfjsWorker), removing the channel entirely.
 *   Watchdogs and the fresh-document-per-page retry are kept as generic
 *   safety nets.
 * - getDocument({data}) can transfer/detach the buffer, so every
 *   getDocument call gets its own copy of the bytes.
 *
 * Progress is instrumented via console.warn so it lands in the exported
 * diagnostic log (console-to-log forwards warn/error only).
 */

import { open } from "@tauri-apps/plugin-dialog"
import { readFile } from "@tauri-apps/plugin-fs"

/** Longest side of a rendered page image, in pixels. */
const MAX_SIDE = 1920

/** Opening a document (includes worker boot + parse) gets a generous cap. */
const DOC_OPEN_TIMEOUT_MS = 30_000
/** Page renders normally finish well under a second; a stalled one should
 * trip the fallback quickly rather than sit on a 30s watchdog. */
const PAGE_RENDER_TIMEOUT_MS = 10_000

export interface ImportedDeck {
  name: string
  pages: string[]
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs")

const log = (msg: string) => console.warn(`[pdf-import] ${msg}`)

function basename(path: string): string {
  const withoutDir = path.split(/[\\/]/).pop() ?? path
  return withoutDir.replace(/\.pdf$/i, "")
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms / 1000}s`)),
      ms
    )
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

const DOC_OPTIONS = {
  isOffscreenCanvasSupported: false,
  useWasm: false,
  useWorkerFetch: false,
  // Draw glyphs as vector paths on the canvas instead of installing fonts
  // via the FontFace API and using fillText. WKWebView's font install can
  // silently fail, which paints every run of text as NOTHING — images and
  // backgrounds render, text vanishes. Path rendering bypasses browser
  // font machinery entirely.
  disableFontFace: true,
  // Served by vite-plugin-static-copy (see vite.config.ts). Without the
  // standard-font pack, text set in non-embedded fonts renders blank.
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
} as const

// One reusable canvas: WKWebView is stingy with canvas backing memory, and
// discarded per-page canvases are freed lazily.
let sharedCanvas: HTMLCanvasElement | null = null

async function renderPageToDataUrl(
  page: import("pdfjs-dist/legacy/build/pdf.mjs").PDFPageProxy,
  label: string
): Promise<string> {
  const baseViewport = page.getViewport({ scale: 1 })
  const longestSide = Math.max(baseViewport.width, baseViewport.height)
  const viewport = page.getViewport({ scale: MAX_SIDE / longestSide })

  sharedCanvas ??= document.createElement("canvas")
  const canvas = sharedCanvas
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  const context = canvas.getContext("2d")
  if (!context) {
    throw new Error("Could not create a 2D canvas context to render the PDF")
  }

  // Pre-fill white: pages without an explicit background render onto a
  // transparent canvas, and JPEG has no alpha — transparency encodes as
  // BLACK. The render background param covers pdf.js's own fill; this
  // covers any region the page never touches.
  context.fillStyle = "#FFFFFF"
  context.fillRect(0, 0, canvas.width, canvas.height)

  const started = performance.now()
  await withTimeout(
    page.render({
      canvas: null,
      canvasContext: context,
      viewport,
      background: "#FFFFFF",
    }).promise,
    PAGE_RENDER_TIMEOUT_MS,
    label
  )
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85)
  log(`${label} ok in ${Math.round(performance.now() - started)}ms`)
  return dataUrl
}

/** Fast path: one document / one worker for every page. */
async function renderAllPagesSharedDoc(
  pdfjsLib: PdfJs,
  bytes: Uint8Array,
  onProgress?: (done: number, total: number) => void
): Promise<string[]> {
  const doc = await withTimeout(
    pdfjsLib.getDocument({ data: bytes.slice(), ...DOC_OPTIONS }).promise,
    DOC_OPEN_TIMEOUT_MS,
    "Opening the PDF"
  )
  log(`document opened: ${doc.numPages} pages`)
  try {
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await withTimeout(
        doc.getPage(pageNumber),
        PAGE_RENDER_TIMEOUT_MS,
        `Loading page ${pageNumber}/${doc.numPages}`
      )
      pages.push(
        await renderPageToDataUrl(page, `Rendering page ${pageNumber}/${doc.numPages}`)
      )
      onProgress?.(pageNumber, doc.numPages)
    }
    return pages
  } finally {
    void doc.loadingTask.destroy().catch(() => {})
  }
}

/**
 * Fallback: a fresh document (and therefore a fresh worker) per page.
 * Slower, but a worker that wedges after its first render can't stall the
 * whole import — each page gets a brand-new one.
 */
async function renderAllPagesFreshDocPerPage(
  pdfjsLib: PdfJs,
  bytes: Uint8Array,
  onProgress?: (done: number, total: number) => void
): Promise<string[]> {
  log("falling back to fresh-worker-per-page mode")
  const probe = await withTimeout(
    pdfjsLib.getDocument({ data: bytes.slice(), ...DOC_OPTIONS }).promise,
    DOC_OPEN_TIMEOUT_MS,
    "Opening the PDF (fallback)"
  )
  const total = probe.numPages
  void probe.loadingTask.destroy().catch(() => {})

  const pages: string[] = []
  for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
    const doc = await withTimeout(
      pdfjsLib.getDocument({ data: bytes.slice(), ...DOC_OPTIONS }).promise,
      DOC_OPEN_TIMEOUT_MS,
      `Reopening the PDF for page ${pageNumber}/${total}`
    )
    try {
      const page = await withTimeout(
        doc.getPage(pageNumber),
        PAGE_RENDER_TIMEOUT_MS,
        `Loading page ${pageNumber}/${total} (fallback)`
      )
      pages.push(
        await renderPageToDataUrl(
          page,
          `Rendering page ${pageNumber}/${total} (fallback)`
        )
      )
      onProgress?.(pageNumber, total)
    } finally {
      void doc.loadingTask.destroy().catch(() => {})
    }
  }
  return pages
}

/**
 * Opens a native "pick a PDF" dialog, reads it, and renders every page to a
 * JPEG data URL sized for broadcast (longest side scaled to MAX_SIDE).
 * Returns null if the user cancels the dialog.
 */
export async function importPdfDeck(
  onProgress?: (done: number, total: number) => void
): Promise<ImportedDeck | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  })
  if (!selected) return null

  const path = selected
  const name = basename(path)

  let bytes: Uint8Array
  try {
    bytes = await readFile(path)
  } catch (err) {
    throw new Error(`Could not read "${name}.pdf": ${String(err)}`)
  }
  log(`"${name}.pdf" read: ${bytes.length} bytes`)

  // pdf.js reports its internal problems (font load failures, missing
  // glyphs, bad cmaps) via console.log, which console-to-log deliberately
  // drops. Bridge log→warn for the duration of the import so those
  // diagnostics land in the exported log file.
  const originalConsoleLog = console.log.bind(console)
  console.log = (...args: unknown[]) => {
    originalConsoleLog(...args)
    console.warn("[pdfjs]", ...args)
  }

  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs")
    // NO Worker at all: importing the worker module into the MAIN thread
    // makes pdf.js run everything in-process (it checks
    // globalThis.pdfjsWorker before ever constructing a Worker). WKWebView's
    // worker message channel proved broken for font/glyph traffic — the
    // first text-heavy page either wedged the render (fast-path hangs) or
    // "rendered" instantly with every glyph silently dropped. With no
    // channel there is nothing to wedge and nothing to drop.
    await import("pdfjs-dist/legacy/build/pdf.worker.mjs")
    // Pipeline version marker: proves in exported logs WHICH import code a
    // session ran (session decks imported by older code look broken even
    // after an update until the app restarts and the deck is reimported).
    log(
      `pipeline v5 (main-thread, glyph paths, white-bg, font-pack) — pdfjs ${pdfjsLib.version ?? "?"}, fake worker: ${Boolean((globalThis as Record<string, unknown>).pdfjsWorker)}`
    )

    try {
      return { name, pages: await renderAllPagesSharedDoc(pdfjsLib, bytes, onProgress) }
    } catch (err) {
      // A stall in the shared-worker fast path is the known WKWebView
      // failure mode — retry with an isolated worker per page before
      // giving up. Other errors (corrupt file, etc.) also get one retry;
      // harmless, and it keeps the recovery logic simple.
      console.error(`[pdf-import] fast path failed: ${String(err)}`)
      return {
        name,
        pages: await renderAllPagesFreshDocPerPage(pdfjsLib, bytes, onProgress),
      }
    }
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Failed to import "${name}.pdf": ${err.message}`)
    }
    throw new Error(`Failed to import "${name}.pdf": ${String(err)}`)
  } finally {
    console.log = originalConsoleLog
  }
}
