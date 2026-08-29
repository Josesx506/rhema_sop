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
 * - THE root cause of hangs and vanishing text was WKWebView (macOS 14)
 *   lacking ES2024 ArrayBuffer.transfer/transferToFixedLength, which the
 *   pdf.js worker calls while building page operator lists — the throw
 *   truncated every page's ops after the background/images, dropping all
 *   text, or wedged the render outright. The polyfill must live INSIDE
 *   the worker scope, so the primary path uses a dedicated worker built
 *   from pdf-worker-bootstrap.ts (polyfill first, then the pdf.js worker
 *   module). A worker-less main-thread mode remains as fallback, and
 *   watchdogs + the fresh-document-per-page retry stay as safety nets.
 * - getDocument({data}) can transfer/detach the buffer, so every
 *   getDocument call gets its own copy of the bytes.
 *
 * Progress is instrumented via console.warn so it lands in the exported
 * diagnostic log (console-to-log forwards warn/error only).
 */

import { open } from "@tauri-apps/plugin-dialog"
import { readFile } from "@tauri-apps/plugin-fs"
// MUST load before pdf.js: polyfills ArrayBuffer.transfer[ToFixedLength],
// whose absence in WKWebView (macOS 14) made pdf.js silently drop every
// text op ("TypeError: buffer.transferToFixedLength is not a function").
import "./arraybuffer-transfer-polyfill"

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
  // toBlob + FileReader instead of toDataURL: both encode on the main
  // thread, but the async API yields between steps so input events keep
  // flowing during image-heavy imports.
  const dataUrl = await new Promise<string>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("JPEG encoding failed"))
          return
        }
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error("JPEG encoding failed (read)"))
        reader.readAsDataURL(blob)
      },
      "image/jpeg",
      0.85
    )
  })
  log(`${label} ok in ${Math.round(performance.now() - started)}ms`)
  // Breathe: give the event loop a turn between pages so the UI stays
  // responsive even when rendering happens on the main thread (fallback).
  await new Promise((resolve) => setTimeout(resolve, 0))
  return dataUrl
}

/**
 * Primary path: a dedicated Worker built from pdf-worker-bootstrap.ts, so
 * the ArrayBuffer polyfill exists inside the worker scope and all parsing/
 * rasterization prep runs OFF the UI thread.
 */
async function renderAllPagesDedicatedWorker(
  pdfjsLib: PdfJs,
  bytes: Uint8Array,
  onProgress?: (done: number, total: number) => void
): Promise<string[]> {
  const workerThread = new Worker(
    new URL("./pdf-worker-bootstrap.ts", import.meta.url),
    { type: "module" }
  )
  // The runtime accepts a Worker as `port` (verified in the dist source:
  // `if (port) { ... #initializeFromPort(port) }`) — pdfjs-dist's
  // JSDoc-generated typings wrongly declare it `null | undefined`.
  const pdfWorker = new pdfjsLib.PDFWorker({
    port: workerThread as unknown as null,
  })
  try {
    const doc = await withTimeout(
      pdfjsLib.getDocument({ data: bytes.slice(), worker: pdfWorker, ...DOC_OPTIONS })
        .promise,
      DOC_OPEN_TIMEOUT_MS,
      "Opening the PDF"
    )
    log(`document opened: ${doc.numPages} pages (dedicated worker)`)
    try {
      const pages: string[] = []
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await withTimeout(
          doc.getPage(pageNumber),
          PAGE_RENDER_TIMEOUT_MS,
          `Loading page ${pageNumber}/${doc.numPages}`
        )
        pages.push(
          await renderPageToDataUrl(
            page,
            `Rendering page ${pageNumber}/${doc.numPages}`
          )
        )
        onProgress?.(pageNumber, doc.numPages)
      }
      return pages
    } finally {
      void doc.loadingTask.destroy().catch(() => {})
    }
  } finally {
    pdfWorker.destroy()
    workerThread.terminate()
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
    // Pipeline version marker: proves in exported logs WHICH import code a
    // session ran (session decks imported by older code look broken even
    // after an update until the app restarts and the deck is reimported).
    log(
      `pipeline v7 (dedicated polyfilled worker; main-thread fallback) — pdfjs ${pdfjsLib.version ?? "?"}`
    )

    try {
      // Primary: dedicated worker (bootstrap bundles the ArrayBuffer
      // polyfill into the worker scope) — rendering prep stays off the UI
      // thread, so image-heavy imports don't freeze the mouse.
      return {
        name,
        pages: await renderAllPagesDedicatedWorker(pdfjsLib, bytes, onProgress),
      }
    } catch (err) {
      // Fallback: worker-less main-thread mode (globalThis.pdfjsWorker) —
      // slower and jankier, but with no message channel there is nothing
      // left to fail the same way.
      console.error(`[pdf-import] dedicated worker path failed: ${String(err)}`)
      await import("pdfjs-dist/legacy/build/pdf.worker.mjs")
      log("fallback: main-thread (worker-less) mode")
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
