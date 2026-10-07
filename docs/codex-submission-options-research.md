# Codex 显式交卷通道研究

研究日期：2026-10-08。适用项目：本地 Codex Web 工作台，采用 Project、Task graph、TaskType、Task、Agent Unit / Command Unit 术语。本文是研究记录，不是已实现功能。

本轮实际打开官方文档，并在文档细节不足时读取其链接的 OpenAI 官方源码。没有安装 SDK、运行模型推理、启动交卷服务或修改全局配置。本机 npm Codex 0.157.1、未安装 SDK 是主任务给定的环境信息；本文没有把当前官网及 main 源码等同于该版本的已验证能力。

## 建议先确定交卷契约

以下是架构建议。

把交卷定义为 harness 接收、验证并持久化的业务请求。Agent 通过哪个工具发出请求，可以在后续替换。Agent 提交成果后，TaskType 决定是否还需 Command Unit 验证、Reviewer 审查或返工。只有 harness 有权将 Task 标记为完成并放行下游依赖。

推荐流程为：Agent Unit 产出候选成果，调用 `submit_unit_result`，harness 验证调用者、执行批次和产物，记录 submission，按 TaskType 派发下一步。`submit_unit_result` 是本项目拟议名称，不是 Codex 内置工具。

接收交卷与允许下游读取产物应当分别处理。如果 Agent 交卷后当前 turn 尚在运行，程序可先记录 submission，再等待运行停止并封存产物版本。这样既不把 turn 结束当业务完成，也避免 Reviewer 与仍在写文件的 Worker 同时使用可变目录。另一种方案是交卷时就创建不可变快照。

## 已核实的接口事实

### TypeScript Codex SDK

官网列出的 `@openai/codex-sdk` 在服务器端运行，支持启动、继续及恢复本地线程，要求 Node.js 18+。[官方 SDK 文档](https://learn.chatgpt.com/docs/codex-sdk#typescript-library)

官方 TypeScript README 与实现表明，它封装 Codex CLI，通过子进程及 JSONL 通信；当前 `exec.ts` 启动 `codex exec --experimental-json`。这不是 App Server JSON-RPC 客户端。[官方 TypeScript README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)、[exec.ts](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)

`thread.run()` 收集结果后返回 `items`、字符串 `finalResponse` 和 `usage`；`thread.runStreamed()` 返回含 `events` 异步生成器的对象。两者都接收每轮的 `outputSchema`。`runStreamed()` 不替调用者汇总 finalResponse，调用者需消费事件并保存所需结果。[thread.ts](https://github.com/openai/codex/blob/main/sdk/typescript/src/thread.ts)、[TurnOptions](https://github.com/openai/codex/blob/main/sdk/typescript/src/turnOptions.ts)

其事件类型包括 `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.started`、`item.updated`、`item.completed` 和 `error`。`item.completed` 也可能对应失败的工具项，因此不能把这个名字理解为工具成功。[events.ts](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts)

在本次读取的公开 `CodexOptions`、`ThreadOptions`、`TurnOptions` 与执行实现中，未发现类似 `tools: [{ execute() {} }]` 的 JavaScript 工具回调注册接口。这个结论限定于已读的当前接口，不能扩大为“Codex 不支持自定义工具”。SDK 提供 CLI config overrides，工具扩展可走所启动 Codex 的 MCP 配置。[CodexOptions](https://github.com/openai/codex/blob/main/sdk/typescript/src/codexOptions.ts)、[ThreadOptions](https://github.com/openai/codex/blob/main/sdk/typescript/src/threadOptions.ts)、[TurnOptions](https://github.com/openai/codex/blob/main/sdk/typescript/src/turnOptions.ts)、[SDK 配置说明](https://github.com/openai/codex/blob/main/sdk/typescript/README.md#passing---config-overrides)

不要因为方法名包含 Streamed 就假定它暴露与 App Server 相同的逐段文本通知或服务器请求回调。TypeScript SDK 暴露的是上述 CLI 事件模型；App Server 则另有 `item/agentMessage/delta` 等通知。[SDK 事件定义](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts)、[App Server 文档](https://learn.chatgpt.com/docs/app-server)

### Python Codex SDK 是另一套客户端

官网当前也列出稳定版 `openai-codex`。它通过 JSON-RPC 控制本地 App Server，要求 Python 3.10+，发布包带有固定版本的 CLI runtime 依赖。不能把 TypeScript 的 CLI 子进程实现推广为所有 Codex SDK 的共同实现。[官方 Python SDK 说明](https://learn.chatgpt.com/docs/codex-sdk#python-library)

Python 官方 API 使用 `thread.run(..., output_schema=...)` 或 `thread.turn(...)` 获取 TurnHandle，后者提供 `stream()`、`steer()`、`interrupt()`。接口与 TypeScript 的 `runStreamed()` 不同。本轮没有确认 Python 高层 API 可直接注册 dynamicTools，因此不据此宣称 Python 已提供同等自定义工具封装。[Python API reference](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md)

### App Server dynamicTools

文档明确将 `thread/start.dynamicTools` 和 `item/tool/call` 标为实验 API，初始化须声明 `capabilities.experimentalApi = true`。动态工具会保存在 thread rollout 元数据中，恢复线程且未提供新定义时会恢复这些工具。[实验 API 与线程说明](https://learn.chatgpt.com/docs/app-server#experimental-api-opt-in)

调用顺序为 `item/started`，服务器向客户端发送 `item/tool/call` 请求，客户端返回工具内容，最后收到 `item/completed`。因此本地后端可以直接实现交卷处理函数。[Dynamic tool calls](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental)

源码核对时定位到官方 commit `1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d`。该版本的调用参数包含 `threadId`、`turnId`、`callId`、`namespace`、`tool`、`arguments`，响应包含 `contentItems` 与 `success`。这些字段提供关联信息，不能代替本项目自己的业务身份检查。[请求类型](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallParams.ts)、[响应类型](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallResponse.ts)

文档提供 `codex app-server generate-ts` 与 `generate-json-schema`，生成结果对应执行它的 CLI 版本。实现时应据选定的本地版本生成类型，尤其不能直接把当前 main 的动态工具定义形状复制到 0.157.1。[App Server 协议说明](https://learn.chatgpt.com/docs/app-server)

### MCP 工具

Codex 可连接外部 MCP 服务，支持本地 STDIO 进程及 Streamable HTTP。MCP 配置可位于用户或项目级 config，支持工具允许名单、禁止名单、超时，以及用 `required` 要求服务初始化成功。[MCP 官方配置文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

本项目可以自行提供仅含 `submit_unit_result` 等有限工具的 MCP 服务。这是架构建议；工具接收、鉴权、持久化及调度都属于 harness 的实现责任。不要把“看到了 mcpToolCall 成功事件”直接作为业务数据库的交卷凭证，应以交卷服务实际写入的 submission 为准。

需要区分两个方向：Codex 连接我们的 MCP 工具仍有官方支持；将 Codex 本身作为 MCP server 是另一回事，当前 SDK 官网称 `codex mcp-server` 与独立 `codex-mcp-server` 已删除，并建议旧集成迁移至 App Server。该现状不能反推 0.157.1 的命令清单。[SDK 官方迁移提示](https://learn.chatgpt.com/docs/codex-sdk)

### 结构化最终输出

CLI 的 `--output-schema` 约束最终响应形状；`--json` 输出运行事件 JSONL。它们承担不同用途。TypeScript SDK 的 `outputSchema` 对应前者，最终结果仍以字符串读取及解析。[非交互模式文档](https://learn.chatgpt.com/docs/non-interactive-mode#create-structured-outputs-with-a-schema)、[SDK 输出实现](https://github.com/openai/codex/blob/main/sdk/typescript/src/thread.ts)

App Server 也支持 `turn/start.outputSchema`，只对当前 turn 生效。`turn/completed` 的状态可能是 `completed`、`interrupted`、`failed`，其语义是运行结束。[App Server 回合配置与事件](https://learn.chatgpt.com/docs/app-server)

架构建议：最终 JSON 可明确表示 `submit`、`blocked` 或 `continue`，由适配器转换为统一交卷请求。Schema 验证通过仅说明形状满足约束；是否做完、产物是否有效仍由 TaskType 的完成条件判定。

### Hooks 的位置

官方已有 Hooks，包含 `PreToolUse`、`PostToolUse`、`Stop` 等生命周期事件，并允许在 turn 停止时运行检查。因此“Codex 没有 hooks”已经不符合当前官方文档。[官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks)

架构建议：Hooks 可以发现“Agent 停下但未交卷”，或补充审计与检查；交卷仍应携带明确业务内容。Stop 是生命周期触发条件，不能自行证明某个 Unit 已满足完成条件。Hooks 具体版本兼容及阻止停止语义由主研究单独核查。

## 四种交卷方式比较

此表是基于上述接口事实的项目建议，不是官方推荐排序。

| 方式 | Agent 如何交卷 | 适合之处 | 本项目需承担的代价 |
| --- | --- | --- | --- |
| 配套 CLI | 通过 shell 调用 `harness submit --file result.json` | 便于人工复现；Agent Unit 和普通脚本可共用 | 实现 CLI、身份绑定和返回码；处理 shell quoting、可执行文件发现及沙箱访问 |
| MCP 工具 | 调用本地交卷服务的结构化工具 | 跨 CLI、SDK、App Server 接入；协议职责清楚 | 维护 MCP 服务生命周期与配置；为并发 Unit 绑定身份 |
| App Server dynamicTools | Agent 调工具，Web 后端响应 `item/tool/call` | 调用直接到工作台后端；带线程和回合标识 | 接受实验 API；固定并验证 CLI 版本；实现请求回复和断线恢复 |
| 结构化最终输出 | 本轮最终 JSON 明确发出提交意图 | 首版或单次运行接入最少 | 只能在最终输出处处理；与面向用户的自然语言最终答复争用输出位置；需区分继续、受阻和交卷 |

如果工作台本来就需要交互流、审批和会话管理，优先评估 App Server，交卷可用 dynamicTools；其接入简洁度值得用本机兼容验证换取。如果不愿把核心交卷绑定到实验 API，使用 MCP。配套 CLI 可作为人工调试及 Command Unit 的入口。无需为了首版同时实现四套承载通道。

## 建议的最小业务协议

以下字段均为本项目建议，并非 Codex 固定格式。

```json
{
  "schemaVersion": 1,
  "unitRunId": "urun_123",
  "attemptId": "attempt_2",
  "submissionKey": "submission_abc",
  "intent": "submit",
  "summary": "已完成实现并提供验证结果",
  "artifacts": [
    { "kind": "file", "path": "reports/result.md", "digest": "sha256:..." }
  ],
  "checks": [
    { "name": "unit-tests", "result": "passed", "evidence": "reports/tests.txt" }
  ]
}
```

程序从受信绑定中确定实际 Unit 和 attempt；不能让 Agent 仅靠填写别人的 `unitRunId` 就替其交卷。`submissionKey` 作为幂等键，重复请求返回同一 receipt；内容冲突则拒绝。工具返回应区分 `accepted` 与 `rejected`，并提供持久化的 `submissionId` 或可修正的错误。

Agent 的 `checks` 是声明；配置了 Command Unit 的项目应读取实际进程退出码与验证产物。交卷被接受只表示提交记录有效，可能还需 Reviewer 或其他 Unit。Reviewer 的 verdict 也应引用明确的候选 submission 与产物版本。

TaskType 建议明确配置：各 Unit 交付物 schema、必要验证、Reviewer 判定、重试次数、运行上限及 Task 完成规则。Task 运行时保存配置快照，后续编辑模板不改变正在执行的验收条件。

## 实现前仍需本机验证

- 主研究已用 npm Codex 0.157.1 生成带实验接口的协议类型，确认 dynamicTools、item/tool/call、outputSchema 和 hook 通知存在，详见 [本机核查记录](codex-hooks-research.md)。实际调用及恢复规则仍未端到端验收。
- 如果选 SDK，固定 SDK 和运行时版本后，验证 outputSchema、失败事件、取消以及中途异常，不以本机已装 CLI 版本推定 SDK 使用同一运行时。
- 做最小交卷试验时检查重复调用、错误产物、过期 attempt、交卷后仍写文件、服务重启及失败后重试。该试验需另行执行，本研究没有调用模型。
- 首版先完成一个通道到数据库再到下一 Unit 的完整流程，再按实际需求增加其他适配器。
