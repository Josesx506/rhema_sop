import { useBroadcastStore } from "@/stores/broadcast-store"
import { pickThemeBackgroundImage } from "@/lib/theme-designer-files"
import { Slider } from "@/components/ui/slider"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const FONT_FAMILIES = [
  "Geist Variable",
  "Source Serif 4 Variable",
  "Georgia",
  "Arial",
  "Helvetica",
  "Times New Roman",
  "Courier New",
]

const FONT_WEIGHTS = [
  { value: "100", label: "100 - Thin" },
  { value: "200", label: "200 - Extra Light" },
  { value: "300", label: "300 - Light" },
  { value: "400", label: "400 - Regular" },
  { value: "500", label: "500 - Medium" },
  { value: "600", label: "600 - Semi Bold" },
  { value: "700", label: "700 - Bold" },
  { value: "800", label: "800 - Extra Bold" },
  { value: "900", label: "900 - Black" },
]

const ANCHOR_OPTIONS = [
  { value: "top-left", label: "Top Left" },
  { value: "top-center", label: "Top Center" },
  { value: "top-right", label: "Top Right" },
  { value: "center", label: "Center" },
  { value: "bottom-left", label: "Bottom Left" },
  { value: "bottom-center", label: "Bottom Center" },
  { value: "bottom-right", label: "Bottom Right" },
] as const

const TEXT_TRANSFORM_OPTIONS = [
  { value: "none", label: "None" },
  { value: "uppercase", label: "Uppercase" },
  { value: "lowercase", label: "Lowercase" },
  { value: "capitalize", label: "Capitalize" },
] as const

function parseColorOpacity(color: string): { hex: string; opacity: number } {
  if (color.length === 9 && color.startsWith("#")) {
    const alphaHex = color.slice(7, 9)
    const alpha = parseInt(alphaHex, 16) / 255
    return { hex: color.slice(0, 7), opacity: Math.round(alpha * 100) }
  }
  if (color.length === 7 && color.startsWith("#")) {
    return { hex: color, opacity: 100 }
  }
  return { hex: color || "#ffffff", opacity: 100 }
}

function buildColorWithOpacity(hex: string, opacity: number): string {
  if (opacity >= 100) return hex
  const alphaHex = Math.round((opacity / 100) * 255)
    .toString(16)
    .padStart(2, "0")
  return `${hex}${alphaHex}`
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-0.5 pb-1">
      <h4 className="text-xs font-semibold">{title}</h4>
      <p className="text-[11px] text-muted-foreground">{description}</p>
    </div>
  )
}

export function LogoProperties() {
  const draftTheme = useBroadcastStore((s) => s.draftTheme)
  const update = useBroadcastStore((s) => s.updateDraftNested)

  if (!draftTheme) return null

  const overlay = draftTheme.logoOverlay
  const { hex: colorHex, opacity: colorOpacity } = parseColorOpacity(overlay.text.color)
  const textTransform = overlay.text.textTransform ?? "none"

  return (
    <div className="flex flex-col gap-3">
      <SectionHeader
        title="Logo Overlay"
        description="A persistent image + label, e.g. a ministry logo, shown regardless of the live verse"
      />

      {/* Enable */}
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold">Show Logo Overlay</label>
        <input
          type="checkbox"
          checked={overlay.enabled}
          onChange={(e) => update("logoOverlay.enabled", e.target.checked)}
          className="h-4 w-4 rounded border-input accent-primary"
        />
      </div>

      {overlay.enabled && (
        <>
          {/* Image */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Logo Image</label>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                void (async () => {
                  const dataUrl = await pickThemeBackgroundImage()
                  if (!dataUrl) return
                  update("logoOverlay.image", {
                    url: dataUrl,
                    width: overlay.image?.width ?? 90,
                    height: overlay.image?.height ?? 90,
                  })
                })()
              }}
            >
              Change Image
            </Button>
            {overlay.image?.url && (
              <img
                src={overlay.image.url}
                alt="Logo preview"
                className="h-16 w-16 self-start rounded border border-border object-contain"
              />
            )}
          </div>

          {/* Image size — only meaningful once an image is picked, since the
              slider writes into logoOverlay.image which starts out null */}
          {overlay.image && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Logo Size</label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {overlay.image.width}px
                </span>
              </div>
              <Slider
                min={24}
                max={400}
                step={2}
                value={[overlay.image.width]}
                onValueChange={([v]) => {
                  update("logoOverlay.image.width", v)
                  update("logoOverlay.image.height", v)
                }}
              />
            </div>
          )}

          {/* Anchor */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Position</label>
            <Select
              value={overlay.anchor}
              onValueChange={(v) => update("logoOverlay.anchor", v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANCHOR_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Offset X */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Offset X</label>
              <span className="text-xs tabular-nums text-muted-foreground">{overlay.offsetX}px</span>
            </div>
            <Slider
              min={-200}
              max={200}
              step={2}
              value={[overlay.offsetX]}
              onValueChange={([v]) => update("logoOverlay.offsetX", v)}
            />
          </div>

          {/* Offset Y */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Offset Y</label>
              <span className="text-xs tabular-nums text-muted-foreground">{overlay.offsetY}px</span>
            </div>
            <Slider
              min={-200}
              max={200}
              step={2}
              value={[overlay.offsetY]}
              onValueChange={([v]) => update("logoOverlay.offsetY", v)}
            />
          </div>

          {/* Gap between logo and text */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Gap to Text</label>
              <span className="text-xs tabular-nums text-muted-foreground">{overlay.gap}px</span>
            </div>
            <Slider
              min={0}
              max={100}
              step={1}
              value={[overlay.gap]}
              onValueChange={([v]) => update("logoOverlay.gap", v)}
            />
          </div>

          {/* Label text — font settings adjustable like verse text */}
          <div className="flex flex-col gap-3 border-t pt-3">
            <h4 className="text-xs font-semibold">Label Text</h4>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Text</label>
              <Input
                value={overlay.text.content}
                onChange={(e) => update("logoOverlay.text.content", e.target.value)}
                placeholder="Streams Of Praise"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Font Family</label>
              <Select
                value={overlay.text.fontFamily}
                onValueChange={(v) => update("logoOverlay.text.fontFamily", v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONT_FAMILIES.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Font Weight</label>
              <Select
                value={String(overlay.text.fontWeight)}
                onValueChange={(v) => update("logoOverlay.text.fontWeight", Number(v))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONT_WEIGHTS.map((w) => (
                    <SelectItem key={w.value} value={w.value}>
                      {w.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Font Size</label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {overlay.text.fontSize}px
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Slider
                  min={8}
                  max={120}
                  step={1}
                  value={[overlay.text.fontSize]}
                  onValueChange={([v]) => update("logoOverlay.text.fontSize", v)}
                  className="flex-1"
                />
                <Input
                  type="number"
                  min={8}
                  max={120}
                  value={overlay.text.fontSize}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (v >= 8 && v <= 120) update("logoOverlay.text.fontSize", v)
                  }}
                  className="w-16"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Letter Spacing</label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {overlay.text.letterSpacing}px
                </span>
              </div>
              <Slider
                min={-5}
                max={20}
                step={0.5}
                value={[overlay.text.letterSpacing]}
                onValueChange={([v]) => update("logoOverlay.text.letterSpacing", v)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Text Transform</label>
              <Select
                value={textTransform}
                onValueChange={(v) => update("logoOverlay.text.textTransform", v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEXT_TRANSFORM_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Text Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={colorHex}
                  onChange={(e) =>
                    update(
                      "logoOverlay.text.color",
                      buildColorWithOpacity(e.target.value, colorOpacity)
                    )
                  }
                  className="h-7 w-8 cursor-pointer rounded border border-input bg-transparent p-0.5"
                />
                <Input
                  value={colorHex}
                  onChange={(e) => {
                    const v = e.target.value
                    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                      update("logoOverlay.text.color", buildColorWithOpacity(v, colorOpacity))
                    }
                  }}
                  className="w-20 font-mono"
                />
              </div>
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Opacity</label>
                <span className="text-xs tabular-nums text-muted-foreground">{colorOpacity}%</span>
              </div>
              <Slider
                min={0}
                max={100}
                step={1}
                value={[colorOpacity]}
                onValueChange={([v]) =>
                  update("logoOverlay.text.color", buildColorWithOpacity(colorHex, v))
                }
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
