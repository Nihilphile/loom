export type Reasoning =
  "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export interface ProjectEntry {
  id: string;
  path: string;
  name: string;
  createdAt: string;
  activeSessions?: number;
  activeGraphs?: number;
}
export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  kind: "image" | "file";
}
export interface SkillReference {
  name: string;
  path: string;
}
export interface TurnInput {
  text: string;
  requestId?: string;
  mode?: "send" | "queue" | "steer";
  expectedExecutionId?: string;
  model?: string;
  reasoning?: Reasoning;
  attachmentIds?: string[];
  skills?: SkillReference[];
}
export interface QueuedTurn {
  id: string;
  input: TurnInput;
  attachments: Attachment[];
  createdAt: string;
}
export interface ContextUsage {
  tokens: number;
  window: number | null;
}
export interface RuntimeOptions {
  models: {
    id: string;
    name: string;
    reasoning: Reasoning[];
    defaultReasoning?: Reasoning;
    isDefault?: boolean;
    inputModalities?: string[];
  }[];
  skills: (SkillReference & { description: string })[];
  warnings: string[];
}
export type Outcome = "ready" | "approved" | "changes_requested" | "blocked";
export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}
export interface Metrics {
  seconds: number;
  toolCalls: number;
  usage: Usage;
  costUsd: number | null;
}
export type DelegationPolicy = { enabled: false } | { enabled: true; maxDepth: number; maxConcurrent: number; models?: string[] };
export type AgentCommand =
  | { op: "spawn"; requestId: string; title: string; prompt: string; access?: "read" | "write"; model?: string; reasoning?: Reasoning }
  | { op: "send"; requestId: string; sessionId: string; prompt: string }
  | { op: "list"; sessionIds?: string[] }
  | { op: "wait"; sessionIds?: string[] }
  | { op: "integrate"; requestId: string; sessionId: string; executionId: string }
  | { op: "discard"; requestId: string; sessionId: string; executionId: string }
  | { op: "cancel"; sessionId: string };
export interface ChildSession {
  config?: ResolvedConfig;
  parentSessionId: string;
  depth: number;
  state: "preparing" | "active" | "waiting" | "finished" | "interrupted" | "failed" | "cancelled";
  access: "read" | "write";
  workspace: Workspace;
  resultExecutionId?: string;
  output: "none" | "pending" | "integrated" | "discarded" | "conflict";
  outputSha?: string;
  error?: string;
}
export interface AgentReceipt {
  requestId: string;
  fingerprint: string;
  op: string;
  sessionId?: string;
  executionId?: string;
  status: "pending" | "completed" | "failed";
  result?: unknown;
  error?: string;
}
export interface ChildNotice { sessionId: string; executionId: string; consumed?: boolean }
export interface AgentTemplate {
  id: string;
  name: string;
  version: number;
  delegation?: DelegationPolicy;
  model?: string;
  reasoning?: Reasoning;
  skills: string[];
  prompt: string;
  readOnly: boolean;
}
export interface UnitConfig {
  id: string;
  name: string;
  kind: "agent" | "command";
  templateId?: string;
  delegation?: DelegationPolicy;
  model?: string;
  reasoning?: Reasoning;
  skills: string[];
  prompt: string;
  readOnly: boolean;
  command?: string;
  context?: ContextSelection;
}
export interface TaskRule {
  from: string;
  outcome: Outcome;
  action:
    { type: "activate"; unit: string } | { type: "finish" } | { type: "block" };
}
export interface TaskType {
  id: string;
  name: string;
  version: number;
  units: UnitConfig[];
  start: string[];
  rules: TaskRule[];
  maxRounds: number;
  maxReportRetries: number;
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "mailbox";
  text: string;
  at: string;
  attachments?: Attachment[];
  skills?: SkillReference[];
  delivery?: "steer" | "queued";
}
export interface Session {
  id: string;
  title: string;
  kind: "free" | "task" | "sidechat" | "interview";
  source?: ObserverSource;
  child?: ChildSession;
  agentReceipts?: AgentReceipt[];
  childNotices?: ChildNotice[];
  acceptedConfig?: ResolvedConfig;
  lastCompletedTurnId?: string;
  graphId?: string;
  taskId?: string;
  unitId?: string;
  threadId?: string;
  status: "idle" | "running" | "interrupted" | "failed";
  model?: string;
  reasoning?: Reasoning;
  messages: ChatMessage[];
  metrics: Metrics;
  turns: number;
  error?: string;
  queue?: QueuedTurn[];
  queuePaused?: boolean;
  turnRequests?: { requestId: string; fingerprint: string; error?: string }[];
  contextUsage?: ContextUsage;
}
export interface Unit extends UnitConfig {
  sessionId?: string;
  status: "waiting" | "running" | "idle" | "interrupted" | "failed";
  metrics: Metrics;
  reportRetries: number;
}
export interface Workspace {
  path: string;
  branch: string;
  baseCommit: string;
}
export interface Snapshot {
  sha: string;
  kind: "candidate" | "delivery";
  submissionId: string;
  at: string;
}
export interface Submission {
  id: string;
  executionId: string;
  graphId: string;
  taskId: string;
  unitId: string;
  outcome: Outcome;
  reportPath: string;
  content: string;
  digest: string;
  key: string;
  at: string;
}
export interface TaskInput {
  id?: string;
  title: string;
  goal: string;
  deps: string[];
  taskTypeId: string;
  newWorktree?: boolean;
}
export interface Task {
  id: string;
  title: string;
  goal: string;
  deps: string[];
  newWorktree: boolean;
  type: TaskType;
  units: Unit[];
  status:
    | "waiting"
    | "preparing"
    | "running"
    | "reviewing"
    | "awaiting"
    | "blocked"
    | "done"
    | "queued";
  workspace?: Workspace;
  snapshots: Snapshot[];
  submissions: Submission[];
  round: number;
  blockReason?: string;
  nextUnit?: string;
  candidateSha?: string;
  deliverySha?: string;
  appendBarrier?: string[];
  configRevision: number;
}
export interface GraphInput {
  name: string;
  tasks: TaskInput[];
  concurrency?: number;
}
export interface Graph {
  id: string;
  name: string;
  runId?: string;
  status:
    "draft" | "running" | "pausing" | "paused" | "merging" | "blocked" | "done";
  pauseMode?: "soft" | "hard";
  concurrency: number;
  tasks: Task[];
  workspace?: Workspace;
  finalSha?: string;
  error?: string;
  createdAt: string;
  subscription: "blocked" | "completed" | "review";
  controllerSessionId?: string;
}
export interface LetterInput {
  graphId: string;
  from: string;
  to: string[];
  title: string;
  path: string;
  mode?: "auto" | "steer" | "followup";
}
export interface Letter extends LetterInput {
  id: string;
  content: string;
  digest: string;
  createdAt: string;
  deliveries: {
    to: string;
    status: "queued" | "injected" | "failed";
    at?: string;
    sessionId?: string;
    error?: string;
  }[];
}
export interface HarnessEvent {
  id: number;
  at: string;
  type: string;
  message: string;
  sessionId?: string;
  graphId?: string;
  taskId?: string;
  unitId?: string;
  detail?: unknown;
}
export interface Execution {
  id: string;
  sessionId: string;
  graphId?: string;
  taskId?: string;
  unitId?: string;
  purpose: "chat" | "work" | "report" | "mail" | "sidechat" | "interview";
  originUnit?: string;
  tokenHash?: string;
  status: "starting" | "running" | "completed" | "failed" | "interrupted";
  threadId?: string;
  startedAt: string;
  endedAt?: string;
  submissionId?: string;
  configRevision?: number;
  pid?: number;
  error?: string;
  model?: string;
  reasoning?: Reasoning;
  metrics?: Metrics;
  usageKnown?: boolean;
}
export interface ProjectState {
  version: 1;
  project: { id?: string; path: string; name: string };
  sessions: Session[];
  graphs: Graph[];
  letters: Letter[];
  executions: Execution[];
  preparations: Preparation[];
  interviews: InterviewSettings;
  feedback: Feedback[];
}
export interface AppState {
  project: ProjectState["project"] | null;
  sessions: Session[];
  graphs: Graph[];
  letters: Letter[];
  executions?: Omit<Execution, "tokenHash">[];
  agentTemplates: AgentTemplate[];
  taskTypes: TaskType[];
  preparations?: Preparation[];
  interviews?: InterviewSettings;
  feedback?: Feedback[];
  runtime: { name: string; capabilities: RuntimeCapabilities };
}
export interface RuntimeCapabilities {
  inject: boolean;
  interrupt: boolean;
  readOnly: boolean;
  fork?: boolean;
}
export interface RuntimeInput {
  cwd: string;
  prompt: string;
  threadId?: string;
  model?: string;
  reasoning?: Reasoning;
  readOnly?: boolean;
  writableRoots?: string[];
  observer?: boolean;
  delegation?: "disabled" | "managed";
  child?: boolean;
  agentTool?: (command: AgentCommand) => Promise<unknown>;
  fork?: { threadId: string; turnId: string };
  env?: Record<string, string>;
  attachments?: (Attachment & { path: string })[];
  skills?: SkillReference[];
}
export interface RuntimeEvent {
  type: string;
  threadId?: string;
  text?: string;
  itemId?: string;
  detail?: unknown;
  usage?: Usage;
  contextUsage?: ContextUsage;
  model?: string;
}
export type RuntimeAcceptance =
  | { status: "accepted"; threadId: string; turnId: string }
  | { status: "rejected" | "uncertain"; reason: string };
export interface RuntimeResult {
  completedTurnId?: string;
  status: "completed" | "interrupted" | "failed";
  threadId?: string;
  text: string;
  usage?: Usage;
  error?: string;
}
export interface RuntimeHandle {
  accepted: Promise<RuntimeAcceptance>;
  done: Promise<RuntimeResult>;
  pid?: number;
  interrupt(): Promise<void>;
  inject(
    text: string,
    input?: Pick<RuntimeInput, "attachments" | "skills">,
  ): Promise<boolean>;
}
export interface Runtime {
  name: string;
  capabilities: RuntimeCapabilities;
  start(
    input: RuntimeInput,
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<RuntimeHandle>;
  close?(): Promise<void>;
  discoverOptions?(cwd: string): Promise<RuntimeOptions>;
}
export interface GitAdapter {
  createChild?(parent: Workspace, sessionId: string): Promise<Workspace>;
  integrateChild?(parent: Workspace, child: Workspace, sha: string, operationId: string): Promise<string>;
  createGraph(
    projectRoot: string,
    graphId: string,
    runId: string,
  ): Promise<Workspace>;
  createTask(
    graph: Workspace,
    taskId: string,
    dependencyShas: string[],
  ): Promise<Workspace>;
  snapshot(
    workspace: Workspace,
    message: string,
    operationId: string,
  ): Promise<string>;
  mergeFinal(
    workspace: Workspace,
    shas: string[],
    operationId: string,
  ): Promise<string>;
}
export const emptyMetrics = (): Metrics => ({
  seconds: 0,
  toolCalls: 0,
  usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  costUsd: null,
});

export interface ContextSelection {
  goal?: boolean;
  dependencies?: boolean;
  previousResult?: boolean;
  files?: string[];
}
export interface ResolvedConfig {
  delegation?: DelegationPolicy;
  revision: number;
  model?: string;
  reasoning?: Reasoning;
  readOnly: boolean;
  cwd: string;
  skills: string[];
}
export interface ResolvedContextItem {
  id: string;
  kind:
    "role" | "goal" | "report" | "skill" | "file" | "letter" | "instruction";
  digest: string;
  content: string;
  path?: string;
  letterId?: string;
}
export interface Preparation {
  id: string;
  executionId: string;
  sessionId: string;
  mode: "initialize" | "continue" | "steer";
  createdAt: string;
  config: ResolvedConfig;
  inputs: ResolvedContextItem[];
  prompt: string;
  receipt: RuntimeAcceptance | { status: "prepared" | "dispatching" };
}
export interface ObserverSource {
  cwd: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  createdAt: string;
  graphId?: string;
  taskId?: string;
  unitId?: string;
}
export interface InterviewSettings {
  enabled: boolean;
  onCompleted: boolean;
  onBlocked: boolean;
  prompt: string;
  model?: string;
  reasoning?: Reasoning;
  skills: SkillReference[];
}
export interface Feedback {
  id: string;
  eventKey: string;
  source: ObserverSource;
  sessionId?: string;
  trigger: "manual" | "completed" | "blocked";
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  prompt: string;
  content: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}
export const defaultInterviews = (): InterviewSettings => ({
  enabled: false,
  onCompleted: true,
  onBlocked: true,
  prompt:
    "回顾本次任务中实际遇到的工程、工具或工作流摩擦。说明当时目标、具体障碍、相关操作或错误、采用的绕行办法，以及最有价值的改进。没有遇到的问题不要编造。只在此独立访谈回答，不执行源任务，不修改文件。",
  skills: [],
});
