# Branch Agent

Branch Agent 是一个 Pi Coding Agent 扩展，用来从当前会话中启动独立的分支 Agent。它适合把探索、验证、并行实验这类任务拆到单独会话里执行，同时保留主会话的上下文。

## 发布

- npm: https://www.npmjs.com/package/pi-branch-agent
- GitHub: https://github.com/1144g7/branch-agent

## 功能

- 启动前台分支 Agent，并等待结果返回。
- 启动后台分支 Agent，让主会话继续工作。
- 查询后台分支 Agent 的状态和结果。
- 向运行中的后台分支 Agent 发送新的引导消息。
- 可选打开独立终端窗口运行分支会话。

## 安装

通过 Pi 安装：

```bash
pi install npm:pi-branch-agent
```

也可以直接从 GitHub 安装：

```bash
pi install git:github.com/1144g7/branch-agent
```

本地开发时，可以从项目目录安装：

```bash
pi install E:\Active_projects\branch-agent
```

将本目录放到 Pi Coding Agent 的扩展目录中，确保扩展入口文件为 `index.ts`。

```text
.pi/agent/extensions/branch-agent
```

具体加载方式以你的 Pi Coding Agent 扩展配置为准。

## 使用

扩展注册了以下工具：

- `BranchAgent`：启动一个分支 Agent。
- `get_branch_result`：查询后台分支 Agent 的状态和结果。
- `steer_branch`：向后台分支 Agent 发送后续指令。

`BranchAgent` 支持三种运行模式：

- `foreground`：阻塞等待结果返回。
- `background`：后台运行，稍后查询结果。
- `terminal`：后台运行，并打开独立终端窗口。

## 截图

后续可以把效果截图放到这里：

```text
docs/images/branch-agent-overview.png
```

推荐截图内容：主会话里调用 `BranchAgent` 后，侧边或输出区展示分支任务状态和结果的界面。

## 开发状态

当前版本是早期可用版本，接口和展示细节后续可能继续调整。
