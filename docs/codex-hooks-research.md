# Codex Hooks 与 harness 调度边界

研究日期：2026-10-08。本文记录接口核查和设计建议，不表示已实现或用户已确认选型。交卷通道的比较见 [配套研究](codex-submission-options-research.md)。

## 核查结果

当前 Codex 原生支持生命周期 hooks，可运行脚本或 MCP 工具。相关入口包括 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop、Interrupt。配置来自 hooks.json 或 config.toml；非托管 hook 必须先信任当前定义。PostToolUse 可以追加上下文，但不覆盖所有工具路径，例如 hosted WebSearch 不走该路径。[官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks)

Stop 返回 `decision: "block"` 与 reason 会发起继续执行的输入，不是把业务 Task 设置为 blocked。输入中的 stop_hook_active 表示此前是否已被 Stop 续跑。SubagentStop 对应 Codex 原生子代理，不能直接等同于 harness 为每个 Unit 创建的独立线程。[Stop 行为](https://learn.chatgpt.com/docs/hooks#stop)

App Server 的 item、turn、tokenUsage 通知适合记录运行；hook/started、hook/completed 只报告同步 hook。动态工具允许客户端响应 item/tool/call，目前仍需实验 API 开关。[App Server 文档](https://learn.chatgpt.com/docs/app-server)

## 本机证据与验证范围

本机 npm CLI 为 `codex-cli 0.157.1`，`codex features list` 显示 `hooks stable true`。这只确认功能开关，不能证明特定 hook 已受信或执行。

实际执行了以下本地命令，没有调用模型：

```powershell
codex app-server generate-ts --experimental --out output/research/codex-0.157.1-protocol
```

生成成功。类型中存在：

| 本机类型 | 已核实字段 / 方法 |
| --- | --- |
| v2/ThreadStartParams.ts | dynamicTools |
| v2/TurnStartParams.ts | outputSchema |
| ServerRequest.ts | item/tool/call |
| ServerNotification.ts | hook/started、hook/completed |
| v2/DynamicToolCallParams.ts | threadId、turnId、callId、namespace、tool、arguments |
| v2/HookRunSummary.ts | 事件、运行状态、来源、起止时间、durationMs |

协议文件保存在上述 output 目录，属于版本核查产物，不是项目手写源码。未配置或信任新 hook，未运行真实 Unit，也未测试 SDK 启动进程时的配置加载、取消、崩溃与恢复。因此这是文档及本机接口验证，尚非端到端兼容验收。

## 对本项目的建议

配套 CLI 可以做，但应作为统一业务 API 的一个入口。MCP 或 App Server 动态工具同样调用这份 API；首版只需实现一个 agent 入口。CLI 方便人工调试和 Command Unit，结构化工具方便 Agent Unit。具体接入方式尚待确定。

建议的职责边界：

| 层次 | 负责什么 |
| --- | --- |
| Harness 基础能力 | 绑定调用者和当前执行、校验结果、保存提交凭证、固定产物版本、发送事件、维护状态 |
| TaskType 工作流 | 定义哪些结果合法、触发谁、何时完成、返修和重试上限 |
| Skill | 指导如何工作、报告怎么写、如何选择或配置 TaskType |
| Hook 适配器 | 在运行生命周期节点调用检查或补充上下文，不独立拥有业务状态 |

拟议交卷流程：Unit 显式提交结果 → harness 校验并持久化 → 当前写入活动结束且产物版本确定 → TaskType 规则选择下一步。工具调用成功只证明请求被处理，不能直接视为整个 Task 完成。无 reviewer 的默认类型允许 worker 交付；有 reviewer 的默认类型要求对应候选版本审查通过。

Stop hook 可做“遗漏交卷提醒”：查询当前正式执行是否已有有效结果，若没有则提醒 agent 提交结果或说明阻塞。最多补提醒若干次，之后由宿主记录异常并停止推进；次数由配置确定。普通聊天、已完成 Unit 回信不应触发正式交卷检查。即便 hook 没运行，调度器也不能放行缺少有效交付的 Task。

不要让 Stop hook 自动启动 reviewer 后再等待 reviewer 结束：这样会把调度、错误恢复和时限控制埋进回调。让调度器统一处理 Unit 的后继动作，也便于重启后恢复。

收信方面，PostToolUse 注入上下文是可研究的辅助路径，但 agent 不调用工具时就缺少触发机会。建议 Mailbox 仍由宿主管理持久化与投递，沿用已讨论的运行中输入和后续 turn 语义；不要把所有消息交付绑定到工具 hook。

统计同样由宿主消费运行事件并关联 Unit。Hook 可补检查记录，不能作为“全部工具调用”或实际账单的唯一来源。费用仍需区分 usage 与估算金额。

## 实现时的最小验证

验证正常交卷、未交卷后补交、重复提交、已阻塞后正常停止、普通来信答复、用户取消、hook 不可用这几条路径。验收重点是不会重复调度、不会无限续跑、不会把 turn 结束当成 Task 完成，以及 reviewer 读取的确为已固定的候选版本。
