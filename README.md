# Codex TaskBoard

Codex TaskBoard 是一个本地 Codex 聊天看板插件，插件 ID 为 `codex-taskboard`。通过 global Sidebar app 入口打开，按工作目录筛选聊天，将聊天归入 `InProgress`、`Review`、`Done`，并提供用户手动验收和重新打开操作。

插件只读 Codex 原生数据库 `state_5.sqlite` 和关联 rollout 文件，不修改原生聊天、归档或任务状态。状态来自已记录的 rollout 事件：持续观察到新的回合开始后进入 `InProgress`，回合完成、失败或中断进入 `Review`。初始化前已有的未结束回合先显示 `Review / 状态待确认`；此后同一回合出现新的推理、助手消息或工具执行记录时进入 `InProgress`。用户输入和没有回合 ID 的计数事件不能单独确认执行；已结束回合不会因迟到执行项重新激活。这是一份事件快照，不代表实时进程或模型仍在运行。界面会显示读取失败及陈旧数据，读取失败不会被当作没有聊天。

搜索和工作区等筛选只影响展示，隐藏线程仍持续观察。首次目录基线之后新发现的线程，仅在原生创建时间落入本次观察期间时将首次日志视为新观察；延迟导入或创建时间不明的旧记录先建立历史基线。文件替换、截断及观察中断后重新确认状态。

`Done` 是用户在看板中完成验收后记录的私有状态，保存在插件数据目录的数据库内。用户之后发送的新输入会让验收失效，聊天重新进入工作流程；系统触发的回合不会自动取消验收。验收与重新打开工具仅向 app 开放，模型不能自动替用户验收。默认隐藏归档聊天、子 Agent 和自动化聊天。

支持在 `Review` 与 `Done` 之间拖动卡片：拖入 `Done` 完成验收，拖回 `Review` 撤销验收并按当前事件重新分类。卡片聚焦后也可用 `Alt+→` 验收、`Alt+←` 重新打开；过期记录不能写入，`InProgress` 卡片不支持手动移动。拖动期间延后自动刷新，结束后追平数据。

卡片名称优先读取原生 `threads.name`；该值为 NULL、空字符串或纯空白，或数据库没有 `name` 列时，回退到 `threads.title`。名称随原生重命名更新，搜索按卡片展示名称匹配。项目选择在工具栏左侧，以项目名和下拉箭头展示；点击打开圆角浮层，可搜索项目名称或完整路径，列表限高滚动，方向键与 Enter 选择，Escape 或点击外部关闭。右侧搜索图标打开居中搜索面板，列出当前筛选范围内的匹配聊天。支持方向键选择、Enter 打开原生聊天，Escape 或点击遮罩关闭并保留查询；输入聚焦时保持无边框，长标题最多显示两行。刷新及明暗切换均使用图标。默认跟随宿主主题，手动切换仅影响当前页面；重新打开后恢复跟随宿主。

三栏按最高一栏自动拉伸，底部始终对齐；筛选、刷新及卡片移动后自动重新布局。窄面板保留三栏，通过横向滚动浏览。

明暗主题覆盖整个看板画布；HTML 的 `theme-color` 同时声明宿主明暗背景色。宿主生成的顶部应用标题和外层区域由 Codex 控制，页面内的手动主题切换只影响看板。

历史会话文件缺失时不显示全局错误横幅，卡片仍保留状态待确认、数据过期与禁止验收的保护；MCP 返回的读取错误保持完整。数据库读取失败、会话格式异常等其他错误仍显示。

卡片项目标签仅展示文件夹图标和项目名称。右下角消息徽标显示含 `event_msg → item_completed → UserMessage` 完成事件的用户回合数，以 `turn_id` 去重；同一回合内多次输入计一次，系统回合不计。半行追加完成后才计入。无法读取时显示 `—`；旧格式用户事件、旧索引缓存或尚未写完的记录用虚线徽标说明数量仅为已确认的下界。旧缓存继续复用，避免为计数重新扫描全部记录；文件重新建立完整基线后可恢复完整计数。

项目选择和卡片项目标签优先使用原生数据库同目录下 `.codex-global-state.json` 中 `local-projects` 保存的名称，仅按 `rootPaths` 与线程 `cwd` 精确匹配。没有名称、元数据无法读取或同一根目录对应多个名称时显示目录名。同名项目补充最短可区分的上级目录，提示中保留完整路径。名称只用于展示，筛选仍使用原工作目录，不推断子目录的项目归属。

首次打开需要建立会话索引，界面显示读取提示。插件私有数据库保存可丢弃的事件索引缓存，仅包含线程/回合/用户事件标识、字节位置和尾部哈希，不保存消息正文、原始尾部或半行。重开时校验文件身份、大小和哈希，匹配后只补读新增部分；缓存失效或损坏时重新完整读取。缓存不把历史未结束回合认定为仍在执行。

## 构建与验证

运行环境需要 Node.js 26 或更新版本（使用内置 `node:sqlite`）。依赖使用 lockfile 固定，运行以下命令：

```sh
npm ci
npm run build
npm test
```

构建产物位于 `plugins/codex-taskboard/dist/`，包含打包后的 MCP 服务、HTML 和前端脚本；不需要复制 `node_modules`。构建与协议测试通过只证明相应代码和 MCP 行为，安装后必须实际打开 Codex Sidebar UI，确认入口、工作区筛选、三列状态、手动验收、重新打开和错误提示均正常后，才可宣称客户端验收完成。

## 安装 prompt

复制以下 prompt 给 Codex，可让它完成本地构建与插件安装：

```text
请帮我安装 Codex TaskBoard 插件，仓库地址为：
https://github.com/huangdijia/codex-taskboard

优先使用本地已有的仓库；没有时克隆到合适的工作目录。保留已有未提交改动，并按仓库 README 完成以下步骤：
1. 检查 Codex CLI、npm 和 Node.js 是否可用，Node.js 需要 26 或更新版本。缺少依赖或版本不满足时，说明具体问题。
2. 在仓库根目录执行 npm ci、npm run build 和 npm test，确认构建与测试通过。
3. 将仓库绝对路径加入本地 marketplace：codex plugin marketplace add <仓库绝对路径>。路径含空格时使用 shell 引号；已注册相同来源时复用。
4. 执行 codex plugin add codex-taskboard@taskboard-local 安装或更新插件，再用 codex mcp list --json 核对 MCP 配置。
5. 重载客户端插件配置，从侧栏打开 Codex TaskBoard，检查入口、工作区筛选、InProgress / Review / Done 三列和错误提示。手动验收与重新打开由我操作验证，不要自动替我验收聊天。

若出现 unknown MCP server 'codex-taskboard'，提示我重载宿主窗口或重启 Codex。最后报告构建、测试、插件安装、MCP 配置和客户端检查的实际结果；无法完成的检查明确列为待验证。
```

## 本地安装

在仓库根目录构建后，将本地仓库加入 marketplace，再安装插件：

```sh
codex plugin marketplace add /absolute/path/to/TasksBoard
codex plugin add codex-taskboard@taskboard-local
codex mcp list --json
```

重载客户端的插件配置，然后从侧栏打开 **Codex TaskBoard**。这些命令是安装说明，仓库构建不会安装插件。

更新已安装的本地插件时，重新构建并执行同一条 `codex plugin add` 命令，再重载 Sidebar 内容。若宿主提示 `unknown MCP server 'codex-taskboard'`，需要重载宿主窗口或重启 Codex，让全局 Sidebar 的 MCP 会话重新加载插件。

插件清单为 `plugins/codex-taskboard/.codex-plugin/plugin.json`，MCP 配置为 `plugins/codex-taskboard/.mcp.json`。启动器优先使用宿主提供的 `CODEX_MCP_NODE_PATH`；本地 CLI 未提供时使用 PATH 中的 `node`。路径通过 shell 引号保护，支持含空格的 Node 可执行文件路径。

## MCP API

| 工具 | 参数 | 返回 | 可见范围 |
| --- | --- | --- | --- |
| `taskboard.open` | `{}` | 聊天列表与读取状态 | app，global 入口 |
| `taskboard.list_threads` | `{query?, cwd?, showArchived?, showSubagents?}` | 聊天列表与读取状态 | model、app |
| `taskboard.accept_thread` | `{threadId, expectedRevision}` | `{thread}` | app |
| `taskboard.reopen_thread` | `{threadId, expectedRevision}` | `{thread}` | app |

查询默认值为 `query: ''`、`cwd: ''`、`showArchived: false`、`showSubagents: false`。列表返回 `threads`、`counts`、`workspaces`、`stale`、`lastSuccessfulReadAt` 和 `errors`；每个聊天包含 ID、标题、工作目录、更新时间（毫秒）、状态、状态原因、不透明字符串 `revision`、归档/子 Agent 标记、来源类型和陈旧标记。`messageTurnCount` 为已确认用户回合数或 `null`，`messageTurnCountIncomplete` 表示记录覆盖不完整。写操作需要最新列表中的 `revision`，冲突时重新读取并由用户再次操作。

## 数据路径与测试覆盖

默认原生数据库路径为 `$CODEX_HOME/state_5.sqlite`；未设置 `CODEX_HOME` 时使用 `~/.codex/state_5.sqlite`。MCP 配置显式将宿主的 `${PLUGIN_DATA}` 占位符传入 `PLUGIN_DATA`，私有数据库优先保存在该插件目录中。本地 CLI 未提供数据目录或未解析占位符时，使用 `$CODEX_HOME/plugin-data/codex-taskboard`（默认 `~/.codex/plugin-data/codex-taskboard`）。服务始终向 store 传入明确的数据目录，避免向当前工作目录写入数据。

测试或隔离开发可覆盖原生数据库路径和插件数据目录：

```sh
TASKBOARD_CODEX_DB=/absolute/path/to/fixture/state_5.sqlite \
TASKBOARD_DATA_DIR=/absolute/path/to/private-test-data \
node plugins/codex-taskboard/dist/server.mjs
```

`PLUGIN_DATA` 优先于 `TASKBOARD_DATA_DIR`，两者未设置或仍含未解析的 `${...}` 占位符时使用上述私有目录 fallback。`TASKBOARD_CODEX_DB` 仅改变只读数据源，验收记录仍写入私有目录。MCP 通过 stdin/stdout 通信，诊断输出使用 stderr。
