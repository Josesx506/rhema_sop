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
 * - Render with `canvasContext` ONLY (canvas must not be passed): pdf.js
 *   v6's preferred `canvas` param renders via OffscreenCanvas in the
 *   worker, which deadlocks WKWebView — a real deck froze at 2/11 pages.
 *   Same reason `isOffscreenCanvasSupported: false` is set on getDocument.
 * - Pages render serially. The pdf.js worker pipelines parsing internally,
 *   and serial main-thread rasterization is fast once the REAL worker is
 *   loaded — the `?url` import below guarantees the worker URL resolves in
 *   both dev and build, so pdf.js never falls back to its main-thread
 *   "fake worker" (the original cause of slow imports).
 */

import { open } from "@tauri-apps/plugin-dialog"
import { readFile } from "@tauri-apps/plugin-fs"
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"

/** Longest side of a rendered page image, in pixels. */
const MAX_SIDE = 1920

/** A page render that makes no progress fails loudly instead of hanging. */
const PAGE_RENDER_TIMEOUT_MS = 30_000

export interface ImportedDeck {
  name: string
  pages: string[]
}

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

/**
 * Opens a native "pick a PDF" dialog, reads it, and renders every page to a
 * JPEG data URL sized for broadcast (longest side scaled to MAX_SIDE).
 * Returns null if the user cancels the dialog.
 *
 * `onProgress`, when given, is invoked after each page finishes rendering
 * with (pages done so far, total pages).
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

  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs")
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

    const doc = await withTimeout(
      pdfjsLib.getDocument({
        data: bytes,
        // WKWebView hardening (see header comment): keep rendering on the
        // classic main-thread canvas path, decode images with the JS
        // fallbacks instead of the wasm decoders (observed to wedge the
        // worker on the first image-heavy page — "page 2/4 timed out"),
        // and fetch auxiliary data from the main thread, not the worker.
        isOffscreenCanvasSupported: false,
        useWasm: false,
        useWorkerFetch: false,
      }).promise,
      PAGE_RENDER_TIMEOUT_MS,
      "Opening the PDF"
    )
    const total = doc.numPages
    if (total === 0) {
      throw new Error(`"${name}.pdf" has no pages`)
    }

    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const baseViewport = page.getViewport({ scale: 1 })
      const longestSide = Math.max(baseViewport.width, baseViewport.height)
      const scale = MAX_SIDE / longestSide
      const viewport = page.getViewport({ scale })

      const canvas = document.createElement("canvas")
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const context = canvas.getContext("2d")
      if (!context) {
        throw new Error("Could not create a 2D canvas context to render the PDF")
      }

      await withTimeout(
        page.render({ canvas: null, canvasContext: context, viewport }).promise,
        PAGE_RENDER_TIMEOUT_MS,
        `Rendering page ${pageNumber}/${total}`
      )
      pages.push(canvas.toDataURL("image/jpeg", 0.85))
      // No per-page cleanup() here: it resets font/image state shared
      // across pages and can wedge the worker between renders. The
      // loadingTask.destroy() below frees everything at once.
      onProgress?.(pageNumber, total)
    }

    // Free worker-side parsing state; the rendered JPEGs are all we keep.
    void doc.loadingTask.destroy()
    return { name, pages }
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Failed to import "${name}.pdf": ${err.message}`)
    }
    throw new Error(`Failed to import "${name}.pdf": ${String(err)}`)
  }
}
