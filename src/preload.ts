/**
 * Preload script for the DeepSeek Harness desktop window.
 *
 * Runs in a sandboxed renderer with `contextIsolation: true`. Exposes a narrow
 * IPC bridge under `window.dshDesktop` so the web UI can request desktop-only
 * capabilities (new-session shortcut, app version) without leaking the full
 * Node API.
 * @module @deepseek-ai/dsh-desktop/preload
 */

import { contextBridge, ipcRenderer } from 'electron'

/** The desktop capabilities surface placed on `window.dshDesktop`. */
export interface DshDesktopBridge {
  /** True when the page runs inside the Electron desktop shell. */
  readonly isDesktop: true
  /** Electron app version (not the dsh CLI version). */
  readonly appVersion: string
  /** Platform string for platform-specific UI branches. */
  readonly platform: NodeJS.Platform
  /** Listen for a "new session" shortcut fired from the native menu. */
  onNewSession(callback: () => void): () => void
  /** Show a desktop notification through the OS notification center. */
  notify(title: string, body: string): void
}

const bridge: DshDesktopBridge = {
  isDesktop: true,
  appVersion: ipcRenderer.sendSync('dsh:app-version') as string,
  platform: process.platform,
  onNewSession(callback) {
    const handler = (): void => { callback() }
    ipcRenderer.on('dsh:new-session', handler)
    return () => { ipcRenderer.removeListener('dsh:new-session', handler) }
  },
  notify(title, body) {
    ipcRenderer.send('dsh:notify', title, body)
  },
}

contextBridge.exposeInMainWorld('dshDesktop', bridge)
