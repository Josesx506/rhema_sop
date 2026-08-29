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
 * Returns null if the user cancels the dialog.
 */
export async function importPdfDeck(): Promise<ImportedDeck | null> {
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
    const pages: string[] = []

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
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
      pages.push(canvas.toDataURL("image/jpeg", 0.85))
    }

    if (pages.length === 0) {
      throw new Error(`"${name}.pdf" has no pages`)
    }

    return { name, pages }
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Failed to import "${name}.pdf": ${err.message}`)
    }
    throw new Error(`Failed to import "${name}.pdf": ${String(err)}`)
  }
}
