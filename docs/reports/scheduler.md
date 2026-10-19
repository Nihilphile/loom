# CLI 与调度交付

> 历史交付记录，代码提交为下文的 `09ad898`。整图最终汇总及旧依赖门槛描述不适用于 2026-10-20 的逐 Task 集成设计。原验证结论保留，当前调度契约见 [实施规格](../SPEC.md) 和 [集成队列](../architecture.md#graph-集成队列)。

src/server/engine.ts 是状态和调度的唯一写入者；src/cli.ts 提供报告、Letter 和图管理命令。Agent 凭据绑定当前执行，报告文件固定副本。正常结束与有效报告齐备后才创建快照并按 TaskType 规则推进。

验证见 tests/scheduler.test.ts 与 docs/reports/acceptance.md。真实浏览器创建的 reviewed A -> direct B 已完成，三个 Agent 均通过 CLI 报告，两个任务最终汇总到独立 Graph 基线。返修复用、漏报补报、重复/过期报告和路径越界由自动化覆盖。

Standards / Spec 两轴检查完成；已接受的生命周期缺陷已修复。原图数据仅管理施工，本实现不导入旧 task-graph。首版只开放独立工作树、一个 TaskType 入口和同 Task 单活动成员。

交付代码提交：09ad898。
