import type {
  Graph,
  TaskType,
  TaskInput,
  UnitConfig,
  AgentTemplate,
  Reasoning,
  TurnInput,
} from "../shared/types.ts";

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label}不能为空`);
  return value.trim();
}
export function identifier(value: unknown): string {
  const id = text(value, "ID");
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id))
    throw new Error("ID 只允许字母、数字、下划线和连字符");
  return id;
}
export function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new Error(`${label}必须是字符串列表`);
  return value;
}
export function reasoning(value: unknown): Reasoning | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    !["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(
      String(value),
    )
  )
    throw new Error("无效 reasoning");
  return value as Reasoning;
}
export function validateDelegation(value: unknown) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value) || !("enabled" in value) || typeof value.enabled !== "boolean") throw new Error("delegation.enabled 必须是布尔值");
  if (!value.enabled) return;
  const policy = value as Record<string, unknown>;
  for (const key of ["maxDepth", "maxConcurrent"] as const) {
    if (!Number.isSafeInteger(policy[key]) || Number(policy[key]) < 1) throw new Error(`delegation.${key} 必须是正整数`);
  }
  if (policy.models !== undefined) strings(policy.models, "delegation.models").forEach((model) => text(model, "model"));
}
export function validateAgent(value: AgentTemplate) {
  validateDelegation(value.delegation);
  identifier(value.id);
  text(value.name, "模板名称");
  strings(value.skills, "skills");
  reasoning(value.reasoning);
  if (typeof value.prompt !== "string" || typeof value.readOnly !== "boolean")
    throw new Error("模板 prompt/readOnly 无效");
  if (value.model !== undefined) text(value.model, "model");
}
export function validateUnit(value: UnitConfig) {
  validateAgent({ ...value, version: 1 });
  if (!["agent", "command"].includes(value.kind))
    throw new Error("无效 Unit 类型");
  if (value.context !== undefined) {
    if (
      !value.context ||
      typeof value.context !== "object" ||
      Array.isArray(value.context)
    )
      throw new Error("Context 必须是对象");
    for (const key of ["goal", "dependencies", "previousResult"] as const)
      if (
        value.context[key] !== undefined &&
        typeof value.context[key] !== "boolean"
      )
        throw new Error("Context 选择器必须是布尔值");
    if (value.context.files !== undefined)
      strings(value.context.files, "Context files");
  }
  if (value.kind === "command") {
    text(value.command, "命令");
    if (value.delegation?.enabled) throw new Error("Command Unit 不能派生 Agent");
    if (value.readOnly)
      throw new Error("Command Unit 是本地脚本，不能声明 Agent 只读沙箱权限");
  }
}
export function validateType(value: TaskType) {
  identifier(value.id);
  text(value.name, "TaskType 名称");
  if (!Array.isArray(value.units) || !value.units.length)
    throw new Error("至少需要一个 Unit");
  value.units.forEach(validateUnit);
  const ids = value.units.map((u) => u.id);
  if (new Set(ids).size !== ids.length) throw new Error("Unit ID 重复");
  if (
    !Array.isArray(value.start) ||
    value.start.length !== 1 ||
    !ids.includes(value.start[0])
  )
    throw new Error("首版 TaskType 需要一个启动 Unit");
  if (!Array.isArray(value.rules)) throw new Error("缺少调度规则");
  const keys = new Set<string>();
  for (const rule of value.rules) {
    if (
      !ids.includes(rule.from) ||
      !["ready", "approved", "changes_requested", "blocked"].includes(
        rule.outcome,
      )
    )
      throw new Error("规则来源或结果无效");
    const key = rule.from + "/" + rule.outcome;
    if (keys.has(key)) throw new Error("同一结果不能配置多条规则");
    keys.add(key);
    if (
      !rule.action ||
      !["activate", "finish", "block"].includes(rule.action.type)
    )
      throw new Error("无效调度动作");
    if (rule.action.type === "activate" && !ids.includes(rule.action.unit))
      throw new Error("规则引用不存在的 Unit");
  }
  for (const [key, max] of [
    ["maxRounds", 50],
    ["maxReportRetries", 5],
  ] as const) {
    if (
      !Number.isInteger(value[key]) ||
      value[key] < (key === "maxRounds" ? 1 : 0) ||
      value[key] > max
    )
      throw new Error(`${key} 超出范围`);
  }
}
export function validateTask(input: TaskInput) {
  if (input.id !== undefined) identifier(input.id);
  text(input.title, "任务标题");
  text(input.goal, "任务目标");
  strings(input.deps, "依赖");
  identifier(input.taskTypeId);
  if (input.newWorktree === false)
    throw new Error("首版使用独立 Task 工作树，共享工作区暂未开放");
}
export function validateDag(tasks: Pick<Graph, "tasks">["tasks"]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (byId.size !== tasks.length) throw new Error("Task ID 重复");
  const visited = new Set<string>(),
    active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new Error("依赖形成环");
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error(`依赖 ${id} 不存在`);
    active.add(id);
    task.deps.forEach(visit);
    active.delete(id);
    visited.add(id);
  };
  tasks.forEach((t) => visit(t.id));
}

export function validateTurn(input: TurnInput): TurnInput {
  if (!input || typeof input !== "object" || typeof input.text !== "string")
    throw new Error("Invalid turn");
  const mode = input.mode ?? "send";
  if (!["send", "queue", "steer"].includes(mode))
    throw new Error("Invalid turn mode");
  if (
    input.requestId !== undefined &&
    (typeof input.requestId !== "string" ||
      !input.requestId.trim() ||
      input.requestId.length > 200)
  )
    throw new Error("Invalid requestId");
  if (input.expectedExecutionId !== undefined)
    identifier(input.expectedExecutionId);
  if (
    input.attachmentIds !== undefined &&
    (!Array.isArray(input.attachmentIds) ||
      input.attachmentIds.some((id) => typeof id !== "string"))
  )
    throw new Error("Invalid attachment IDs");
  if (
    input.skills !== undefined &&
    (!Array.isArray(input.skills) ||
      input.skills.some(
        (skill) =>
          !skill ||
          typeof skill.name !== "string" ||
          typeof skill.path !== "string",
      ))
  )
    throw new Error("Invalid skills");
  if (
    !input.text.trim() &&
    !input.attachmentIds?.length &&
    !input.skills?.length
  )
    throw new Error("Empty turn");
  return {
    text: input.text.trim(),
    mode,
    requestId: input.requestId,
    expectedExecutionId: input.expectedExecutionId,
    model: input.model === undefined ? undefined : text(input.model, "model"),
    reasoning: reasoning(input.reasoning),
    attachmentIds: input.attachmentIds ? [...input.attachmentIds] : [],
    skills: input.skills ? structuredClone(input.skills) : [],
  };
}
