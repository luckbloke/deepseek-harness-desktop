# @deepseek-ai/dsh-desktop

Desktop application shell for DeepSeek Harness. Wraps the web profile in an
Electron window with system tray, native menus, desktop notifications, and
single-instance locking.

## Development

```sh
# Pull deepseek harness and build.
pnpm run setup

# Build the deepseek harness desktop.
pnpm run build

# Packaging.
pnpm run dist:win
```
Packaged installers land in `release/`.

## Architecture

The main process spawns `dsh web` as a child, reads the listen URL from its
stdout, and opens a `BrowserWindow` pointing at it. The preload script places a
narrow `window.dshDesktop` bridge on the renderer so the web UI can detect the
desktop shell and request OS-level capabilities (notifications, new-session
shortcut) without accessing Node directly.

Closing the window on macOS hides to tray; `Cmd+Q` or the tray Quit menu item
terminates both Electron and the child server. On Windows and Linux the window
close quits the app. A second invocation focuses the existing window instead of
launching a new instance.
