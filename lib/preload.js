/**
 * Preload script for the DeepSeek Harness desktop window.
 *
 * Runs in a sandboxed renderer with `contextIsolation: true`. Exposes a narrow
 * IPC bridge under `window.dshDesktop` so the web UI can request desktop-only
 * capabilities (new-session shortcut, app version) without leaking the full
 * Node API.
 * @module @deepseek-ai/dsh-desktop/preload
 */
import { contextBridge, ipcRenderer } from 'electron';
const bridge = {
    isDesktop: true,
    appVersion: ipcRenderer.sendSync('dsh:app-version'),
    platform: process.platform,
    onNewSession(callback) {
        const handler = () => { callback(); };
        ipcRenderer.on('dsh:new-session', handler);
        return () => { ipcRenderer.removeListener('dsh:new-session', handler); };
    },
    notify(title, body) {
        ipcRenderer.send('dsh:notify', title, body);
    },
};
contextBridge.exposeInMainWorld('dshDesktop', bridge);
//# sourceMappingURL=preload.js.map