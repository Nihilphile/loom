# 架构与接口

2026-10-08 更新：Unit Config／Context、输入接收记录、独立只读侧聊和开发者自动访谈已实现。调度与 Preparation 保持内部能力。具体执行契约见 [unit-execution.md](unit-execution.md)，验证结果见 [Iteration 3 验收](reports/iteration-3-acceptance.md)。

2026-10-20 集成契约替换旧的依赖工作区组装与整图最终汇总。每个 Graph 的集成分支逐 Task 推进，Task 的验收候选进入持久交付队列。历史验收报告保留当时的行为，不作为本次队列验证证据。

每个项目由独立 HarnessEngine 管理状态。项目注册表保存稳定 ID 与规范路径，HTTP 服务保留已经打开的执行器直到退出。浏览器切换只改变请求地址，不替换后台执行器。HTTP 和 CLI 只请求领域操作，runtime/Git 只执行外部效果并返回事实。TaskType 规则为数据，状态不根据模型自然语言推断。

## 使用方式

`npm run dev` 启动 localhost:4317。打开一个项目，创建自由会话或 Graph，点击运行。Agent 由启动提示得知 `node <cli路径> unit report --outcome ready --report <文件>`；凭据在子进程环境中，不要求 agent 填运行 ID。

```ts
const engine = new HarnessEngine(projectRoot, runtime, git, catalog);
const session = engine.createSession({title: '调查接口'});
await engine.sendMessage(session.id, '说明现有认证流程');
const graph = engine.createGraph({name: '认证改造', tasks: [...]});
await engine.runGraph(graph.id);
await engine.pauseGraph(graph.id, 'soft');
```

## 模块与数据所有权

会话输入由 SessionInputs 统一组装和确认。它持有领域规则，不独立写数据库。Engine 仍独占 Task 状态及 ProjectStore 写事务，Runtime 返回接受、拒绝、未知和结束事实。原型接口直接采用新契约。

- `src/shared/types.ts`：项目、Session、Task、Graph、Letter、模板与适配器契约。不是 Codex wire 类型。
- `src/server/store.ts`：SQLite 保存权威 state 和 append-only events，事务提交。协调器独占写入。报告固定副本位于 .newharness/reports，项目下预留 .session 与 taskgraph 目录供按会话/图导出。
- `src/server/engine.ts`：唯一状态所有者，运行身份、调度、工作区占用、报告与暂停恢复。外部效果开始前保存 execution/effect 意图，外部执行不占用同步状态事务。
- `src/server/session-inputs.ts`：生成不可变的输入快照，按已接受来源选择增量，集中初始化状态和信件占用判断。
- `src/server/runtime.ts`：真实 Codex 适配器。handle 的 accepted 与 done 分别返回输入接收和执行结束事实；原生 fork 固定最近已完成轮次，观察会话使用隔离权限。
- `src/server/observer-tools.ts`：只读 MCP 服务，限定文件根目录、拒绝私有数据和越界文件，不提供写入或网络能力。
- `src/server/git.ts`：托管 worktree、自动 snapshot、隔离合并与原子发布；shell 参数始终分离。操作 ID 和 Git 回执允许核对已产生的结果。
- `src/server/http.ts` / `main.ts`：loopback HTTP、请求校验、SSE、静态页面与启动。
- `src/cli.ts`：配套 CLI，通过 loopback API 汇报与发信，不直接改数据库。
- `web/`：正式前端，使用公开 API 与类型，不复制调度规则。

运行环境：Node 24+；TypeScript 服务与静态 TypeScript Web UI，Vite 仅负责前端打包。SQLite 使用 Node 内置接口。旧 task-graph 数据是开发管理，不被产品代码导入。

## HTTP 契约

返回 JSON；错误使用非 2xx 与 `{error: string}`。以下项目路由的 `/api` 前缀在新客户端中均使用 `/api/projects/:projectId`。GET `/state` 返回 `AppState`，SSE `/stream` 的 `state` 消息同形，含 `project.id`。原无项目 ID 路由仅绑定固定启动项目；带凭据的旧回调按凭据查找所属执行器。浏览器选择不改变这些路由。

全局 GET `/api/projects` 返回项目列表，POST `/api/projects` 接收 `{path,name?}` 并返回项目描述。同一规范路径重复注册返回同一 ID。运行时发现、附件、消息队列等第二轮接口见 [iteration-2.md](iteration-2.md)。CLI 通过 HARNESS_PROJECT_ID 给所有命令加项目路由。

| 方法  | 路径                                                  | 输入 / 输出                                            |
| ----- | ----------------------------------------------------- | ------------------------------------------------------ |
| POST  | /api/project                                          | `{path}` → AppState                                    |
| POST  | /api/sessions                                         | `{title, model?, reasoning?}` → Session                |
| POST  | /api/sessions/:id/turn                                | `{text}` → Session，异步执行                           |
| POST  | /api/sessions/:id/interrupt                           | `{}` → Session                                         |
| POST  | /api/sessions/:id/sidechats                           | `{title?}` → 独立只读 Session                          |
| POST  | /api/sessions/:id/interviews                          | `{}` → 自动运行的 Feedback                             |
| PUT   | /api/developer/interviews                             | InterviewSettings → 保存的开发者配置                   |
| POST  | /api/sessions/:id/preparations/:preparationId/resolve | `{accepted,threadId?,turnId?}` → 人工核对后的输入回执  |
| GET   | /api/events?sessionId=&graphId=&after=                | HarnessEvent[]                                         |
| POST  | /api/graphs                                           | GraphInput → Graph                                     |
| POST  | /api/graphs/:id/run                                   | `{}` → Graph                                           |
| POST  | /api/graphs/:id/pause                                 | `{mode:"soft"\|"hard"}` → Graph                        |
| POST  | /api/graphs/:id/resume                                | `{}` → Graph                                           |
| POST  | /api/graphs/:id/resolve                               | `{taskId?}` → Graph，重新检查实际阻塞                  |
| PATCH | /api/graphs/:id/tasks/:taskId                         | `{title?,goal?,deps?,...}` → Task                      |
| POST  | /api/graphs/:id/tasks                                 | TaskInput → Task                                       |
| GET   | /api/graphs/:id/debug                                 | 含 Git 版本与内部动作的调试数据，不含凭据              |
| POST  | /api/letters                                          | LetterInput → Letter                                   |
| POST  | /api/catalog/agents                                   | AgentTemplate → AgentTemplate                          |
| POST  | /api/catalog/task-types                               | TaskType → TaskType                                    |
| POST  | /api/unit/report                                      | Bearer 运行凭据 + `{outcome,report,key?}` → Submission |
| GET   | /api/reports/:id                                      | 固定报告内容                                           |

## 不变量

接受 report、turn 正常结束、代码被固定、审查通过、集成验证和发布是不同事实。只有当前执行凭据有效，报告存在且路径受限时才保存回执。同一 session 不并发启动 turn。普通来信处理不要求交卷，也不改完成状态。

先保存效果意图，再启动进程或 Git。启动恢复时不自动派发；未知外部效果需要检查，不能仅把旧 running 改为 idle 就继续写入。软暂停关闭派发入口，硬暂停还等待中断确认，工作区安静后才能编辑。

Reviewer 首版可用只读模式；仅在实际权限接口验证后才开放新增测试目录写入。Agent 的 prompt 不是权限边界。Git 元数据默认不发送到 agent 输入。

## Graph 集成队列

Engine 拥有队列和全部状态写事务，Git 适配器负责真实工作区与发布效果。队列不增加新的调度 Agent 或通用作业系统。每个 Graph 同时最多一次集成，等待交付不占用 Agent 并发名额。

| 数据 | 含义 |
| --- | --- |
| `GraphInput.integrationCommand` | 创建 Graph 时可选的集成验证命令 |
| `Graph.integrationCommand` | 创建后固定的验证配置，区别于 TaskType Command Unit |
| `Graph.integration.headSha` | 已核对的 Graph 集成分支 HEAD |
| `Graph.integration.deliveries` | 持久 `TaskDelivery` 记录，保留候选、尝试、验证与发布事实 |
| `Task.startCommit` | 创建工作区之前固定的 Graph 集成起点 |
| `TaskDelivery.id`、`taskId`、`sourceSha` | 交付身份、所属 Task 与已验收的固定源候选 |
| `TaskDelivery.state.status` | `queued`、`integrating`、`blocked`、`published` 或 `superseded` |
| `IntegrationReceipt.baseSha`、`integratedSha` | 本次发布之前的集成提交与实际发布提交 |
| `IntegrationReceipt.validation` | `not_configured` 或包含命令和输出的 `passed` 记录 |
| `Task.deliverySha` | 成功发布后记录的源候选 SHA，实际集成提交见发布回执 |
| `Graph.mirrorWarning` | 发布成功后 Graph worktree 镜像未同步的诊断 |

Task 的 `merge_queued` 表示候选等待集成，`integrating` 表示正在合并或验证，`done` 表示已经发布。Task 的 `queued` 继续用于运行中追加的等待屏障，不能把这两种队列合并。交付记录中的 `queued` 属于 `TaskDelivery`，不是 Task 追加状态。

启动 Task 时，Engine 先检查每个前置 Task 已发布，再保存当前集成 HEAD 为 `Task.startCommit`。Git 的 `createTask(graph, taskId, startCommit)` 只从精确起点创建工作区，不接收依赖 SHA 列表。已经集成的独立成果可以进入此起点，活动工作区保持原有快照。

TaskType finish 保存固定源候选并入队。`integrateTask` 在独立集成工作区合并，验证实际合并结果，拒绝验证命令修改候选 HEAD 或代码。验证通过后原子更新 Graph 分支和操作回执。`integrationReceipt` 核对该操作的已发布结果，`integrationHead` 读取权威分支位置。源候选与实际集成提交可以不同，不能互换。

集成工作区在验证前保存固定的 `candidateSha`。验证产生的提交或未提交代码保留在现场，但同一基线上的重试必须先恢复该固定候选及干净代码，不能接纳上次被拒绝的修改。合并冲突的人工解决发生在固定候选之前。Graph 基线已经推进时，从原验收源创建新的集成候选并重新验证。

没有验证命令时保存明确的未配置结果。合并冲突或验证失败使该交付 blocked，Graph 分支保持原位，独立队列项可以继续。发布结果未知时先核对真实回执，不能假定分支未变或盲目再发布。显式 resolve 重试固定候选，不能把新的工作区修改悄悄作为原交付。全部 Task 发布后 Graph 只更新完成状态，旧 `mergeFinal` 操作已移除。

Graph worktree 是集成分支的 detached 镜像，分支是权威结果。发布后若镜像有外部修改或暂时未同步，保留文件并显示同步警告，不能 hard reset 掉用户修改。读取镜像文件之前需核对其同步状态。

软暂停阻止新出队，允许已开始的集成和验证收尾。硬暂停停止验证，在发布前检查取消并等待 Git 操作结束，已提交的发布保持有效。服务启动不运行命令，显式 resume 或 resolve 先核对回执及残留进程，再决定恢复。HTTP 等待这些异步操作完成后返回，避免把尚未核对的结果描述为已恢复。可能已发布的交付在编辑前也必须核对。

resume 和 resolve 的异步核对计入活动操作，期间禁止编辑。后来的暂停或关闭优先于尚未结束的恢复请求；硬暂停和关闭等待核对结束，旧请求不得重新启动调度。已经登记发布的交付如果缺少 Git 回执，或回执身份与固定源不符，恢复必须拒绝。

完全暂停后编辑未交付 Task 时，旧交付记录保留并标为 `superseded`，活动交付查询忽略这些记录。新候选产生新的交付身份，不能删除旧记录或覆盖其固定源提交。启动恢复中发布结果尚不明确时，先核对再允许编辑，避免把已经发布的成果误标为废弃。

未完成的旧 Graph 缺少新交付记录时，不能把旧 done 状态当成本次已验证发布。历史完成 Graph 保持可读；本次不引入通用旧状态迁移框架。完整返工、重开及逆向交付留待 [后续设计](../DESIGN-NOTES.md#返工与回退的后续设计)，squash 与 merge commit 的产品选择仍待决定。

## 设计比较与选择

独立候选 A 是单一协调器 + 原子状态，B 是事件溯源 + reducer + outbox。交叉评审按交卷正确性、恢复、Git 隔离、runtime 适配和 API 简洁评分，A 22/25，B 18/25。选择 A；吸收 B 的 SQLite 事务与稳定效果 ID，替代多文件 generation 提交。不引入事件重放作为状态恢复前提。

初版设计显式区分执行、汇报与任务交付，将 SDK/JSON-RPC 类型限制在 runtime 内，并用幂等操作避免重复报告产生重复调度。候选与评审记录在 output/architecture。逐 Task 集成队列沿用单一状态所有者，并进一步区分固定源候选与实际发布提交。

## 实施核对

本文接口与 `src/shared/types.ts` 描述当前契约，[Unit 执行准备](unit-execution.md) 记录输入与会话边界，其中伪代码用于解释确认顺序。实现新契约时同步替换类型和调用方，删除旧路径，不用类型断言或兼容别名掩盖差异。具体 Runtime 选择及经验证支持范围记录在各时间点的交付报告。
