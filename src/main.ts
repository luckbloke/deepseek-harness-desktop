/**
 * DeepSeek Harness desktop main process.
 *
 * Spawns `dsh web` as a child, waits for the listen URL on stdout, opens an
 * Electron BrowserWindow pointing at it, and provides system-tray and native
 * menu integration. Closing the window hides to tray on macOS; quitting the
 * app tears the child down gracefully.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell, ipcMain, Notification } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the dsh executable path. In a packaged Electron app the CLI sits
 * beside the app resources; in development it is the repo's apps/cli.
 */
function resolveDshBin(): string {
  // 优先使用 DSH_VENDOR_PATH 环境变量
  const vendorBase = process.env.DSH_VENDOR_PATH
  if (vendorBase) {
    const pathFromVendor = join(vendorBase, 'apps', 'cli', 'lib', 'bin.js')
    if (existsSync(pathFromVendor)) return pathFromVendor
  }

  // 兼容 DSH_CLI_PATH（如果仍需要）
  const envPath = process.env.DSH_CLI_PATH
  if (envPath && existsSync(envPath)) {
    return envPath
  }

  // 开发模式：假设官方项目在 ../deepseek-harness（与桌面项目同级）
  const devPath = resolve(__dirname, '..', '..', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(devPath)) return devPath

  // 回退：项目内的 vendor 目录
  const vendorPath = join(__dirname, '..', 'vendor', 'dsh', 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(vendorPath)) return vendorPath

  // 打包后的资源
  const packagedCli = join(process.resourcesPath ?? '', 'cli', 'lib', 'bin.js')
  return packagedCli
}

/**
 * Resolve the web frontend dist directory. Used to verify the web build is
 * present before launching the child.
 */
function resolveWebDist(): string {
  // 优先使用 DSH_VENDOR_PATH 环境变量
  const vendorBase = process.env.DSH_VENDOR_PATH
  if (vendorBase) {
    const pathFromVendor = join(vendorBase, 'apps', 'web', 'dist')
    if (existsSync(pathFromVendor)) return pathFromVendor
  }

  // 兼容 DSH_WEB_DIST
  const envPath = process.env.DSH_WEB_DIST
  if (envPath && existsSync(envPath)) {
    return envPath
  }

  const devPath = resolve(__dirname, '..', '..', 'deepseek-harness', 'apps', 'web', 'dist')
  if (existsSync(devPath)) return devPath

  const vendorPath = join(__dirname, '..', 'vendor', 'dsh', 'apps', 'web', 'dist')
  if (existsSync(vendorPath)) return vendorPath

  return join(process.resourcesPath ?? '', 'web', 'dist')
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let dshProcess: ChildProcess | null = null
let serverUrl: string | null = null
let isQuitting = false

/**
 * Spawn the dsh web profile and resolve the listen URL from its stdout.
 * If the port is already in use, reuse the existing service.
 * @param args - extra arguments forwarded to `dsh web`.
 * @returns the URL once the server reports it is listening.
 */
function startDshWeb(args: string[] = []): Promise<string> {
  console.log('[dsh-desktop] DSH_HOME =', process.env.DSH_HOME)
  console.log('[dsh-desktop] cwd      =', process.cwd())
  console.log('[dsh-desktop] argv     =', process.argv)

  return new Promise((resolvePromise, reject) => {
    const bin = resolveDshBin()
    const dist = resolveWebDist()
    console.log('[dsh-desktop] bin path:', bin)
    console.log('[dsh-desktop] web dist:', dist)

    if (!existsSync(bin)) {
      reject(new Error(`dsh CLI not found at ${bin}. Run 'pnpm run build' first.`))
      return
    }
    if (!existsSync(join(dist, 'index.html'))) {
      reject(new Error(`web frontend dist not found at ${dist}. Run 'pnpm run build:web' first.`))
      return
    }

    const projectRoot = app.isPackaged
      ? (process.resourcesPath ?? process.cwd())
      : resolve(__dirname, '..', '..', '..')
    console.log('[dsh-desktop] projectRoot:', projectRoot)

    // 解析 host 和 port
    const host = '127.0.0.1'
    let port = 3080
    const portIndex = args.indexOf('--port')
    if (portIndex !== -1) {
      const portArg = args[portIndex + 1]
      if (portArg !== undefined) {
        const parsed = parseInt(portArg, 10)
        if (!isNaN(parsed)) port = parsed
      }
    }
    const url = `http://${host}:${port}`

    // 探测端口是否已被占用
    const probe = createConnection({ host, port }, () => {
      probe.destroy()
      console.log('[dsh-desktop] Service already running at', url)
      serverUrl = url
      resolvePromise(url)
    })
    probe.on('error', () => {
      probe.destroy()
      console.log('[dsh-desktop] Port free, spawning new service')
      spawnService()
    })

    function spawnService() {
      const env = {
        ...process.env,
        DSH_HOME: process.env.DSH_HOME || join(projectRoot, 'profiles'),
      }

      // 使用系统 node 命令，避免 Electron 运行时环境干扰
      const cmd = 'node'
      const cmdArgs = [bin, 'web', '--no-open', '--host', host, ...args]
      console.log('[dsh-desktop] Spawning:', cmd, cmdArgs)

      const child = spawn(cmd, cmdArgs, {
        cwd: projectRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      dshProcess = child

      let stderrBuf = ''
      let stdoutBuf = ''

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stdoutBuf += text
        console.log('[dsh-desktop stdout]', text)
        const match = text.match(/https?:\/\/[^\s]+/)
        if (match && match[0]) {
          serverUrl = match[0]
          resolvePromise(serverUrl)
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stderrBuf += text
        console.error('[dsh-desktop stderr]', text)
      })

      child.on('error', (err) => {
        reject(err)
      })

      child.on('exit', (code, signal) => {
        dshProcess = null
        if (!serverUrl) {
          reject(new Error(`dsh web exited before printing a URL (code=${code}, signal=${signal}). stdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`))
        }
      })
    }
  })
}

/**
 * Resolve the path to the application icon for both development and production.
 * - Development: uses the assets folder in the desktop source directory.
 * - Production: uses the assets folder copied to resources by electron-builder.
 */
function getIconPath(): string {
  // 根据环境确定 base 路径
  const basePath = app.isPackaged
    ? join(process.resourcesPath, 'assets')
    : join(__dirname, '..', 'assets')

  const icoPath = join(basePath, 'icon.ico')
  const pngPath = join(basePath, 'icon.png')

  // 优先使用 .ico（Windows 原生支持多尺寸，且体积小）
  if (existsSync(icoPath)) return icoPath
  // 其次使用 .png
  if (existsSync(pngPath)) return pngPath

  // 若都不存在，回退到 .png
  return pngPath
}

/**
 * Create or focus the main browser window, loading the web UI from the
 * spawned dsh web server.
 * @param url - the listen URL of the running dsh web process.
 */
function createMainWindow(url: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    return
  }
  
  const iconPath = getIconPath()
  
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepSeek Harness',
    icon: iconPath, 
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Open external links in the system browser, not in our window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) {
      void shell.openExternal(target)
    }
    return { action: 'deny' }
  })

  void mainWindow.loadURL(url)

  // 锁定窗口标题，防止被 Web 页面覆盖
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.setTitle('DeepSeek Harness')
  })

  mainWindow.on('close', (event) => {
    // On macOS, closing the window hides to tray instead of quitting.
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Build the application menu bar (fully Chinese, simplified).
 * All role properties are marked as const to satisfy TypeScript.
 */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'DeepSeek Harness',
      submenu: [
        { role: 'about' as const, label: '关于 DeepSeek Harness' },
        { type: 'separator' as const },
        { role: 'services' as const, label: '服务' },
        { type: 'separator' as const },
        { role: 'hide' as const, label: '隐藏 DeepSeek Harness' },
        { role: 'hideOthers' as const, label: '隐藏其他' },
        { role: 'unhide' as const, label: '显示全部' },
        { type: 'separator' as const },
        { role: 'quit' as const, label: '退出 DeepSeek Harness' },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow?.webContents.send('dsh:new-session')
          },
        },
        { type: 'separator' as const },
        isMac ? { role: 'close' as const, label: '关闭窗口' } : { role: 'quit' as const, label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' as const, label: '撤销' },
        { role: 'redo' as const, label: '重做' },
        { type: 'separator' as const },
        { role: 'cut' as const, label: '剪切' },
        { role: 'copy' as const, label: '复制' },
        { role: 'paste' as const, label: '粘贴' },
        { role: 'selectAll' as const, label: '全选' },
      ],
    },
    {
      label: '查看',
      submenu: [
        { role: 'reload' as const, label: '重新加载' },
        { role: 'forceReload' as const, label: '强制重新加载' },
        { role: 'toggleDevTools' as const, label: '切换开发者工具' },
        { type: 'separator' as const },
        { role: 'resetZoom' as const, label: '重置缩放' },
        { role: 'zoomIn' as const, label: '放大' },
        { role: 'zoomOut' as const, label: '缩小' },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const, label: '全屏切换' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' as const, label: '最小化' },
        ...(isMac ? [
          { role: 'zoom' as const, label: '缩放' },
          { type: 'separator' as const },
          { role: 'front' as const, label: '前置所有窗口' },
          { type: 'separator' as const },
          { role: 'window' as const, label: '窗口' },
        ] : [
          { role: 'close' as const, label: '关闭' },
        ]),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '文档',
          click: () => {
            void shell.openExternal('https://github.com/deepseek-ai/deepseek-harness')
          },
        },
        {
          label: '报告问题',
          click: () => {
            void shell.openExternal('https://github.com/deepseek-ai/deepseek-harness/issues')
          },
        },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

/** Build the system tray icon and context menu. */
function buildTray(): void {
  // 16x16 template icon — works on both macOS menu bar and Windows tray.
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
    'WElEQVQ4T2NkoBAwUqifYdQAhtEgYBgNhNFAGM0DjNA8gM1dDKP5Aj1fjIYBw2gQMOAMAtF8MZovRvPFaL4YzReg' +
    'fDEaCKN5gHQvMJCuZTQIRvMBAJ6kExnRf7aqAAAAAElFTkSuQmCC',
  )

  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开 DeepSeek Harness',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        } else if (serverUrl) {
          createMainWindow(serverUrl)
        }
      },
    },
    { type: 'separator' },
    {
      label: '重启服务',
      click: () => {
        void restartServer()
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)

  // Double-click the tray restores the window.
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    } else if (serverUrl) {
      createMainWindow(serverUrl)
    }
  })
}

/** Tear down the running dsh web child, if any. */
function stopDshWeb(): void {
  if (!dshProcess) return
  try {
    // Graceful: let the child finish its shutdown sequence.
    dshProcess.kill('SIGTERM')
  } catch {
    // Process may already be gone.
  }
  dshProcess = null
}

/** Restart the dsh web child and reload the window. */
async function restartServer(): Promise<void> {
  stopDshWeb()
  serverUrl = null
  try {
    const url = await startDshWeb()
    if (mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.loadURL(url)
    }
  } catch (err) {
    dialog.showErrorBox('DeepSeek Harness', `重启服务失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

// --- IPC handlers for the preload bridge ---

ipcMain.on('dsh:app-version', (event) => {
  event.returnValue = app.getVersion()
})

ipcMain.on('dsh:notify', (_event, title: string, body: string) => {
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
    notification.show()
  }
})

// --- App lifecycle ---

// Prevent a second instance from launching; focus the existing window instead.
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // 确保 DSH_HOME 已设置
    if (!process.env.DSH_HOME) {
      const projectRoot = app.isPackaged
        ? (process.resourcesPath ?? process.cwd())
        : resolve(__dirname, '..', '..', '..')
      process.env.DSH_HOME = join(projectRoot, 'profiles')
      console.log('[dsh-desktop] Set DSH_HOME to', process.env.DSH_HOME)
    }

    buildAppMenu()

    try {
      const url = await startDshWeb()
      createMainWindow(url)
      buildTray()
    } catch (err) {
      dialog.showErrorBox(
        'DeepSeek Harness',
        `启动 Web 服务失败：\n${err instanceof Error ? err.message : String(err)}`,
      )
      app.quit()
    }
  })

  app.on('activate', () => {
    // macOS: re-create or show the window when the dock icon is clicked.
    if (mainWindow === null) {
      if (serverUrl) createMainWindow(serverUrl)
    } else {
      mainWindow.show()
    }
  })

  app.on('window-all-closed', () => {
    // macOS convention: keep the app alive until Cmd+Q.
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    isQuitting = true
    stopDshWeb()
  })

  // Belt-and-suspenders: ensure the child dies even if before-quit races.
  process.on('exit', () => {
    stopDshWeb()
  })
}