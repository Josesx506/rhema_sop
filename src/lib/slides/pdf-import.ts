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
 * - Renders have repeatedly been seen to stall on the SECOND render call
 *   of a shared document/worker. Every page render carries a watchdog, and
 *   a timeout in the fast path triggers an automatic fallback that opens a
 *   FRESH document (fresh worker) per page — slower, but immune to a
 *   wedged worker.
 * - getDocument({data}) TRANSFERS the buffer to the worker (detaching it),
 *   so every getDocument call gets its own copy of the bytes.
 *
 * Progress is instrumented via console.warn so it lands in the exported
 * diagnostic log (console-to-log forwards warn/error only).
 */

import { open } from "@tauri-apps/plugin-dialog"
import { readFile } from "@tauri-apps/plugin-fs"
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"

/** Longest side of a rendered page image, in pixels. */
const MAX_SIDE = 1920

/** A step that makes no progress fails loudly instead of hanging. */
const PAGE_RENDER_TIMEOUT_MS = 30_000

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

  const started = performance.now()
  await withTimeout(
    page.render({ canvas: null, canvasContext: context, viewport }).promise,
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
    PAGE_RENDER_TIMEOUT_MS,
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
    PAGE_RENDER_TIMEOUT_MS,
    "Opening the PDF (fallback)"
  )
  const total = probe.numPages
  void probe.loadingTask.destroy().catch(() => {})

  const pages: string[] = []
  for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
    const doc = await withTimeout(
      pdfjsLib.getDocument({ data: bytes.slice(), ...DOC_OPTIONS }).promise,
      PAGE_RENDER_TIMEOUT_MS,
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

  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs")
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    log(`pdfjs ${pdfjsLib.version ?? "?"} loaded, worker: ${pdfWorkerUrl}`)

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
  }
}
