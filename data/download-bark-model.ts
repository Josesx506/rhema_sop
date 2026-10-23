/**
 * Downloads the Underdog Bark 3.0 Core ML model for local speech-to-text
 * (macOS only, Apple Neural Engine).
 *
 * Source: https://huggingface.co/FluidInference/bark-3.0-coreml, folder
 * `bark-3.0/` (the verbatim model; `bark-3.0-clean/` drops fillers and
 * repeated words and is deliberately not used).
 *
 * The folder is a tree of `.mlmodelc` directories, so this walks the Hugging
 * Face tree API and mirrors the structure under `models/bark/bark-3.0/`.
 * `Encoder_lut3.mlmodelc` (a 252 MB GPU-only encoder variant that FluidAudio's
 * `loadLocal` never reads) is skipped; the rest is about 437 MB.
 *
 * Mirrors the rules of the in-app downloader (src-tauri/src/commands/bark_model.rs):
 * a per-file temp file (`.tmp` here, `.part` in-app) renamed on completion,
 * and a file whose size already matches is skipped.
 *
 * Run: bun run download:bark
 *      bun run download:bark --dry-run   (list the files, download nothing)
 */

import { dirname, join } from "node:path"
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs"

const HF_REPO = "FluidInference/bark-3.0-coreml"
const HF_FOLDER = "bark-3.0"
const TREE_API = `https://huggingface.co/api/models/${HF_REPO}/tree/main`
const RESOLVE_URL = `https://huggingface.co/${HF_REPO}/resolve/main`
/** Top-level entries under the model folder that are never fetched. */
const SKIP_DIRS = new Set(["Encoder_lut3.mlmodelc"])

const PROJECT_ROOT = join(import.meta.dir, "..")
const MODEL_DIR = join(PROJECT_ROOT, "models", "bark", HF_FOLDER)

const DRY_RUN = process.argv.includes("--dry-run")

interface TreeEntry {
  type: "file" | "directory"
  path: string
  size?: number
}

interface ModelFile {
  /** Path relative to the model folder, e.g. `Encoder.mlmodelc/weights/weight.bin`. */
  rel: string
  size: number
}

/** Path of an entry relative to the model folder (the API returns repo-relative paths). */
function relativeToFolder(path: string): string {
  const prefix = `${HF_FOLDER}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function isSkipped(rel: string): boolean {
  const top = rel.split("/")[0]
  return SKIP_DIRS.has(top)
}

async function listTree(folder: string): Promise<TreeEntry[]> {
  const url = `${TREE_API}/${folder}?recursive=true`
  const response = await fetch(url, { headers: { Accept: "application/json" } })
  if (!response.ok) {
    throw new Error(`Tree listing failed for ${folder}: ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as TreeEntry[]
}

/**
 * Collect every file under the model folder. `recursive=true` expands the
 * whole subtree in one listing today (verified), but a directory whose files
 * are absent from the listing is walked on its own so a change in how deep
 * the API expands cannot silently drop part of the model.
 */
async function collectFiles(folder: string, seen = new Set<string>()): Promise<ModelFile[]> {
  const entries = await listTree(folder)
  const files: ModelFile[] = []
  const dirs: string[] = []

  for (const entry of entries) {
    if (entry.type === "file") {
      if (!seen.has(entry.path)) {
        seen.add(entry.path)
        files.push({ rel: relativeToFolder(entry.path), size: entry.size ?? 0 })
      }
    } else if (entry.type === "directory") {
      dirs.push(entry.path)
    }
  }

  for (const dir of dirs) {
    const prefix = `${dir}/`
    const expanded = entries.some((e) => e.type === "file" && e.path.startsWith(prefix))
    if (!expanded) {
      files.push(...(await collectFiles(dir, seen)))
    }
  }

  return files
}

function formatMb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(0)
}

async function downloadFile(file: ModelFile, index: number, count: number): Promise<void> {
  const dest = join(MODEL_DIR, file.rel)
  const label = `[${index + 1}/${count}] ${file.rel}`

  if (existsSync(dest) && statSync(dest).size === file.size) {
    console.log(`${label}: already present (${formatMb(file.size)} MB), skipping`)
    return
  }

  mkdirSync(dirname(dest), { recursive: true })

  const url = `${RESOLVE_URL}/${HF_FOLDER}/${file.rel}`
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) {
    throw new Error(`Download failed for ${file.rel}: ${response.status} ${response.statusText}`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error(`No response body for ${file.rel}`)

  const total = Number(response.headers.get("content-length") ?? file.size)
  const tmp = `${dest}.tmp`
  const writer = createWriteStream(tmp)

  let downloaded = 0
  let lastPercent = -1
  process.stdout.write(`${label} (${formatMb(total)} MB)`)

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    writer.write(Buffer.from(value))
    downloaded += value.byteLength

    const percent = total > 0 ? Math.floor((downloaded / total) * 100) : 0
    if (percent !== lastPercent && percent % 10 === 0) {
      process.stdout.write(`\r${label} (${formatMb(total)} MB): ${percent}%`)
      lastPercent = percent
    }
  }

  writer.end()
  await new Promise<void>((resolve, reject) => {
    writer.on("finish", resolve)
    writer.on("error", reject)
  })

  renameSync(tmp, dest)
  process.stdout.write(`\r${label} (${formatMb(total)} MB): done\n`)
}

async function main() {
  console.log(`Listing ${HF_REPO}/${HF_FOLDER} ...`)
  const all = await collectFiles(HF_FOLDER)
  const files = all
    .filter((f) => !isSkipped(f.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel))
  const skipped = all.filter((f) => isSkipped(f.rel))

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
  console.log(
    `${files.length} files, ${formatMb(totalBytes)} MB` +
      (skipped.length > 0
        ? ` (skipping ${skipped.length} files in ${[...SKIP_DIRS].join(", ")})`
        : "")
  )
  console.log(`Destination: ${MODEL_DIR}`)

  if (DRY_RUN) {
    for (const f of files) {
      console.log(`  ${f.rel.padEnd(48)} ${String(f.size).padStart(10)} bytes`)
    }
    console.log("Dry run: nothing downloaded.")
    return
  }

  mkdirSync(MODEL_DIR, { recursive: true })
  for (const [i, f] of files.entries()) {
    await downloadFile(f, i, files.length)
  }

  console.log(`\nBark model downloaded: ${MODEL_DIR}`)
}

main().catch((e) => {
  console.error("Failed to download Bark model:", e)
  process.exit(1)
})
