# 本地项目与持久化公开接口

承接 SPEC R01、R02 的会话建档、R03 的记录基础和 R17 的存储行为。建立 TypeScript 应用入口、共享领域接口、单一状态所有者、项目目录中的持久化和 loopback API。自由会话记录可创建、读取、重新打开，尚未接 Codex 时明确显示未运行。为后续 runtime/Git/UI 提供冻结接口，不引入旧 task-graph 依赖。

验收：公开服务接口完成创建与重开，数据确实落盘，非法请求得到明确错误，类型检查通过。采用临时项目验证，记录版本及命令。输入：docs/SPEC.md、GLOSSARY.md、docs/architecture.md。
