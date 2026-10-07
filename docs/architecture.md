# 首版架构与接口

采用单一 ProjectCoordinator / HarnessEngine 管理项目状态。HTTP 和 CLI 只请求领域操作，runtime/Git 只执行外部效果并返回事实。TaskType 规则为数据，状态不根据模型自然语言推断。

## 使用方式

`npm run dev` 启动 localhost:4317。打开一个项目，创建自由会话或 Graph，点击运行。Agent 由启动提示得知 `node <cli路径> unit report --outcome ready --report <文件>`；凭据在子进程环境中，不要求 agent 填运行 ID。

```ts
const engine = await HarnessEngine.open(projectRoot, {runtime, git, catalog});
const session = engine.createSession({title: '调查接口'});
await engine.sendMessage(session.id, '说明现有认证流程');
const graph = engine.createGraph({name: '认证改造', tasks: [...]});
await engine.runGraph(graph.id);
await engine.pauseGraph(graph.id, 'soft');
```

## 模块与数据所有权

- `src/shared/types.ts`：项目、Session、Task、Graph、Letter、模板与适配器契约。不是 Codex wire 类型。
- `src/server/store.ts`：SQLite 保存权威 state 和 append-only events，事务提交。协调器独占写入。报告固定副本位于 .newharness/reports，项目下预留 .session 与 taskgraph 目录供按会话/图导出。
- `src/server/engine.ts`：唯一状态所有者，运行身份、调度、工作区占用、报告与暂停恢复。外部效果开始前保存 execution/effect 意图，外部执行不占用同步状态事务。
- `src/server/runtime.ts`：真实 Codex 适配器。`Runtime.start` 返回独立 handle，done 返回 completed/interrupted/failed；inject 明确返回是否接受。事件不等于业务交卷。
- `src/server/git.ts`：托管 worktree、自动 snapshot 与汇总；shell 参数始终分离。操作 ID 允许检查已产生的 Git 结果。
- `src/server/http.ts` / `main.ts`：loopback HTTP、请求校验、SSE、静态页面与启动。
- `src/cli.ts`：配套 CLI，通过 loopback API 汇报与发信，不直接改数据库。
- `web/`：正式前端，使用公开 API 与类型，不复制调度规则。

运行环境：Node 24+；TypeScript 服务与静态 TypeScript Web UI，Vite 仅负责前端打包。SQLite 使用 Node 内置接口。旧 task-graph 数据是开发管理，不被产品代码导入。

## HTTP 契约

返回 JSON；错误使用非 2xx 与 `{error: string}`。GET `/api/state` 返回 `AppState`，SSE `/api/stream` 的 `state` 消息同形。服务只管理一个当前打开项目；切换项目时不得遗弃活动执行。

| 方法 | 路径 | 输入 / 输出 |
| --- | --- | --- |
| POST | /api/project | `{path}` → AppState |
| POST | /api/sessions | `{title, model?, reasoning?}` → Session |
| POST | /api/sessions/:id/turn | `{text}` → Session，异步执行 |
| POST | /api/sessions/:id/interrupt | `{}` → Session |
| GET | /api/events?sessionId=&graphId=&after= | HarnessEvent[] |
| POST | /api/graphs | GraphInput → Graph |
| POST | /api/graphs/:id/run | `{}` → Graph |
| POST | /api/graphs/:id/pause | `{mode:"soft"\|"hard"}` → Graph |
| POST | /api/graphs/:id/resume | `{}` → Graph |
| POST | /api/graphs/:id/resolve | `{taskId?}` → Graph，重新检查实际阻塞 |
| PATCH | /api/graphs/:id/tasks/:taskId | `{title?,goal?,deps?,...}` → Task |
| POST | /api/graphs/:id/tasks | TaskInput → Task |
| GET | /api/graphs/:id/debug | 含 Git 版本与内部动作的调试数据，不含凭据 |
| POST | /api/letters | LetterInput → Letter |
| POST | /api/catalog/agents | AgentTemplate → AgentTemplate |
| POST | /api/catalog/task-types | TaskType → TaskType |
| POST | /api/unit/report | Bearer 运行凭据 + `{outcome,report,key?}` → Submission |
| GET | /api/reports/:id | 固定报告内容 |

## 不变量

接受 report、turn 正常结束、代码被固定、验收通过是四个不同事实。只有当前执行凭据有效，报告存在且路径受限时才保存回执。同一 session 不并发启动 turn。普通来信处理不要求交卷，也不改完成状态。

先保存效果意图，再启动进程或 Git。启动恢复时不自动派发；未知外部效果需要检查，不能仅把旧 running 改为 idle 就继续写入。软暂停关闭派发入口，硬暂停还等待中断确认，工作区安静后才能编辑。

Reviewer 首版可用只读模式；仅在实际权限接口验证后才开放新增测试目录写入。Agent 的 prompt 不是权限边界。Git 元数据默认不发送到 agent 输入。

## 设计比较与选择

独立候选 A 是单一协调器 + 原子状态，B 是事件溯源 + reducer + outbox。交叉评审按交卷正确性、恢复、Git 隔离、runtime 适配和 API 简洁评分，A 22/25，B 18/25。选择 A；吸收 B 的 SQLite 事务与稳定效果 ID，替代多文件 generation 提交。不引入事件重放作为状态恢复前提。

Model the Domain 决定显式区分执行、汇报、任务交付和 graph 汇总；Boundary Discipline 决定 SDK/JSON-RPC 类型停留在 runtime 内；幂等操作避免重复报告产生重复调度。候选与评审来自本轮 architect/arena，记录在 output/architecture。

## 实施核对

本文件与 shared/types.ts 是各切片接口约定。接入发现返回形状或状态不符时，由主控更新本文件及调用方再整合，不用类型断言掩盖。具体 runtime 选择及经验证支持范围将记录在交付报告。
