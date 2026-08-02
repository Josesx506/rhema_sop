import { useRef, useEffect, useState, useCallback, memo } from "react"
import { renderVerse } from "@/lib/verse-renderer"
import type { BroadcastTheme, VerseRenderData } from "@/types"
import { cn } from "@/lib/utils"

interface CanvasVerseProps {
  theme: BroadcastTheme
  verse: VerseRenderData | null
  className?: string
}

export const CanvasVerse = memo(function CanvasVerse({
  theme,
  verse,
  className,
}: CanvasVerseProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const [containerWidth, setContainerWidth] = useState(0)

  // Measure container width with ResizeObserver
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) setContainerWidth(w)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || containerWidth === 0) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const aspectRatio = theme.resolution.width / theme.resolution.height
    const displayW = containerWidth
    const displayH = displayW / aspectRatio

    canvas.width = displayW * dpr
    canvas.height = displayH * dpr
    canvas.style.width = `${displayW}px`
    canvas.style.height = `${displayH}px`

    ctx.scale(dpr, dpr)
    const scale = displayW / theme.resolution.width
    renderVerse(ctx, theme, verse, {
      scale,
      imageCache: imageCacheRef.current,
    })
  }, [theme, verse, containerWidth])

  // Preload background + logo overlay images so the renderer can find them in the cache.
  useEffect(() => {
    const cache = imageCacheRef.current
    const urls: string[] = []
    if (theme.background.type === "image" && theme.background.image?.url) {
      urls.push(theme.background.image.url)
    }
    if (theme.logoOverlay.enabled && theme.logoOverlay.image?.url) {
      urls.push(theme.logoOverlay.image.url)
    }

    for (const url of urls) {
      if (cache.has(url)) continue
      const img = new Image()
      img.onload = () => {
        cache.set(url, img)
        draw()
      }
      img.onerror = () => {
        console.warn("[canvas-verse] failed to load image", {
          url: url.slice(0, 100),
        })
      }
      img.src = url
    }
  }, [theme.background, theme.logoOverlay, draw])

  // Redraw whenever theme, verse, or container size changes.
  useEffect(() => {
    draw()
  }, [draw])

  return (
    <div ref={containerRef} className={cn("w-full", className)}>
      <canvas ref={canvasRef} className="w-full rounded-md" />
    </div>
  )
})
