# TaskBoard Codex 插件 MVP

这是从零实现的本地任务看板插件。插件 ID 为 `codex-taskboard`，显示名为 **TaskBoard**。插件提供一个 global Sidebar app 入口 `taskboard.open`：默认汇总插件内所有看板的任务。MVP 中“项目”就是用户在插件内创建的看板；项目筛选对应 MCP 的 `board_id`，任务的项目标签取自其 `boardId`。插件不会扫描本地仓库或自动导入外部任务。它还通过 stdio MCP 服务提供六个数据工具：`list_boards`、`create_board`、`list_tasks`、`get_task`、`create_task`、`update_task`，并附带一个 Skill 指导对话中的任务操作。任务数据保存在 Codex 分配的 `PLUGIN_DATA/taskboard.sqlite`，不会绑定当前项目目录，也不会写入项目仓库。

当前版本面向支持 global Sidebar app 入口的 ChatGPT 桌面客户端，以及支持插件与 MCP 工具的本地 Codex。运行 MCP 服务的机器需要 Node.js 26 或更新版本。本版没有云同步、账号登录、评论、附件或删除操作。

## 构建与验证

在本仓库根目录运行：

```bash
npm ci --ignore-scripts
npm run check
```

构建产物位于 `plugins/codex-taskboard/dist/`，包含 MCP 服务、UI 页面和已打包的前端脚本。分发时只需要 `plugins/codex-taskboard/` 内的文件；开发依赖和测试文件不属于插件包。`npm run check` 会通过真实 stdio MCP 连接验证侧栏入口元数据、UI 资源、数据工具和 SQLite 持久化。

## 本地安装

先构建，再在 Codex CLI 中添加本仓库作为本地 marketplace：

```bash
codex plugin marketplace add /absolute/path/to/TasksBoard
codex plugin add codex-taskboard@taskboard-local
codex mcp list --json
```

也可以在 ChatGPT 桌面应用的插件目录选择 `TaskBoard local development` 来源安装。支持 global Sidebar app 的客户端会从侧栏打开 TaskBoard；CLI 可在聊天中要求“用 TaskBoard 创建一个看板和任务”。`taskboard.open({})` 返回跨看板的首 100 条任务与总数；`list_tasks({})` 查询全部任务，传 `board_id` 时按看板筛选，可用 `limit` 和 `offset` 翻页，返回的 `total` 是当前筛选结果数。`list_boards` 会返回看板 ID；创建任务需要明确 `board_id`。更新任务前先 `get_task` 取得当前 `version`，再传给 `update_task` 的 `expected_version`。数据由安装该插件的 Codex 环境管理，和 Codex 自身的聊天或其他任务系统无关。

插件定义在 `plugins/codex-taskboard/plugin.json`，MCP 启动配置在 `plugins/codex-taskboard/mcp.json`，工作流程在 `plugins/codex-taskboard/skills/manage-taskboard/SKILL.md`，本地市场清单在 `.agents/plugins/marketplace.json`。

## 公开发布前的工作

这只是本地插件 MVP。公开目录要求将 MCP 服务部署为可访问的 HTTPS 服务，并为用户任务数据和写操作配置用户鉴权。还需决定开发者身份、许可证、隐私政策、托管与数据迁移方案，完成实际客户端侧栏加载验证和插件提交审核；本仓库尚未进行这些外部操作。

产品方向参考 [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard) 的本地任务管理场景。该项目使用 Apache-2.0 许可；这里的实现独立编写，没有复制其源码或资源。
