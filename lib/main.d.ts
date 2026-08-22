/**
 * DeepSeek Harness desktop main process.
 *
 * Spawns `dsh web` as a child, waits for the listen URL on stdout, opens an
 * Electron BrowserWindow pointing at it, and provides system-tray and native
 * menu integration. Closing the window hides to tray on macOS; quitting the
 * app tears the child down gracefully.
 * @module @deepseek-ai/dsh-desktop/main
 */
export {};
