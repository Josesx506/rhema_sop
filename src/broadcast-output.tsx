import { createRoot } from "react-dom/client"
import { useRef, useEffect, useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"
import {
  computeVerseLayoutMetrics,
  onThemeFontsLoaded,
  renderVerse,
  type VerseLayoutRect,
} from "@/lib/verse-renderer"
import { preloadThemeImages, themeImageCache } from "@/lib/theme-image-cache"
import { normalizeTheme } from "@/lib/theme-migrations"
import { PresentationController } from "@/lib/presentation-output"
import {
  PRESENTATION_UPDATE_EVENT,
  type PresentationPayload,
} from "@/types/presentation"
import "./broadcast-fonts.css"
import type { BroadcastTheme, VerseRenderData } from "@/types/broadcast"
import type {
  NdiConfigEventPayload,
  NdiFrameRequest,
  OutputFadeTarget,
} from "@/types"

/** Convert Uint8Array/Uint8ClampedArray to base64 using Function.apply (avoids spread stack overflow) */
function uint8ToBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  const CHUNK = 0x8000 // 32KB — safe for Function.apply
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(
      String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + CHUNK) as unknown as number[],
      ),
    )
  }
  return btoa(parts.join(""))
}

/** Read output ID from URL query param (?output=main or ?output=alt). Defaults to "main". */
const OUTPUT_ID = new URLSearchParams(window.location.search).get("output") ?? "main"

interface BroadcastPayload {
  theme: BroadcastTheme
  verse: VerseRenderData | null
  idleFadeMs?: number
  /** Fork: what a faded-out output shows — black (default), the theme
   * background + logo with just the text gone, or nothing at all. See
   * OutputFadeTarget; the store picks "transparent" for every NDI output. */
  idleFadeTarget?: OutputFadeTarget
}

/** Fallback if a payload arrives without idleFadeMs (older event shape). Kept
 * in sync with the Idle Fade Timeout default in settings-store.ts. */
const DEFAULT_IDLE_FADE_MS = 60_000
const FADE_DURATION_MS = 800
/**
 * The fade is stepped by a timer rather than requestAnimationFrame: an NDI
 * output's window is hidden, and a hidden webview never gets rAF callbacks —
 * which is why the idle fade and Blank appeared to do nothing on NDI feeds
 * while working on the visible projector window. 30 Hz is plenty for an
 * opacity ramp, and every tick also pushes a frame so receivers see the fade
 * instead of jumping at the next 2s keepalive.
 */
const FADE_TICK_MS = 1000 / 30

/**
 * A theme with a transparent background is a layer over someone else's
 * picture (Lower Thirds, any NDI overlay). It has no frame of its own to give
 * away, so slides and media loops never take it over.
 */
function isOverlayTheme(theme: BroadcastTheme): boolean {
  return theme.background.type === "transparent"
}

function BroadcastCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const latestData = useRef<BroadcastPayload | null>(null)
  const ndiConfigRef = useRef<NdiConfigEventPayload>({
    active: false,
    fps: 24,
    width: 1920,
    height: 1080,
  })
  const ndiCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const lastPushRef = useRef(0)
  const pushingRef = useRef(false)
  // Fade is described by where it started, where it is heading and when it
  // began, so any redraw — timer tick, keepalive, incidental re-emit — can
  // compute the correct alpha from the clock instead of relying on a frame
  // loop that a hidden window never runs.
  const fadeRef = useRef({ from: 1, to: 1, start: 0, duration: 0 })
  const fadeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pushNdiFrameRef = useRef<(() => void) | null>(null)
  const regionCacheRef = useRef<{ theme: BroadcastTheme; rect: VerseLayoutRect } | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // presentedAt of the verse the fade timer was last armed for; undefined =
  // nothing shown. Only a CHANGED stamp re-arms the timer, so incidental
  // re-emits (theme edits, output syncs) can't keep a stale verse alive.
  const lastPresentStampRef = useRef<number | null | undefined>(undefined)
  const pushNdiBurstRef = useRef<(() => void) | null>(null)
  const presentationRef = useRef<PresentationController | null>(null)

  const logDebug = useCallback((message: string, meta?: unknown) => {
    if (!import.meta.env.DEV) return
    if (meta === undefined) {
      console.debug(`[broadcast-output] ${message}`)
      return
    }
    console.debug(`[broadcast-output] ${message}`, meta)
  }, [])

  /**
   * The theme's background region in canvas pixels — what a slide or media
   * loop is allowed to cover. Cached on theme identity because a playing
   * video redraws every frame.
   */
  const backgroundRegion = useCallback(
    (ctx: CanvasRenderingContext2D, theme: BroadcastTheme): VerseLayoutRect => {
      const cached = regionCacheRef.current
      if (cached?.theme === theme) return cached.rect
      const rect = computeVerseLayoutMetrics(ctx, theme, null).backgroundRect
      regionCacheRef.current = { theme, rect }
      return rect
    },
    []
  )

  /** Fade alpha for right now, derived from the clock. */
  const currentAlpha = useCallback((now = performance.now()) => {
    const fade = fadeRef.current
    if (fade.duration <= 0) return fade.to
    const progress = (now - fade.start) / fade.duration
    if (progress >= 1) return fade.to
    if (progress <= 0) return fade.from
    return fade.from + (fade.to - fade.from) * progress
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const data = latestData.current
    if (!data) {
      // Black screen when no data
      ctx.globalAlpha = 1
      ctx.fillStyle = "#000"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      return
    }

    const { theme, verse } = data
    // Assigning width/height resets the canvas, so only do it on a real
    // change — a playing video redraws every frame through here.
    if (canvas.width !== theme.resolution.width) canvas.width = theme.resolution.width
    if (canvas.height !== theme.resolution.height) canvas.height = theme.resolution.height
    const fadeTarget = data.idleFadeTarget ?? "black"

    // Base frame. A transparent output starts from zero alpha rather than
    // black: the whole point of an NDI overlay is that the receiver's video
    // shows through everything this frame does not paint.
    ctx.globalAlpha = 1
    if (fadeTarget === "transparent") {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    } else {
      ctx.fillStyle = "#000"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }

    // Slides and media loops cover the theme's background region, not the
    // whole frame, so a partial-width theme keeps showing what surrounds it.
    // An overlay theme has no region of its own to give away, so it declines
    // the content outright and stays on the verse scene — a sermon slide must
    // not black out the camera the lower third is sitting on.
    const presentation = presentationRef.current
    if (presentation?.active) {
      if (!isOverlayTheme(theme)) {
        presentation.drawFrame(
          ctx,
          canvas.width,
          canvas.height,
          backgroundRegion(ctx, theme)
        )
        return
      }
      // Overlay theme: fall through and keep drawing the verse scene.
    }

    const alpha = currentAlpha()
    // Fork fade-to-theme: keep the background + logo solid underneath so
    // the fade only takes the text away. The verse pass then repaints the
    // identical background over itself, leaving just the text at fade
    // alpha. Skipped at alpha 1 — the verse pass alone is the same frame.
    if (fadeTarget === "theme" && alpha < 1) {
      renderVerse(ctx, theme, null, {
        scale: 1,
        imageCache: themeImageCache(),
      })
    }
    ctx.globalAlpha = alpha

    const result = renderVerse(ctx, theme, verse, {
      scale: 1,
      imageCache: themeImageCache(),
    })
    ctx.globalAlpha = 1
    if (!result) {
      if (fadeTarget !== "transparent") {
        ctx.fillStyle = "#000"
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
      logDebug("renderVerse returned null; drew fallback frame")
    }
  }, [backgroundRegion, currentAlpha, logDebug])

  const stopFadeDriver = useCallback(() => {
    if (fadeTimerRef.current !== null) {
      clearInterval(fadeTimerRef.current)
      fadeTimerRef.current = null
    }
  }, [])

  /**
   * Step the fade until it lands, redrawing and — while NDI is running —
   * pushing each intermediate frame. Reads the target off the ref every tick,
   * so retargeting mid-fade (a new verse arriving while fading out) reverses
   * smoothly instead of finishing the stale animation first.
   */
  const startFadeDriver = useCallback(() => {
    if (fadeTimerRef.current !== null) return // loop already running
    fadeTimerRef.current = setInterval(() => {
      const settled = currentAlpha() === fadeRef.current.to
      draw()
      if (ndiConfigRef.current.active) pushNdiFrameRef.current?.()
      if (settled) stopFadeDriver()
    }, FADE_TICK_MS)
  }, [currentAlpha, draw, stopFadeDriver])

  const setFadeTarget = useCallback(
    (target: number) => {
      const now = performance.now()
      const from = currentAlpha(now)
      if (from === target && fadeRef.current.to === target) return
      fadeRef.current = { from, to: target, start: now, duration: FADE_DURATION_MS }
      startFadeDriver()
    },
    [currentAlpha, startFadeDriver]
  )

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }, [])

  const armIdleTimer = useCallback(
    (idleFadeMs: number) => {
      clearIdleTimer()
      // <= 0 means "no auto fade" — song blocks disable it (a chorus stays
      // up while the congregation sings; see VerseRenderData.noAutoFade).
      if (idleFadeMs <= 0) return
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null
        logDebug("Idle timeout reached; fading display out")
        setFadeTarget(0)
      }, idleFadeMs)
    },
    [clearIdleTimer, logDebug, setFadeTarget]
  )

  // Redraw once a theme's images land. The burst matters: without it NDI
  // receivers keep the flat fallback frame until the 2s keepalive fires.
  const preloadThemeAssets = useCallback((theme: BroadcastTheme) => {
    preloadThemeImages(theme, () => {
      logDebug("Theme images loaded")
      draw()
      pushNdiBurstRef.current?.()
    })
  }, [draw, logDebug])

  const pushNdiFrame = useCallback(async () => {
    if (!ndiConfigRef.current.active) return
    if (pushingRef.current) return // back-pressure: skip if already pushing
    pushingRef.current = true

    try {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext("2d")
      if (!ctx) return

      const targetWidth = ndiConfigRef.current.width
      const targetHeight = ndiConfigRef.current.height

      let sourceCtx = ctx
      let sourceWidth = canvas.width
      let sourceHeight = canvas.height

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        const ndiCanvas = ndiCanvasRef.current ?? document.createElement("canvas")
        ndiCanvas.width = targetWidth
        ndiCanvas.height = targetHeight
        const ndiCtx = ndiCanvas.getContext("2d")
        if (!ndiCtx) return
        ndiCtx.drawImage(canvas, 0, 0, targetWidth, targetHeight)
        ndiCanvasRef.current = ndiCanvas
        sourceCtx = ndiCtx
        sourceWidth = targetWidth
        sourceHeight = targetHeight
      }

      const imageData = sourceCtx.getImageData(0, 0, sourceWidth, sourceHeight)
      const rgbaBase64 = uint8ToBase64(imageData.data)

      const request: NdiFrameRequest = {
        outputId: OUTPUT_ID,
        width: sourceWidth,
        height: sourceHeight,
        rgbaBase64,
      }

      await invoke("push_ndi_frame", { request })
      lastPushRef.current = Date.now()
    } catch (error) {
      console.warn("[broadcast-output] push_ndi_frame failed", error)
    } finally {
      pushingRef.current = false
    }
  }, [])

  /** Push a burst of 3 frames after content changes (NDI receivers need a few frames to sync) */
  const pushNdiBurst = useCallback(() => {
    void pushNdiFrame()
    setTimeout(() => void pushNdiFrame(), 150)
    setTimeout(() => void pushNdiFrame(), 300)
  }, [pushNdiFrame])

  // Image loads finish after the burst that followed their theme update, and
  // the preload callback is defined above this — go through a ref so it can
  // re-burst without a definition cycle.
  useEffect(() => {
    pushNdiBurstRef.current = pushNdiBurst
    pushNdiFrameRef.current = () => void pushNdiFrame()
  }, [pushNdiBurst, pushNdiFrame])

  useEffect(() => {
    // Set initial canvas size
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = 1920
      canvas.height = 1080
      const ctx = canvas.getContext("2d")
      if (ctx) {
        ctx.fillStyle = "#000"
        ctx.fillRect(0, 0, 1920, 1080)
      }
    }

    const currentWindow = getCurrentWebviewWindow()
    logDebug("Listener registration started", { label: currentWindow.label })
    const unlisten = currentWindow.listen<BroadcastPayload>("broadcast:verse-update", (event) => {
      latestData.current = {
        ...event.payload,
        theme: normalizeTheme(event.payload.theme),
      }
      preloadThemeAssets(event.payload.theme)
      logDebug("Received broadcast:verse-update", {
        hasVerse: Boolean(event.payload.verse),
        themeId: event.payload.theme.id,
      })
      if (event.payload.verse) {
        // A fresh present (new verse, re-detected same verse, or keepalive)
        // carries a new presentedAt stamp — only then fade in and re-arm.
        // An unchanged stamp is an incidental re-emit (theme edit, output
        // sync): redraw, but leave the fade timer running. A missing stamp
        // (older payload shape) always re-arms, matching prior behavior.
        const stamp = event.payload.verse.presentedAt ?? null
        if (stamp === null || stamp !== lastPresentStampRef.current) {
          lastPresentStampRef.current = stamp
          setFadeTarget(1)
          armIdleTimer(event.payload.idleFadeMs ?? DEFAULT_IDLE_FADE_MS)
        }
      } else {
        lastPresentStampRef.current = undefined
        clearIdleTimer()
        setFadeTarget(0)
      }
      draw()
      pushNdiBurst()
    })

    // Presentation content (slides / media loops) — see presentation-output.ts.
    const presentation = new PresentationController({
      redraw: () => draw(),
      ndiBurst: () => pushNdiBurstRef.current?.(),
    })
    presentationRef.current = presentation
    const unlistenPresentation = currentWindow.listen<PresentationPayload>(
      PRESENTATION_UPDATE_EVENT,
      (event) => presentation.handlePayload(event.payload)
    )

    const unlistenNdiConfig = currentWindow.listen<NdiConfigEventPayload>("broadcast:ndi-config", (event) => {
      ndiConfigRef.current = event.payload
      logDebug("Received broadcast:ndi-config", event.payload)
      // Push burst when NDI becomes active
      if (event.payload.active) pushNdiBurst()
    })

    // Request current NDI status on mount (fixes race condition
    // where NDI is started before this window opens)
    void invoke<{ active: boolean; width: number; height: number; fps: number } | null>("get_ndi_status", { outputId: OUTPUT_ID })
      .then((status) => {
        if (status && status.active) {
          ndiConfigRef.current = {
            active: true,
            fps: status.fps,
            width: status.width,
            height: status.height,
          }
          logDebug("Fetched NDI status on mount", status)
        }
      })
      .catch(() => {
        // Command may not exist yet
      })

    // Redraw whenever a theme webfont finishes loading (the renderer requests
    // them on demand) so frames drawn against fallback metrics are replaced.
    const unsubscribeFonts = onThemeFontsLoaded(() => {
      draw()
      pushNdiBurst()
    })

    void currentWindow.emitTo("main", "broadcast:output-ready", { outputId: OUTPUT_ID }).then(() => {
      logDebug("Sent broadcast:output-ready")
    }).catch(() => {
      console.warn("[broadcast-output] failed to send output-ready event")
    })

    return () => {
      unsubscribeFonts()
      unlisten.then((fn) => fn())
      unlistenNdiConfig.then((fn) => fn())
      unlistenPresentation.then((fn) => fn())
      presentation.dispose()
      presentationRef.current = null
      clearIdleTimer()
      stopFadeDriver()
    }
  }, [
    draw,
    logDebug,
    preloadThemeAssets,
    pushNdiFrame,
    pushNdiBurst,
    setFadeTarget,
    armIdleTimer,
    clearIdleTimer,
    stopFadeDriver,
  ])

  // Slow keepalive: push one frame every 2s if idle (prevents NDI receivers from dropping the source)
  useEffect(() => {
    const timer = setInterval(() => {
      if (!ndiConfigRef.current.active) return
      const elapsed = Date.now() - lastPushRef.current
      if (elapsed > 2000) void pushNdiFrame()
    }, 2000)
    return () => clearInterval(timer)
  }, [pushNdiFrame])

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100vw",
        height: "100vh",
        display: "block",
        objectFit: "contain",
      }}
    />
  )
}

const root = document.getElementById("broadcast-root")!
createRoot(root).render(<BroadcastCanvas />)
