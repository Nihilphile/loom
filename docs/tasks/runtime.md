# 真实 Codex 会话执行

承接 SPEC R02、R03、R15 的运行时能力与 R12 的中断机制。实现冻结的 Runtime 接口，真实启动或恢复 Codex thread，单 turn 串行，返回真实事件、工具记录、usage、失败/中断状态。验证当前机器实际接口；禁止伪造支持。CLI 汇报凭据通过运行环境注入，不放入 UI。

验收：受控子进程协议验证取消、错误和退出；真实 Codex 小型调用证明文本和 thread 可恢复。活动注入必须验证或明确 capability=false。仅修改运行时及对应测试，不改调度器。输入：docs/architecture.md、src/shared/types.ts、docs/codex-submission-options-research.md。
