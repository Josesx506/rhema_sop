/**
 * Fork: local Whisper model picker + in-app downloader.
 *
 * Shows in Settings → Speech Recognition when the Whisper provider is
 * selected. Lets the operator choose a model size and download it straight
 * from the official whisper.cpp Hugging Face repo into app-data — no bun,
 * no manual file placement — so a machine the app was merely installed on
 * can get local STT working.
 */
import { useCallback, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsStore } from "@/stores"
import { useTranscriptStore } from "@/stores/transcript-store"

interface WhisperModelOption {
  file: string
  label: string
  description: string
}

/** Curated ggml builds from ggerganov/whisper.cpp (files + sizes verified). */
const WHISPER_MODELS: WhisperModelOption[] = [
  {
    file: "ggml-tiny.en-q8_0.bin",
    label: "Tiny (English) · 42 MB",
    description: "Fastest, least accurate — for very slow machines.",
  },
  {
    file: "ggml-base.en-q8_0.bin",
    label: "Base (English) · 78 MB",
    description: "Fast with modest accuracy.",
  },
  {
    file: "ggml-small.en-q8_0.bin",
    label: "Small (English) · 252 MB",
    description: "Good balance for a typical desktop PC.",
  },
  {
    file: "ggml-medium.en-q5_0.bin",
    label: "Medium (English) · 514 MB",
    description: "High accuracy; needs a reasonably fast CPU.",
  },
  {
    file: "ggml-large-v3-turbo-q8_0.bin",
    label: "Large v3 Turbo · 834 MB",
    description: "Best accuracy, multilingual; needs a fast CPU.",
  },
]

interface ModelStatus {
  installed: boolean
  location: string | null
  path: string | null
  size_bytes: number | null
}

interface DownloadProgress {
  filename: string
  downloaded: number
  total: number | null
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

export function WhisperModelSection() {
  const whisperModel = useSettingsStore((s) => s.whisperModel)
  const setWhisperModel = useSettingsStore((s) => s.setWhisperModel)
  const isTranscribing = useTranscriptStore((s) => s.isTranscribing)

  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)

  const refreshStatus = useCallback((filename: string) => {
    invoke<ModelStatus>("whisper_model_status", { filename })
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    refreshStatus(whisperModel)
  }, [whisperModel, refreshStatus])

  useEffect(() => {
    const unlisten = listen<DownloadProgress>("whisper-download-progress", (e) => {
      setProgress(e.payload)
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [])

  const handleDownload = () => {
    setDownloading(true)
    setProgress(null)
    invoke<ModelStatus>("download_whisper_model", { filename: whisperModel })
      .then((s) => {
        setStatus(s)
        toast.success("Whisper model downloaded", {
          description: WHISPER_MODELS.find((m) => m.file === whisperModel)?.label,
        })
      })
      .catch((err) => {
        const msg = String(err)
        if (!msg.includes("cancelled")) {
          toast.error("Model download failed", { description: msg })
        }
        refreshStatus(whisperModel)
      })
      .finally(() => {
        setDownloading(false)
        setProgress(null)
      })
  }

  const handleCancel = () => {
    void invoke("cancel_whisper_download")
  }

  const handleDelete = () => {
    invoke("delete_whisper_model", { filename: whisperModel })
      .then(() => refreshStatus(whisperModel))
      .catch((err) => toast.error("Could not remove model", { description: String(err) }))
  }

  const selected = WHISPER_MODELS.find((m) => m.file === whisperModel)
  const pct =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Whisper Model
        </label>
        {status?.installed && (
          <Badge variant="outline" className="text-[0.5rem]">
            Installed
            {status.location === "app-data" ? "" : ` (${status.location})`}
          </Badge>
        )}
      </div>

      <Select value={whisperModel} onValueChange={setWhisperModel} disabled={downloading || isTranscribing}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WHISPER_MODELS.map((m) => (
            <SelectItem key={m.file} value={m.file}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {selected && (
        <p className="text-[0.625rem] text-muted-foreground">{selected.description}</p>
      )}

      {downloading ? (
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
          <Button size="sm" onClick={handleDownload}>
            Download model
          </Button>
          <p className="text-[0.625rem] text-muted-foreground">
            Downloads once from the official whisper.cpp repository; needs
            internet only for the download.
          </p>
        </div>
      )}
    </div>
  )
}
