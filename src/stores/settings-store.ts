import { create } from "zustand"
import { load, type Store } from "@tauri-apps/plugin-store"

type SttProvider = "deepgram" | "whisper"

/** Fork: what a monitor or projector shows when faded out (idle fade or
 * operator blank) — full black, or the active theme's background + logo. */
export type IdleFadeTarget = "black" | "theme"

/**
 * Fork: the same for an NDI feed, which additionally can key out entirely.
 * "transparent" is the default and the only value that leaves the video the
 * feed is composited over untouched.
 */
export type NdiIdleFadeTarget = "transparent" | "black" | "theme"

interface SettingsState {
  deepgramApiKey: string | null
  openaiApiKey: string | null
  claudeApiKey: string | null
  audioDeviceId: string | null
  gain: number
  autoMode: boolean
  confidenceThreshold: number
  cooldownMs: number
  /** How long content sits idle before it fades. Shared by both output
   * kinds; each kind decides whether to act on it. */
  idleFadeMs: number
  /** Fork: unprefixed idle-fade settings govern monitor/projector outputs —
   * the key names predate NDI getting its own pair, and renaming them would
   * silently reset every existing install's preference. */
  idleFadeEnabled: boolean
  idleFadeTarget: IdleFadeTarget
  /** Fork: NDI feeds fade independently — an overlay is often wanted up until
   * the operator blanks it, even while the projector times out. */
  ndiIdleFadeEnabled: boolean
  ndiIdleFadeTarget: NdiIdleFadeTarget
  onboardingComplete: boolean
  sttProvider: SttProvider
  /** Fork: ggml model file used by the local Whisper provider. */
  whisperModel: string

  setDeepgramApiKey: (key: string | null) => void
  setOpenaiApiKey: (key: string | null) => void
  setClaudeApiKey: (key: string | null) => void
  setAudioDeviceId: (id: string | null) => void
  setGain: (gain: number) => void
  setAutoMode: (auto: boolean) => void
  setConfidenceThreshold: (threshold: number) => void
  setCooldownMs: (ms: number) => void
  setIdleFadeMs: (ms: number) => void
  setIdleFadeEnabled: (enabled: boolean) => void
  setIdleFadeTarget: (target: IdleFadeTarget) => void
  setNdiIdleFadeEnabled: (enabled: boolean) => void
  setNdiIdleFadeTarget: (target: NdiIdleFadeTarget) => void
  setOnboardingComplete: (complete: boolean) => void
  setSttProvider: (provider: SttProvider) => void
  setWhisperModel: (model: string) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  deepgramApiKey: null,
  openaiApiKey: null,
  claudeApiKey: null,
  audioDeviceId: null,
  gain: 1.0,
  autoMode: false,
  confidenceThreshold: 0.8,
  cooldownMs: 2500,
  idleFadeMs: 60_000,
  idleFadeEnabled: true,
  idleFadeTarget: "theme",
  ndiIdleFadeEnabled: true,
  ndiIdleFadeTarget: "transparent",
  onboardingComplete: false,
  sttProvider: "deepgram",
  whisperModel: "ggml-large-v3-turbo-q8_0.bin",

  setDeepgramApiKey: (deepgramApiKey) => set({ deepgramApiKey }),
  setOpenaiApiKey: (openaiApiKey) => set({ openaiApiKey }),
  setClaudeApiKey: (claudeApiKey) => set({ claudeApiKey }),
  setAudioDeviceId: (audioDeviceId) => set({ audioDeviceId }),
  setGain: (gain) => set({ gain }),
  setAutoMode: (autoMode) => set({ autoMode }),
  setConfidenceThreshold: (confidenceThreshold) => set({ confidenceThreshold }),
  setCooldownMs: (cooldownMs) => set({ cooldownMs }),
  setIdleFadeMs: (idleFadeMs) => set({ idleFadeMs }),
  setIdleFadeEnabled: (idleFadeEnabled) => set({ idleFadeEnabled }),
  setIdleFadeTarget: (idleFadeTarget) => set({ idleFadeTarget }),
  setNdiIdleFadeEnabled: (ndiIdleFadeEnabled) => set({ ndiIdleFadeEnabled }),
  setNdiIdleFadeTarget: (ndiIdleFadeTarget) => set({ ndiIdleFadeTarget }),
  setOnboardingComplete: (onboardingComplete) => set({ onboardingComplete }),
  setSttProvider: (sttProvider) => set({ sttProvider }),
  setWhisperModel: (whisperModel) => set({ whisperModel }),
}))

const PERSISTED_KEYS = [
  "deepgramApiKey",
  "openaiApiKey",
  "claudeApiKey",
  "audioDeviceId",
  "gain",
  "autoMode",
  "confidenceThreshold",
  "cooldownMs",
  "idleFadeMs",
  "idleFadeEnabled",
  "idleFadeTarget",
  "ndiIdleFadeEnabled",
  "ndiIdleFadeTarget",
  "onboardingComplete",
  "sttProvider",
  "whisperModel",
] as const satisfies readonly (keyof SettingsState)[]

let tauriStore: Store | null = null
let hydrationPromise: Promise<void> | null = null

async function getStore(): Promise<Store> {
  if (!tauriStore) {
    tauriStore = await load("settings.json", { autoSave: false, defaults: {} })
  }
  return tauriStore
}

/** Load all persisted settings into the Zustand store. Idempotent and
 *  safe against concurrent callers — the first call owns the work and
 *  subsequent callers await the same promise. */
export function hydrateSettings(): Promise<void> {
  if (hydrationPromise) return hydrationPromise
  hydrationPromise = (async () => {
    try {
      const store = await getStore()
      const patch: Partial<SettingsState> = {}
      for (const key of PERSISTED_KEYS) {
        const value = await store.get(key)
        if (value !== undefined && value !== null) {
          ;(patch as Record<string, unknown>)[key] = value
        }
      }
      if (Object.keys(patch).length > 0) {
        useSettingsStore.setState(patch)
      }

      // Attach only after successful hydration so as not to overwrite disk with defaults.
      // Debounce writes, so a dragged slider (e.g. gain) coalesces into a single disk write.
      useSettingsStore.subscribe((state, prevState) => {
        const changed = PERSISTED_KEYS.some((k) => state[k] !== prevState[k])
        if (!changed) return
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
          saveTimer = null
          pendingSave = pendingSave.then(() =>
            persistAll(useSettingsStore.getState())
          )
        }, SAVE_DEBOUNCE_MS)
      })
    } catch {
      console.warn("[settings] Failed to load persisted state, using defaults")
    }
  })()
  return hydrationPromise
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave: Promise<void> = Promise.resolve()
const SAVE_DEBOUNCE_MS = 250

async function persistAll(state: SettingsState): Promise<void> {
  try {
    const store = await getStore()
    for (const key of PERSISTED_KEYS) {
      await store.set(key, state[key] as unknown)
    }
    await store.save()
  } catch {
    console.warn("[settings] Failed to persist settings")
  }
}
