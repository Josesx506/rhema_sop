/**
 * Fork: canvas sample switcher for the theme designer toolbar.
 * Verse = one short scripture line; Song = a six-line lyric block. Designing
 * against both is what keeps a layout from shrinking lyrics on the output.
 */
import { cn } from "@/lib/utils"
import {
  usePreviewSample,
  type PreviewSampleKind,
} from "@/lib/theme-designer-preview"

const OPTIONS: { kind: PreviewSampleKind; label: string; title: string }[] = [
  {
    kind: "verse",
    label: "Verse",
    title: "Preview with a one-line scripture verse",
  },
  {
    kind: "song",
    label: "Song",
    title: "Preview with a six-line song block — check lyrics still fit",
  },
]

export function PreviewSampleToggle() {
  const kind = usePreviewSample((s) => s.kind)
  const setKind = usePreviewSample((s) => s.setKind)

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border/40 p-0.5">
      {OPTIONS.map((option) => (
        <button
          key={option.kind}
          type="button"
          title={option.title}
          onClick={() => setKind(option.kind)}
          className={cn(
            "rounded px-1.5 py-0.5 text-[0.625rem] font-medium transition-colors",
            kind === option.kind
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
