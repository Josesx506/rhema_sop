/**
 * Fork: local Bark model status + in-app downloader (macOS only).
 *
 * Shows in Settings -> Speech Recognition when the Bark provider is selected.
 * There is exactly one model (Underdog Bark 3.0, Core ML build from
 * FluidInference/bark-3.0-coreml), so unlike the Whisper section there is no
 * picker: just status, download with progress, cancel and delete. The model
 * is a directory of several files, so progress is cumulative across the
 * whole download and the current file name is shown alongside the bar.
 */
import { useCallback, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useTranscriptStore } from "@/stores/transcript-store"

/** Download size of the Core ML folder minus the skipped GPU-only encoder
 * (sum of the Hugging Face tree listing, see data/download-bark-model.ts --dry-run). */
const BARK_MODEL_SIZE_BYTES = 436_436_490

interface ModelStatus {
  installed: boolean
  location: "dev" | "app-data" | "bundled" | null
  path: string | null
  size_bytes: number | null
}

interface DownloadProgress {
  /** Path of the file currently being fetched, relative to the model folder. */
  filename: string
  /** Cumulative bytes for the whole model, not just the current file. */
  downloaded: number
  total: number | null
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/** Last path segment with its parent `.mlmodelc` folder, e.g. "Encoder.mlmodelc/weight.bin". */
function shortFileName(path: string): string {
  const parts = path.split("/").filter(Boolean)
  if (parts.length === 0) return path
  const file = parts[parts.length - 1]
  const model = parts.find((p) => p.endsWith(".mlmodelc"))
  return model && model !== file ? `${model}/${file}` : file
}

export function BarkModelSection() {
  const isTranscribing = useTranscriptStore((s) => s.isTranscribing)

  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)

  const refreshStatus = useCallback(() => {
    invoke<ModelStatus>("bark_model_status")
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    const unlisten = listen<DownloadProgress>("bark-download-progress", (e) => {
      setProgress(e.payload)
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [])

  const handleDownload = () => {
    setDownloading(true)
    setProgress(null)
    invoke<ModelStatus>("download_bark_model")
      .then((s) => {
        setStatus(s)
        toast.success("Bark model downloaded", {
          description: "Underdog Bark 3.0 (Core ML)",
        })
      })
      .catch((err) => {
        const msg = String(err)
        if (!msg.includes("cancelled")) {
          toast.error("Model download failed", { description: msg })
        }
        refreshStatus()
      })
      .finally(() => {
        setDownloading(false)
        setProgress(null)
      })
  }

  const handleCancel = () => {
    void invoke("cancel_bark_download")
  }

  const handleDelete = () => {
    invoke("delete_bark_model")
      .then(() => refreshStatus())
      .catch((err) => toast.error("Could not remove model", { description: String(err) }))
  }

  const pct =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Bark Model
        </label>
        {status?.installed && (
          <Badge variant="outline" className="text-[0.5rem]">
            Installed
            {status.location === "app-data" ? "" : ` (${status.location})`}
          </Badge>
        )}
      </div>

      <p className="text-[0.625rem] text-muted-foreground">
        Underdog Bark 3.0 (Core ML) · {formatMb(BARK_MODEL_SIZE_BYTES)}. English only,
        0.6B parameters, fine-tuned from NVIDIA Parakeet TDT v3.
      </p>

      {downloading ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${pct ?? 5}%` }}
              />
            </div>
            <span className="text-[0.625rem] tabular-nums text-muted-foreground">
              {progress ? formatMb(progress.downloaded) : "…"}
              {progress?.total ? ` / ${formatMb(progress.total)}` : ""}
            </span>
            <Button size="sm" variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
          <p className="truncate text-[0.625rem] text-muted-foreground">
            {progress ? shortFileName(progress.filename) : "Listing files…"}
          </p>
        </div>
      ) : status?.installed ? (
        <div className="flex items-center gap-2">
          <p className="flex-1 truncate text-[0.625rem] text-muted-foreground">
            {status.size_bytes ? `${formatMb(status.size_bytes)} · ` : ""}
            {status.path}
          </p>
          {status.location === "app-data" && (
            <Button size="sm" variant="ghost" onClick={handleDelete} disabled={isTranscribing}>
              Remove
            </Button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleDownload} disabled={isTranscribing}>
            Download model
          </Button>
          <p className="text-[0.625rem] text-muted-foreground">
            Downloads once from the FluidInference/bark-3.0-coreml repository on
            Hugging Face; needs internet only for the download.
          </p>
        </div>
      )}

      <p className="text-[0.625rem] text-muted-foreground">
        Developer builds also need the sidecar: run bun run build:bark-sidecar.
      </p>
    </div>
  )
}
