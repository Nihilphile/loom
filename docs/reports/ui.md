# 正式 Web UI 实施记录

范围：`web/index.html`、`web/main.ts`、`web/style.css`。基准为 `6730c32`，依据 `docs/SPEC.md` 与 `docs/architecture.md`。使用 matt-task-take 的范围与双轴自检流程；任务登记由主控负责。

页面包含项目打开、自由会话与任务会话分区、真实对话及中断、任务图与依赖连线、任务成员检查器、初始 prompt/skills/指标、固定报告预览、事件与工具详情、软硬暂停/恢复/阻塞复查、收发件箱、多人 Letter、主控订阅、统计、AgentTemplate 与 TaskType 编辑。

所有状态来自 GET `/api/state` 和 SSE `/api/stream`。界面不模拟执行进度、工具、token 或费用。未配置可信价格时显示未知；程序成员不计模型费用。报告、消息、错误、文件路径与事件内容经 HTML 转义。SSE 重绘保留表单值、文本光标与滚动位置；中文输入法组合期间推迟重绘。对话框不随 SSE 重建。

新增契约由主控确认：PATCH `/api/graphs/:id` 接受 `subscription`、`controllerSessionId`；GET `/api/reports/:id` 返回包含 `content` 的 Submission。当前首版只允许独立任务 worktree；UI 的选项固定勾选并说明限制。任务编辑仅在 draft/paused 且未交付时开放。

自检覆盖 Standards 与 Spec 两轴，修复了新增任务的稳定 ID 冲突检查，以及重复提交表单的防护。未增加第三方前端依赖。

已执行：`npm ci`、`npm run typecheck`、`npm run build` 均通过。生产构建产物位于 `dist/web`。真实浏览器与 Codex 集成验收由主控在服务切片合并后执行；本报告不把编译成功当作浏览器或运行时验收。
