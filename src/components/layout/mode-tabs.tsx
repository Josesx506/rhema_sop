import { cn } from "@/lib/utils"
import { useAppModeStore, type AppMode } from "@/stores/app-mode-store"

const MODES: { id: AppMode; label: string }[] = [
  { id: "scripture", label: "Scripture" },
  { id: "songs", label: "Songs" },
  { id: "presentation", label: "Presentation" },
]

/** Top-level mode switcher (fork feature — songs / slides / media). */
export function ModeTabs() {
  const mode = useAppModeStore((s) => s.mode)
  const setMode = useAppModeStore((s) => s.setMode)

  return (
    <div data-tour="mode-tabs" className="flex items-center gap-1 px-3">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => setMode(m.id)}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium uppercase tracking-wider transition-colors",
            mode === m.id
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}
