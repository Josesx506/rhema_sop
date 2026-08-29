import { create } from "zustand"

/**
 * Top-level operator UI mode (fork feature). Scripture is the upstream
 * dashboard; Songs and Presentation are fork modules. Not persisted — the
 * app always opens in Scripture mode.
 */
export type AppMode = "scripture" | "songs" | "presentation"

interface AppModeState {
  mode: AppMode
  setMode: (mode: AppMode) => void
}

export const useAppModeStore = create<AppModeState>((set) => ({
  mode: "scripture",
  setMode: (mode) => set({ mode }),
}))
