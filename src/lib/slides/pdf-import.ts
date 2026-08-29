/**
 * PDF → slide deck import (fork-owned, slides module).
 *
 * PDF is the only supported import format for slide decks: PowerPoint,
 * Keynote and Canva all export to PDF, so we render every page to a
 * broadcast-ready image in-app with pdfjs-dist rather than shelling out to
 * a native converter. Decks are session-only — nothing here touches disk
 * beyond the one-time read of the picked file.
 */

import { open } from "@tauri-apps/plugin-dialog"
import { readFile } from "@tauri-apps/plugin-fs"

/** Longest side of a rendered page image, in pixels. */
const MAX_SIDE = 1920

/** How many pages render concurrently. Keeps memory/CPU bounded while still
 * getting most of the parallelism win over rendering strictly serially. */
const RENDER_CONCURRENCY = 4

export interface ImportedDeck {
  name: string
  pages: string[]
}

function basename(path: string): string {
  const withoutDir = path.split(/[\\/]/).pop() ?? path
  return withoutDir.replace(/\.pdf$/i, "")
}

/**
 * Opens a native "pick a PDF" dialog, reads it, and renders every page to a
 * JPEG data URL sized for broadcast (longest side scaled to MAX_SIDE).
 * Pages render concurrently (small worker pool) rather than one at a time,
 * which is the difference between a large deck taking tens of seconds vs.
 * only a few — but the returned `pages` array is still in page order.
 * Returns null if the user cancels the dialog.
 *
 * `onProgress`, when given, is invoked after each page finishes rendering
 * with (pages done so far, total pages) — pages may complete out of order
 * under concurrency, so this is a count, not necessarily the page number.
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
    // The legacy build, deliberately: the modern build uses ES2025 iterator
    // helpers (the `Iterator` global), which WKWebView's engine on macOS 14
    // doesn't have — imports fail with "Can't find variable: Iterator".
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs")
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString()

    const doc = await pdfjsLib.getDocument({ data: bytes }).promise
    const total = doc.numPages
    if (total === 0) {
      throw new Error(`"${name}.pdf" has no pages`)
    }

    // Page order must survive concurrency: each worker writes its result
    // into its own page's slot rather than pushing, so `pages` comes out in
    // page order no matter which page finishes rendering first.
    const pages: string[] = new Array(total)
    let done = 0
    let nextPageNumber = 1

    async function renderOnePage(pageNumber: number): Promise<void> {
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

      await page.render({ canvas, canvasContext: context, viewport }).promise
      pages[pageNumber - 1] = canvas.toDataURL("image/jpeg", 0.85)
      done += 1
      onProgress?.(done, total)
    }

    async function worker(): Promise<void> {
      while (nextPageNumber <= total) {
        const pageNumber = nextPageNumber
        nextPageNumber += 1
        await renderOnePage(pageNumber)
      }
    }

    const workerCount = Math.min(RENDER_CONCURRENCY, total)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    return { name, pages }
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Failed to import "${name}.pdf": ${err.message}`)
    }
    throw new Error(`Failed to import "${name}.pdf": ${String(err)}`)
  }
}
