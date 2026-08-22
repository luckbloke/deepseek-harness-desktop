# @deepseek-ai/dsh-desktop

DeepSeek Harness 桌面应用。将 Web 版包装在 Electron 窗口中，提供系统托盘、
原生菜单、桌面通知和单实例锁定等桌面特性。

## 准备
```sh
# 初始化 Git 仓库
git init
git add .
git commit -m "初始桌面端项目"
# 添加官方仓库为子模块
git submodule add https://github.com/deepseek-ai/deepseek-harness.git vendor/dsh

## 开发
cd vendor/dsh
pnpm install                     # 安装官方依赖
pnpm run build                # 构建所有（包括 CLI 和 Web）
cd ../..

# 设置环境变量
$env:DSH_VENDOR_PATH = "vendor/dsh"   # 相对路径或绝对路径，如 F:/deepseek-harness

# 构建桌面主进程和 preload 脚本。
pnpm --filter @deepseek-ai/dsh-desktop run build

# 启动 Electron。
pnpm --filter @deepseek-ai/dsh-desktop run dev
```

## 打包

```sh
# 当前平台。
pnpm --filter @deepseek-ai/dsh-desktop run dist

# 指定平台。
pnpm --filter @deepseek-ai/dsh-desktop run dist:win
pnpm --filter @deepseek-ai/dsh-desktop run dist:mac
pnpm --filter @deepseek-ai/dsh-desktop run dist:linux
```

打包后的安装文件位于 `apps/desktop/release/`。

## 架构

主进程以子进程方式启动 `dsh web`，从标准输出读取监听地址后打开 `BrowserWindow`
指向该地址。preload 脚本在渲染进程上挂载一个窄接口 `window.dshDesktop`，
使 Web 界面可以探测桌面环境并请求系统级能力（通知、新建会话快捷键），
而不会直接访问 Node API。

macOS 上关闭窗口会最小化到托盘；`Cmd+Q` 或托盘退出菜单同时关闭 Electron
和子进程服务器。Windows 与 Linux 上关闭窗口即退出应用。第二个实例启动时会
聚焦到已有窗口而非启动新进程。
