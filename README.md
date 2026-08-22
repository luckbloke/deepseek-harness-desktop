# @deepseek-ai/dsh-desktop

Desktop application shell for DeepSeek Harness. Wraps the web profile in an
Electron window with system tray, native menus, desktop notifications, and
single-instance locking.

## Development

```sh
# Build the web frontend first (consumed as extraResources in the package).
pnpm run build:web

# Build the dsh CLI.
pnpm run build:lib

# Build the desktop main/preload scripts.
pnpm --filter @deepseek-ai/dsh-desktop run build

# Launch Electron against the built scripts.
pnpm --filter @deepseek-ai/dsh-desktop run dev
```

## Packaging

```sh
# Current platform.
pnpm --filter @deepseek-ai/dsh-desktop run dist

# Specific platforms.
pnpm --filter @deepseek-ai/dsh-desktop run dist:win
pnpm --filter @deepseek-ai/dsh-desktop run dist:mac
pnpm --filter @deepseek-ai/dsh-desktop run dist:linux
```

Packaged installers land in `apps/desktop/release/`.

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
