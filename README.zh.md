# @deepseek-ai/dsh-desktop

DeepSeek Harness 桌面应用。将 Web 版包装在 Electron 窗口中，提供系统托盘、
原生菜单、桌面通知和单实例锁定等桌面特性。

## 开发
```sh
# 拉取deepseek harness并构建.
pnpm run setup

# 构建桌面版客户端.
pnpm run build

# 打包.
pnpm run dist:win
```

打包后的安装文件位于 `release/`。

## 架构

主进程以子进程方式启动 `dsh web`，从标准输出读取监听地址后打开 `BrowserWindow`
指向该地址。preload 脚本在渲染进程上挂载一个窄接口 `window.dshDesktop`，
使 Web 界面可以探测桌面环境并请求系统级能力（通知、新建会话快捷键），
而不会直接访问 Node API。

macOS 上关闭窗口会最小化到托盘；`Cmd+Q` 或托盘退出菜单同时关闭 Electron
和子进程服务器。Windows 与 Linux 上关闭窗口即退出应用。第二个实例启动时会
聚焦到已有窗口而非启动新进程。
