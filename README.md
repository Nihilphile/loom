# Loom

本地 Codex 工作台。自由会话和 Task 会话分区显示；DAG 按依赖调度，任务通过 CLI 交卷，程序执行审查、返修与 Git 快照。原型保留在 prototype/，正式界面由 web/ 提供。

## 启动

需要 Node.js 24+、Git 和已登录的 Codex。Windows 优先使用 Codex Desktop 自带的 codex.exe，也可设置 CODEX_CLI_PATH。

```powershell
npm ci
npm run dev
```

打开 http://127.0.0.1:4317 ，通过项目选择器输入本地文件夹的绝对路径。不存在的目录会新建并初始化 Git；已有目录保留原文件。加入过的项目保存在列表中，切换页面后原项目的会话和任务图继续执行。自由会话可用于一般目录；Task Graph 要求目录是有初始提交的 Git 仓库根目录。图从运行时的 HEAD 开始，不包含原目录未提交的修改。

也可以先构建，再指定项目启动：

```powershell
npm run build
npm start -- --project F:/your/project --port 4317
```

## 使用

1. Sessions 的“＋ 自由会话”创建独立 Codex 会话。每次后续消息恢复原 thread。
2. 新建 Graph，添加任务、依赖与 TaskType。内置“直接交付”和“实现与审查”。点击 Run graph 后，独立任务可以并行。
3. Worker 生成报告并调用配套 CLI。只有正常结束且报告有效，才进入 Reviewer 或完成。Reviewer 通过后，下游使用已固定成果。返修复用各自原会话。
4. 软暂停阻止新派发，等待当前 Unit 收尾。硬暂停中断执行并等待进程退出。完全暂停后可改任务目标；已创建工作区的依赖和已交付任务不能原地改写。
5. 每个 Unit 可查看会话、时间、Tool Calls、Input / Cached Input / Output Token 和收发件箱。Cached Input 是 Input 的子集，总量只相加 Input 与 Output。统计页提供会话、图、任务、成员和单次执行明细；旧执行缺少的数据标成未知。报告和 Letter 保存固定内容，修改源文件不会改变已发送内容。
6. Graph 完成只汇总到它自己的基线工作树。项目原分支不会自动合并或推送。Debug 可查看成果路径与提交。

自由会话支持模型和推理强度选择、`/` 命令菜单、`$skill` 检索与引用。模型和 Skill 从本机 Codex 查询。图片支持 PNG、JPEG、WebP，按原生图片输入发送；普通文件保存为可读文件引用。每个附件最大 10 MB，每条消息最多 12 个附件。

执行中可选择 steer 插入当前轮，或排队到后续轮。steer 的目标已经结束时会报错，不会自动改成排队。中断、失败或重启会暂停剩余队列，需要显式继续。上下文显示使用 Codex 返回的最近上下文量与窗口大小，缺少数据时显示未知。

## Agent CLI

正式构建后使用 `node <Loom目录>/dist/cli.js --help`。在仓库内也可运行 `npm exec -- loom --help`，包提供 `loom` 命令。启动器向 Agent 注入命令和凭据，无须让 Agent 自填身份。

```text
unit report --outcome ready --report <报告文件>
letter send --graph <图ID> --to <图/任务/成员> --title <标题> --file <文件> [--steer|--followup]
graph create --file <graph.json>
graph run --id <图ID>
graph pause --id <图ID> [--hard]
graph resume --id <图ID>
graph add-task --id <图ID> --file <task.json>
state
```

结果由 TaskType 规则约束，常用 ready、approved、changes_requested、blocked。报告提交期间重复相同请求返回同一回执；执行结束后凭据失效。标题最多 20 个 Unicode 字符。未来成员的信件在启动时注入；活动成员使用 steer，followup 等当前执行结束。已交付成员的答疑只读，不重新交付。Command Unit 不接收对话信件。

TaskType 的 units 可以包含 kind=command 和 command 字段。命令由本地程序执行，成功后自动绑定输出报告并汇报 ready；失败会阻塞。命令属于用户配置的本地脚本，具有当前操作系统账户的权限。

## 数据与权限

项目原名 New Harness，现在统一称为 Loom。本次只更改产品名称与 CLI 入口，保留 `.newharness` 数据目录、`HARNESS_*` 环境变量、Git 内部引用和浏览器项目选择键。已有会话、项目列表与工作区直接沿用，无须迁移。代码仓库所在文件夹也无须改名。

项目数据位于 `.newharness/state.sqlite`，状态和事件事务保存；报告位于 `.newharness/reports`，附件位于 `.newharness/attachments`，托管 Git 工作树位于 `.newharness/worktrees`。不删除这个目录来“重试”。全局 AgentTemplate 和 TaskType 位于 `~/.newharness/catalog.json`，项目列表位于 `~/.newharness/projects.json`。服务可通过 HARNESS_CATALOG 和 HARNESS_REGISTRY 指定其他文件。

运行适配器使用官方 Codex App Server，以支持运行中 steer 和中断。业务代码仅依赖 Runtime 接口。Windows 本机已验证 Codex 0.160.0；采用进程级 unelevated sandbox，不修改 Codex 全局配置。Reviewer 在独立报告目录执行，只读代码目录；本地汇报需要网络访问，因此不宣称网络隔离。CODEX_WINDOWS_SANDBOX 可显式指定 elevated，但此机器的 elevated helper 曾出现 ACL 错误。非 Windows 的细粒度权限尚未实机验收。

服务意外退出后不自动续跑。先检查阻塞说明、原进程和工作区，再显式恢复。旧进程仍存活时，程序拒绝再次执行。已结束但尚未完成的快照可通过解除阻塞重试同一操作。不要同时用别的编辑器修改正在运行的托管工作树。

## 首版边界

- 当前只开放独立 Task worktree；共享工作区的串行模式未开放。
- Reviewer 可写报告，尚未开放“只新增测试文件”的细粒度权限。
- TaskType 首版一个入口、按结果激活下一成员；多个 Task 可并行，同一 Task 不同时运行多个成员。规则编辑使用 JSON。
- Graph 引用节点、已交付任务重开及其下游失效、完整取消流程留待后续实现。
- 消耗统计只展示 Token，不计算模型费用。旧记录没有单次执行数据时，保留会话累计量并标明明细覆盖范围。

## 验证

```powershell
npm run typecheck
npm test
npm run build
```

默认测试不调用真实模型。运行真实适配器验收会使用本地 Codex 额度：

```powershell
$env:HARNESS_CODEX_SMOKE = '1'
$env:HARNESS_CODEX_PERMISSIONS_SMOKE = '1'
$env:HARNESS_CODEX_CONTROL_SMOKE = '1'
npx tsx --test tests/runtime.test.ts
```

真实浏览器及 Codex 图验收证据记录在 docs/reports/acceptance.md。设计契约见 docs/SPEC.md；施工图 `.task-graph` 仅用于开发管理，应用运行不依赖旧 task-graph。
