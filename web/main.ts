import "./style.css";
import type {
  AppState,
  Graph,
  Task,
  TaskInput,
  Session,
  SessionResources,
  Metrics,
  HarnessEvent,
  ProjectEntry,
  RuntimeOptions,
  Attachment,
  SkillReference,
  Reasoning,
  TurnInput,
  Preparation,
  Feedback,
  InterviewSettings,
  ProjectWorkspace,
  WorkspaceStatus,
} from "../src/shared/types.ts";
import { defaultInterviews } from "../src/shared/types.ts";
import { statistics, summarize, type StatsFilters } from "./statistics.ts";
import { deriveInvocations, eventLabel, invocationStatistics, sessionTimeline, type Invocation, type InvocationStatus } from "./invocations.ts";
import { agenticSession, delegationFields, delegationLabel, readDelegation, sessionTree, sessionError } from "./agentic.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;
const dialog = document.querySelector<HTMLDialogElement>("#dialog")!;
const notice = document.querySelector<HTMLDivElement>("#notice")!;
let state: AppState | null = null;
let projects: ProjectEntry[] = [];
let projectId = sessionStorage.getItem("harness.project") ?? "";
let projectGeneration = 0;
let workspaceId = sessionStorage.getItem(`harness.workspace.${projectId}`) ?? "main";
let workspaceGeneration = 0;
let workspaceStatus: WorkspaceStatus | undefined;
let supportsWorkspaces = false;
let stream: EventSource | undefined;
let selectingText = false;
let pendingRender = false;
function selectionInApp() {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed &&
    (app.contains(selection.anchorNode) || app.contains(selection.focusNode));
}
function flushPendingRender() {
  if (pendingRender && !selectingText && !selectionInApp()) render();
}
app.addEventListener("pointerdown", (event) => {
  if (event.button === 0) selectingText = true;
});
document.addEventListener("pointerup", () => {
  selectingText = false;
  setTimeout(flushPendingRender, 0);
});
document.addEventListener("selectionchange", flushPendingRender);
let options: RuntimeOptions = { models: [], skills: [], warnings: [] };
let optionsLoading = false;
const drafts = new Map<string, ChatDraft>();
const collapsedWorkspaceNodes = new Set<string>();
try {
  const saved: unknown = JSON.parse(localStorage.getItem("harness.workspace-tree.collapsed") ?? "[]");
  if (Array.isArray(saved)) {
    for (const key of saved) if (typeof key === "string") collapsedWorkspaceNodes.add(key);
  }
} catch {}
type WorkspaceTreeKind = "workspace" | "graph" | "task" | "session";
const workspaceTreeKey = (kind: WorkspaceTreeKind, ...ids: string[]) => JSON.stringify([projectId, kind, ...ids]);
const workspaceTreeContentId = (key: string) => `workspace-tree-${encodeURIComponent(key)}`;
function saveWorkspaceTree() {
  try {
    localStorage.setItem("harness.workspace-tree.collapsed", JSON.stringify([...collapsedWorkspaceNodes]));
  } catch {}
}
function workspaceTreeToggle(key: string, label: string) {
  const expanded = !collapsedWorkspaceNodes.has(key);
  return `<button type="button" class="workspace-tree-toggle" data-tree-toggle="${esc(key)}" aria-expanded="${expanded}" aria-controls="${esc(workspaceTreeContentId(key))}" aria-label="${expanded ? "折叠" : "展开"} ${esc(label)}"><span aria-hidden="true">${expanded ? "▾" : "▸"}</span></button>`;
}
function workspaceTreeContent(key: string) {
  return `id="${esc(workspaceTreeContentId(key))}"${collapsedWorkspaceNodes.has(key) ? " hidden" : ""}`;
}
function workspaceSessionParent(s: Session) {
  const parentId = s.source?.sessionId ?? s.child?.parentSessionId;
  return state?.sessions.find((parent) => parent.id === parentId && parent.id !== s.id && parent.workspaceId === s.workspaceId);
}
function revealWorkspaceSelection() {
  const keys = new Set<string>();
  const revealGraph = (id: string, tid?: string) => {
    const g = state?.graphs.find((candidate) => candidate.id === id);
    if (!g) return;
    keys.add(workspaceTreeKey("workspace", g.workspaceId ?? "main"));
    keys.add(workspaceTreeKey("graph", g.id));
    if (tid) keys.add(workspaceTreeKey("task", g.id, tid));
  };
  if (page === "sessions") {
    let selected = session();
    const visited = new Set<string>();
    while (selected && !visited.has(selected.id)) {
      visited.add(selected.id);
      keys.add(workspaceTreeKey("workspace", selected.workspaceId ?? "main"));
      const parent = workspaceSessionParent(selected);
      if (parent) keys.add(workspaceTreeKey("session", parent.id));
      else if (selected.kind === "task" && selected.graphId) revealGraph(selected.graphId, selected.taskId);
      selected = parent;
    }
  } else if (page === "graphs") revealGraph(graphId, taskId);
  for (const key of keys) collapsedWorkspaceNodes.delete(key);
  saveWorkspaceTree();
}
interface ChatDraft {
  text: string;
  attachments: Attachment[];
  skills: SkillReference[];
  model: string;
  reasoning: string;
  mode: "queue" | "steer";
  uploading: number;
  sending: boolean;
}
const statsFilters: StatsFilters = {
  graph: "",
  task: "",
  unit: "",
  session: "",
  model: "",
  status: "",
  from: "",
  to: "",
  group: "project",
  purpose: "",
};
class StaleProjectResponse extends Error {}
const projectUrl = (path: string, owner = projectId) =>
  path.startsWith("/api/projects")
    ? path
    : `/api/projects/${enc(owner)}${path.slice(4)}`;
const draftKey = (sid = sessionId, pid = projectId) => `${pid}/${sid}`;
function draft(s = session()): ChatDraft {
  const key = draftKey(s?.id);
  let saved = drafts.get(key);
  if (!saved) {
    saved = {
      text: "",
      attachments: [],
      skills: [],
      model: s?.model ?? "",
      reasoning: s?.reasoning ?? "",
      mode: "queue",
      uploading: 0,
      sending: false,
    };
    drafts.set(key, saved);
  }
  return saved;
}
let page = "workspaces";
let graphId = "";
let taskId = "";
let sessionId = "";
let inspectTab = "members";
let mailAddress = "";
let mailDirection = "inbox";
let events: HarnessEvent[] = [];
let eventsSelection = "";
let traceTab: "events" | "statistics" = "events";
const invocationPages = new Map<string, { events: HarnessEvent[]; cursor: number }>();
const pendingEventLoads = new Map<string, Promise<void>>();
interface SessionResourceView {
  open: boolean;
  snapshot?: SessionResources;
  pending?: "refresh" | "stop" | "close";
  error?: string;
  updatedAt?: number;
}
const sessionResourceViews = new Map<string, SessionResourceView>();
let connected = false;
let composing = false;
let requestPending = false;
let submitPending = false;
let noticeTimer: ReturnType<typeof setTimeout>;
let eventTimer: ReturnType<typeof setTimeout> | undefined;
let eventGeneration = 0;
const statusNames: Record<string, string> = {
  draft: "未运行",
  waiting: "等待",
  preparing: "准备中",
  running: "运行中",
  reviewing: "审查中",
  awaiting: "待续跑",
  blocked: "已阻塞",
  done: "已交付",
  queued: "等待加入",
  merge_queued: "等待集成",
  integrating: "合并验证中",
  idle: "空闲",
  paused: "已暂停",
  pausing: "暂停中",
  merging: "汇总中",
  interrupted: "已中断",
  failed: "失败",
  ready: "已提交",
  approved: "通过",
  changes_requested: "需返修",
  injected: "已投递",
  completed: "已完成",
  pending: "待执行",
  cancelled: "已取消",
  prepared: "已组装",
  dispatching: "发送中",
  accepted: "运行时已接收",
  rejected: "已拒绝",
  uncertain: "接收结果未知",
};
const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
const enc = encodeURIComponent;
const badge = (status: string, label?: string) =>
  `<span class="badge ${esc(status)}">${esc(label ?? statusNames[status] ?? status)}</span>`;
const btn = (action: string, label: string, cls = "", disabled = false) =>
  `<button type="button" class="btn ${cls}" data-action="${action}" ${disabled ? "disabled" : ""}>${label}</button>`;
const fmt = (n: number) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(n);
const time = (value: string) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const workspace = () => state?.workspaces?.find((w) => w.id === workspaceId);
const workspaceGraphs = () => state?.graphs.filter((g) => (g.workspaceId ?? "main") === workspaceId) ?? [];
const workspaceSessions = () => state?.sessions.filter((s) => (s.workspaceId ?? "main") === workspaceId) ?? [];
const workspaceLetters = () => state?.letters.filter((l) => workspaceGraphs().some((g) => g.id === l.graphId) ||
  workspaceSessions().some((s) => l.from === `session/${s.id}` || l.to.includes(`session/${s.id}`))) ?? [];
const workspaceFeedback = () => state?.feedback?.filter((f) => workspaceSessions().some((s) => s.id === f.source.sessionId)) ?? [];
const graph = () => workspaceGraphs().find((g) => g.id === graphId);
const task = () => graph()?.tasks.find((t) => t.id === taskId);
const session = () => workspaceSessions().find((s) => s.id === sessionId);
const empty = (title: string, text: string, action = "") =>
  `<div class="empty"><div class="symbol">◇</div><h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
const field = (name: string, label: string, value = "", options = "") =>
  `<label class="field"><span>${label}</span><input name="${name}" value="${esc(value)}" ${options}></label>`;
const area = (name: string, label: string, value = "", options = "") =>
  `<label class="field"><span>${label}</span><textarea name="${name}" ${options}>${esc(value)}</textarea></label>`;
const reasonOptions = (selected = "medium") =>
  ["minimal", "low", "medium", "high", "xhigh"]
    .map((r) => `<option ${r === selected ? "selected" : ""}>${r}</option>`)
    .join("");
const json = (value: unknown) => esc(JSON.stringify(value, null, 2));

async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  owner = projectId,
  acceptDetached = false,
): Promise<T> {
  const generation = projectGeneration;
  const response = await fetch(projectUrl(path, owner), {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (
    !acceptDetached &&
    (owner !== projectId || generation !== projectGeneration)
  )
    throw new StaleProjectResponse();
  if (!response.ok)
    throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}
function resourceView(sid = sessionId, owner = projectId) {
  const key = draftKey(sid, owner);
  let view = sessionResourceViews.get(key);
  if (!view) {
    view = { open: false };
    sessionResourceViews.set(key, view);
  }
  return view;
}
async function updateSessionResources(operation: "refresh" | "stop" | "close", resourceId?: string) {
  const sid = sessionId;
  const owner = projectId;
  if (!session()) return;
  const view = resourceView(sid, owner);
  if (view.pending) return;
  view.pending = operation;
  view.error = undefined;
  render();
  try {
    const path = `/api/sessions/${enc(sid)}/resources${operation === "refresh" ? "" : `/${operation}`}`;
    view.snapshot = await api<SessionResources>(path, operation === "refresh" ? "GET" : "POST",
      operation === "refresh" ? undefined : operation === "stop" ? { resourceId } : {}, owner, true);
    view.updatedAt = Date.now();
    if (operation !== "refresh" && owner === projectId && sid === sessionId) await refresh();
  } catch (error) {
    if (!(error instanceof StaleProjectResponse))
      view.error = error instanceof Error ? error.message : String(error);
  } finally {
    view.pending = undefined;
    if (owner === projectId && sid === sessionId) render();
  }
}
function toast(message: string, error = false) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.className = `visible ${error ? "error" : ""}`;
  noticeTimer = setTimeout(() => (notice.className = ""), error ? 10000 : 4000);
}
function showError(error: unknown) {
  if (error instanceof StaleProjectResponse) return;
  const message = error instanceof Error ? error.message : String(error);
  const target = dialog.open ? dialog.querySelector(".modalerror") : null;
  if (target) target.textContent = message;
  else toast(message, true);
}
async function refresh() {
  if (!projectId) return;
  const next = await api<AppState>("/api/state");
  if (next.project?.id !== projectId) return;
  supportsWorkspaces = Array.isArray(next.workspaces);
  state = workspaceState(next);
  render();
}
async function mutate(path: string, body: unknown = {}, method = "POST") {
  if (requestPending) return;
  requestPending = true;
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
  ];
  buttons.forEach((b) => (b.disabled = true));
  try {
    const result = await api<unknown>(path, method, body);
    await refresh();
    scheduleEvents();
    return result;
  } finally {
    requestPending = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}
function acceptState(next: AppState) {
  if (next.project?.id !== projectId) return;
  if (state?.project?.path !== next.project?.path) {
    graphId = "";
    taskId = "";
    sessionId = "";
    events = [];
  }
  supportsWorkspaces = Array.isArray(next.workspaces);
  state = workspaceState(next);
  render();
  scheduleEvents();
}
function workspaceState(next: AppState): AppState {
  if (!next.project) return next;
  const workspaces: ProjectWorkspace[] = [...(next.workspaces ?? [])];
  if (!workspaces.some((w) => w.id === "main")) workspaces.unshift({
    id: "main", name: "主工作区", kind: "main", path: next.project.path,
    createdAt: projects.find((p) => p.id === next.project?.id)?.createdAt ?? "",
  });
  const valid = new Set(workspaces.map((w) => w.id));
  const graphs = next.graphs.map((g) => ({ ...g, workspaceId: valid.has(g.workspaceId ?? "") ? g.workspaceId : "main" }));
  const owners = new Map<string, string>();
  const owner = (s: Session, visited = new Set<string>()): string => {
    const saved = owners.get(s.id);
    if (saved) return saved;
    if (visited.has(s.id)) return "main";
    visited.add(s.id);
    const parent = s.child && next.sessions.find((p) => p.id === s.child?.parentSessionId);
    const id = s.workspaceId && valid.has(s.workspaceId) ? s.workspaceId
      : parent ? owner(parent, visited)
      : graphs.find((g) => g.id === s.graphId)?.workspaceId ?? "main";
    owners.set(s.id, id);
    return id;
  };
  return { ...next, workspaces, graphs, sessions: next.sessions.map((s) => ({ ...s, workspaceId: owner(s) })) };
}
function scheduleEvents() {
  if (eventTimer) return;
  eventTimer = setTimeout(() => {
    eventTimer = undefined;
    void loadEvents().catch(showError);
  }, 200);
}
function loadEvents(): Promise<void> {
  const selection = eventSelection();
  const pending = pendingEventLoads.get(selection);
  if (pending) return pending;
  const loading = loadSelectedEvents(selection).finally(() => {
    if (pendingEventLoads.get(selection) === loading) pendingEventLoads.delete(selection);
  });
  pendingEventLoads.set(selection, loading);
  return loading;
}
async function loadSelectedEvents(selection: string) {
  const generation = eventGeneration;
  if (!state?.project) return;
  const query = new URLSearchParams();
  if (supportsWorkspaces) query.set("workspaceId", workspaceId);
  if (page === "sessions" && sessionId) query.set("sessionId", sessionId);
  else if (page === "graphs" && graphId) query.set("graphId", graphId);
  const loaded = await api<HarnessEvent[]>(`/api/events?${query}`);
  const saved = invocationPages.get(selection);
  const calls = [...(saved?.events ?? [])];
  let cursor = saved?.cursor ?? 0;
  query.set("kind", "invocations");
  let more = true;
  while (more) {
    query.set("after", String(cursor));
    const batch = await api<HarnessEvent[]>(`/api/events?${query}`);
    if (generation !== eventGeneration || selection !== eventSelection()) return;
    calls.push(...batch);
    if (batch.length) cursor = batch[batch.length - 1].id;
    more = batch.length === 2000;
  }
  if (
    generation !== eventGeneration ||
    selection !== eventSelection()
  )
    return;
  events = loaded;
  eventsSelection = selection;
  invocationPages.set(selection, { events: calls, cursor });
  if (selectingText || selectionInApp()) {
    pendingRender = true;
    return;
  }
  const target = document.querySelector("#trace");
  if (target) {
    const top = target.scrollTop;
    target.innerHTML = traceBody(page === "logs");
    target.scrollTop = top;
  }
  const messages = document.querySelector<HTMLElement>("#chat-timeline");
  const s = session();
  if (messages && s) {
    const top = messages.scrollTop;
    const bottom = messages.scrollHeight - top - messages.clientHeight < 45;
    const open = new Set(
      [...messages.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
        (el) => el.dataset.detail,
      ),
    );
    messages.innerHTML = chatTimeline(s);
    messages.querySelectorAll<HTMLDetailsElement>("details").forEach((el) => {
      el.open = open.has(el.dataset.detail);
    });
    messages.scrollTop = bottom ? messages.scrollHeight : top;
  }
}
function eventSelection() {
  return JSON.stringify([projectId, workspaceId, page, page === "sessions" ? sessionId : page === "graphs" ? graphId : ""]);
}
function currentEvents() {
  return eventsSelection === eventSelection() ? events : [];
}
function currentInvocations() {
  return deriveInvocations(invocationPages.get(eventSelection())?.events ?? [], state?.executions ?? []);
}
function navigate(next: string) {
  page = next;
  revealWorkspaceSelection();
  render(false);
  scheduleEvents();
}

function render(preserve = true) {
  if (composing) return;
  if (preserve && (selectingText || selectionInApp())) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  const controls = new Map<string, { value: string; checked?: boolean }>();
  let focused = "";
  let selectionStart: number | null = null;
  let selectionEnd: number | null = null;
  if (preserve)
    app
      .querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >('input:not([type="file"]),textarea,select')
      .forEach((el) => {
        const key = el.id || el.name;
        if (!key) return;
        if (key.startsWith("chat-") && !(el instanceof HTMLTextAreaElement))
          return;
        controls.set(key, {
          value: el.value,
          checked: el instanceof HTMLInputElement ? el.checked : undefined,
        });
        if (el === document.activeElement) {
          focused = key;
          if (el instanceof HTMLTextAreaElement) {
            selectionStart = el.selectionStart;
            selectionEnd = el.selectionEnd;
          }
        }
      });
  const scrolls = [...app.querySelectorAll<HTMLElement>("[data-scroll]")].map(
    (el) => ({
      key: el.dataset.scroll,
      top: el.scrollTop,
      left: el.scrollLeft,
      bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 45,
    }),
  );
  const openDetails = new Set(
    [
      ...app.querySelectorAll<HTMLDetailsElement>("details[open][data-detail]"),
    ].map((el) => el.dataset.detail),
  );
  if (state?.workspaces?.length && !workspace()) {
    workspaceId = state.workspaces[0].id;
    sessionStorage.setItem(`harness.workspace.${projectId}`, workspaceId);
  }
  if (state && !graph()) graphId = workspaceGraphs()[0]?.id ?? "";
  if (graph() && !task()) taskId = graph()?.tasks[0]?.id ?? "";
  if (state && !session())
    sessionId =
      workspaceSessions().find((s) => s.kind === "free")?.id ??
      workspaceSessions()[0]?.id ??
      "";
  if (!state) {
    app.innerHTML = '<div class="boot">正在连接本地工作区…</div>';
    return;
  }
  app.innerHTML = `<div class="app">${sidebar()}<main><header class="topbar"><div class="crumb">WORKSPACE &nbsp; / &nbsp; <strong>${esc(state.project?.name ?? "打开项目")}</strong>${workspace() ? ` &nbsp; / &nbsp; <strong>${esc(workspace()!.name)}</strong>` : ""}</div><div class="row"><span class="connection ${connected ? "" : "offline"}">${connected ? "● 已连接" : "○ 正在重连"}</span><span class="runtime">${esc(state.runtime.name)} · 本地运行</span></div></header><div class="page">${!state.project && !["templates", "types"].includes(page) ? welcome() : content()}</div></main></div>`;
  if (preserve) {
    const interviewModel = controls.get("interview-model");
    const interviewReasoning = app.querySelector<HTMLSelectElement>(
      "#interview-reasoning",
    );
    if (interviewModel && interviewReasoning)
      interviewReasoning.innerHTML = nativeReasonOptions(
        interviewModel.value,
        controls.get("interview-reasoning")?.value,
        interviewModel.value ? "模型默认强度" : "沿用来源 Agent",
      );
    app
      .querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >('input:not([type="file"]),textarea,select')
      .forEach((el) => {
        const key = el.id || el.name;
        const saved = controls.get(key);
        if (!saved) return;
        el.value = saved.value;
        if (el instanceof HTMLInputElement && saved.checked !== undefined)
          el.checked = saved.checked;
        if (key === focused) {
          el.focus({ preventScroll: true });
          if (el instanceof HTMLTextAreaElement && selectionStart !== null)
            el.setSelectionRange(selectionStart, selectionEnd);
        }
      });
  }
  app
    .querySelectorAll<HTMLDetailsElement>("details[data-detail]")
    .forEach((el) => {
      el.open = openDetails.has(el.dataset.detail);
    });
  app.querySelectorAll<HTMLElement>("[data-scroll]").forEach((el) => {
    const old = scrolls.find((s) => s.key === el.dataset.scroll);
    if (old) {
      el.scrollTop =
        old.bottom && el.dataset.scroll?.startsWith("messages-")
          ? el.scrollHeight
          : old.top;
      el.scrollLeft = old.left;
    } else if (el.dataset.scroll?.startsWith("messages-"))
      el.scrollTop = el.scrollHeight;
  });
}
function sidebar() {
  if (!state) return "";
  const items = [
    ["workspaces", "▧", "Workspaces", state.workspaces?.length ?? 0],
    ["mailbox", "✉", "Mailbox", workspaceLetters().length],
    ["logs", "≋", "运行记录", ""],
    ["stats", "▤", "统计", ""],
    ["feedback", "▣", "意见箱", workspaceFeedback().length],
    ["developer", "⚙", "开发者选项", ""],
    ["types", "◈", "Task types", state.taskTypes.length],
    ["templates", "⊞", "Agent templates", state.agentTemplates.length],
  ];
  return `<aside class="sidebar"><div class="brand"><span class="brandmark">⌘</span>Loom</div><div class="project"><strong>▧ &nbsp; ${esc(state.project?.name ?? "尚未打开项目")}</strong><div class="path mono">${esc(state.project?.path ?? "选择本地 Git 项目")}</div><button data-action="project">${state.project ? "切换项目 ↗" : "打开项目 ↗"}</button></div><div class="navlabel">项目</div>${items.map(([id, icon, label, count]) => `${id === "types" ? '<div class="navlabel">PERSONAL · 跨项目</div>' : ""}<button class="navbtn ${(id === "workspaces" ? ["workspaces", "sessions", "graphs"].includes(page) : page === id) ? "active" : ""}" data-page="${id}"><span class="navicon">${icon}</span>${label}${count !== "" ? `<span class="count">${count}</span>` : ""}</button>`).join("")}<div class="sidebarfoot"><div class="online">● &nbsp; Local workspace</div><div>${esc(state.runtime.name)}</div><div>运行记录保存在项目内</div></div></aside>`;
}
function welcome() {
  return `<section class="welcome"><div class="eyebrow">LOCAL FIRST / REAL EXECUTION</div><h1>让任务有序发生。</h1><p class="muted">打开本地项目，与 Codex 独立对话，或把工作拆成有依赖关系的任务。每次执行、工具调用与交付都有记录。</p><form data-form="project"><input name="path" aria-label="项目目录" placeholder="输入本地项目的绝对路径" required><button class="btn primary" type="submit">打开项目 →</button></form><div class="notice spaced">路径不存在时自动创建目录并初始化 Git。Workspace 为功能提供独立代码目录，对话和任务图固定归属其中。Task 成果验证通过后交付到所属 Workspace。</div></section>`;
}
function content() {
  switch (page) {
    case "workspaces":
    case "sessions":
    case "graphs":
      return workspacesPage();
    case "mailbox":
      return mailboxPage();
    case "logs":
      return `${intro("运行记录", "原始事件与工具输入输出。点击记录查看完整内容。")}${trace(true)}`;
    case "stats":
      return statsPage();
    case "feedback":
      return feedbackPage();
    case "developer":
      return developerPage();
    case "templates":
      return templatesPage();
    case "types":
      return typesPage();
    default:
      return workspacesPage();
  }
}
function intro(
  title: string,
  subtitle: string,
  actions = "",
  eyebrow = "LOCAL WORKSPACE",
) {
  return `<div class="intro"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div><div class="row wrap">${actions}</div></div>`;
}
function tokenSummary(m: Metrics) {
  return `${fmt(m.usage.inputTokens)} / ${fmt(m.usage.cachedInputTokens)} / ${fmt(m.usage.outputTokens)}`;
}
function metrics(items: NonNullable<AppState["executions"]>, tasks: Task[] = []) {
  const total = summarize(items);
  return `<div class="metrics"><div class="metric"><label>输入 TOKENS</label><div class="value">${total.known ? fmt(total.usage.inputTokens) : "未知"}<small>含缓存</small></div></div><div class="metric"><label>缓存输入 TOKENS</label><div class="value">${total.known ? fmt(total.usage.cachedInputTokens) : "未知"}<small>输入的子集</small></div></div><div class="metric"><label>输出 TOKENS</label><div class="value">${total.known ? fmt(total.usage.outputTokens) : "未知"}</div></div><div class="metric"><label>累计 Agent 秒</label><div class="value">${total.measured ? fmt(total.seconds) : "未知"}<small>秒 · ${total.measured ? fmt(total.calls) : "未知"} 次工具调用</small></div></div></div><p class="tiny muted">自身与后代 · 已知用量 ${total.known} / ${total.count} 条执行记录</p>${tasks.length ? `<p class="tiny muted">已交付 ${tasks.filter((t) => t.status === "done").length} / ${tasks.length} Tasks</p>` : ""}`;
}
function graphsPage() {
  const g = graph();
  const controls = g
    ? `${btn("debug", "Debug")}${btn("pause-soft", "软暂停", "", g.status !== "running")}${btn("pause-hard", "硬暂停", "danger", !["running", "pausing"].includes(g.status))}${g.status === "blocked" ? btn("resolve", "重新检查阻塞", "primary") : btn(g.status === "paused" ? "resume" : "run", g.status === "paused" ? "▶ 继续运行" : "▶ Run graph", "primary", !["draft", "paused"].includes(g.status))}`
    : "";
  let output = intro(
    g?.name ?? "Task graphs",
    "按依赖推进工作，在这里查看每个任务的真实进度。",
    `${btn("new-graph", "＋ 新建 Graph")}${controls}`,
    g ? `PROJECT / ${g.id}` : "PROJECT / TASK GRAPHS",
  );
  if (!g)
    return (
      output +
      empty(
        "创建第一个任务图",
        "将目标拆分为任务，为每个任务选择类型，并连接它们的依赖。",
        btn("new-graph", "＋ 创建任务图", "primary"),
      )
    );
  output += metrics(
    (state?.executions ?? []).filter(
      (row) => row.graphId === g.id && row.purpose !== "sidechat" && row.purpose !== "interview",
    ),
    g.tasks,
  );
  return (
    output +
    `<div class="workspace"><div class="stack"><section class="panel"><div class="panelhead"><div class="row"><strong>任务依赖图</strong>${badge(g.status, g.status === "done" ? "已完成" : undefined)}</div><div class="row">${btn("new-task", "＋ Task", "small", g.status === "done")}</div></div><div class="toolbar"><span>并行上限 ${g.concurrency}</span><span>·</span><span>${g.tasks.length} 个任务</span><span class="grow"></span><span>点击节点查看成员</span></div>${graphCanvas(g)}<div class="canvasfoot">连线表示前置依赖；所有前置通过合并验证并发布后，下游才能启动。</div></section>${integrationPanel(g)}${g.error ? `<div class="notice amber">${esc(g.error)}</div>` : ""}${g.status === "pausing" ? '<div class="notice">正在等待活动执行结束。完全暂停后可编辑任务。</div>' : ""}${subscription(g)}${trace()}</div><aside class="panel">${inspector()}</aside></div>`
  );
}
function integrationPanel(g: Graph) {
  if (g.workspace && !g.integration) return `<section class="panel"><div class="rule">历史 Graph，没有新版集成交付记录。</div></section>`;
  const deliveries = g.integration?.deliveries ?? [];
  return `<section class="panel"><div class="panelhead"><strong>Graph 集成</strong><span>${deliveries.filter((d) => d.state.status === "published").length} / ${g.tasks.length} 已发布</span></div><div class="rule">验证命令：<code>${esc(g.integrationCommand || "未配置集成验证命令")}</code></div>${g.integration ? `<details class="rule" data-detail="graph-git-${esc(g.id)}"><summary>Git 版本（Debug）</summary>集成分支：<code>${esc(g.workspace?.branch ?? "")}</code><br>当前提交：<code>${esc(g.integration.headSha)}</code></details>` : ""}${g.mirrorWarning ? `<div class="notice amber">${esc(g.mirrorWarning)}</div>` : ""}${deliveries.map((d) => `<div class="rule"><code>${esc(d.taskId)}</code> · ${d.state.status === "published" ? "已发布" : d.state.status === "queued" ? "等待集成" : d.state.status === "integrating" ? "合并验证中" : d.state.status === "superseded" ? "编辑后已失效" : "集成阻塞"}${d.state.status === "blocked" ? `<p>${esc(d.state.error)}</p>` : ""}</div>`).join("")}</section>`;
}
function deliveryEvidence(g: Graph, t: Task) {
  const delivery = g.integration?.deliveries.find((d) => d.taskId === t.id && d.state.status !== "superseded");
  let versions = `启动提交：<code>${esc(t.startCommit ?? "尚未启动")}</code>`;
  let body = "";
  if (delivery) versions += `<br>验收源提交：<code>${esc(delivery.sourceSha)}</code>`;
  if (delivery?.state.status === "published") {
    const receipt = delivery.state.receipt;
    versions += `<br>集成提交：<code>${esc(receipt.integratedSha)}</code>`;
    body = `<div class="rule">${receipt.validation.status === "passed" ? `集成验证通过：<code>${esc(receipt.validation.command)}</code><pre>${esc(receipt.validation.output)}</pre>` : "未配置集成验证命令"}</div>`;
  } else if (delivery?.state.status === "blocked") body = `<div class="notice amber">${esc(delivery.state.error)}</div>`;
  return body + `<details class="rule" data-detail="task-git-${esc(t.id)}"><summary>Git 版本（Debug）</summary>${versions}</details>`;
}
function graphCanvas(g: Graph) {
  if (!g.tasks.length)
    return empty(
      "还没有任务",
      "添加任务并选择 TaskType。",
      btn("new-task", "＋ 添加任务"),
    );
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  function rank(t: Task): number {
    if (ranks.has(t.id)) return ranks.get(t.id) ?? 0;
    if (visiting.has(t.id)) return 0;
    visiting.add(t.id);
    const level = t.deps.reduce((n, id) => {
      const d = g.tasks.find((x) => x.id === id);
      return Math.max(n, d ? rank(d) + 1 : 0);
    }, 0);
    visiting.delete(t.id);
    ranks.set(t.id, level);
    return level;
  }
  const rows = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  g.tasks.forEach((t) => {
    const col = rank(t),
      row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    positions.set(t.id, { x: 30 + col * 285, y: 34 + row * 155 });
  });
  const width = Math.max(600, ...[...positions.values()].map((p) => p.x + 248));
  const height = Math.max(
    370,
    ...[...positions.values()].map((p) => p.y + 150),
  );
  return `<div class="canvas" data-scroll="canvas"><div class="world" style="width:${width}px;height:${height}px"><svg class="edges" width="${width}" height="${height}" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="#a6bb98"/></marker></defs>${g.tasks
    .flatMap((t) =>
      t.deps.map((dep) => {
        const a = positions.get(dep),
          b = positions.get(t.id);
        if (!a || !b) return "";
        return `<path d="M${a.x + 216} ${a.y + 52} C${a.x + 250} ${a.y + 52} ${b.x - 35} ${b.y + 52} ${b.x} ${b.y + 52}" fill="none" stroke="#b9cbb0" stroke-width="1.4" marker-end="url(#arrow)"/>`;
      }),
    )
    .join("")}</svg>${g.tasks
    .map((t) => {
      const p = positions.get(t.id);
      return `<button class="node ${esc(t.status)} ${t.id === taskId ? "selected" : ""}" style="left:${p?.x}px;top:${p?.y}px" data-task="${esc(t.id)}"><div class="row between"><code>${esc(t.id)}</code>${badge(t.status)}</div><h3 title="${esc(t.title)}">${esc(t.title)}</h3><div class="row between tiny muted"><span>${t.units.length} members</span><span>⑂ worktree</span></div><div class="deps">${t.deps.length ? "依赖 " + t.deps.map(esc).join(" · ") : "无前置依赖"}</div></button>`;
    })
    .join("")}</div></div>`;
}
function inspector() {
  const t = task(),
    g = graph();
  if (!t || !g) return empty("任务详情", "选择一个任务节点查看配置和交付。");
  let body = "";
  if (inspectTab === "members")
    body = `${t.units
      .map((u) => {
        const address = `${g.id}/${t.id}/${u.id}`;
        return `<div class="unit"><button class="unitmain" data-unit="${esc(u.id)}"><div class="row"><span class="avatar">${u.kind === "command" ? "›_" : esc(u.name.slice(0, 1))}</span><div class="grow"><h3>${esc(u.name)}</h3><div class="tiny muted">${u.kind === "command" ? "命令执行" : `${esc(u.model || "运行时默认")} · ${esc(u.reasoning || "默认")}`}</div></div>${badge(u.status)}</div><div class="unitfoot"><span>${u.sessionId ? esc(u.sessionId) : "尚未启动"}</span><span>详情 ↗</span></div></button><div class="unitmetrics"><span>${fmt(u.metrics.seconds)}s<small>自身历史累计</small></span><span>${u.metrics.toolCalls}<small>自身 tool calls</small></span><span>${u.kind === "command" ? "无模型 tokens" : tokenSummary(u.metrics)}<small>自身输入 / 缓存 / 输出</small></span></div>${u.sessionId ? sessionTree(state!, u.sessionId) : ""}<div class="unitmail"><button data-mail-address="${esc(address)}" data-direction="inbox">↓ 收件箱 ${state?.letters.filter((l) => l.to.includes(address)).length}</button><button data-mail-address="${esc(address)}" data-direction="sent">↑ 发件箱 ${state?.letters.filter((l) => l.from === address).length}</button></div></div>`;
      })
      .join(
        "",
      )}<p class="hint">成员配置来自 TaskType v${t.type.version} 的快照。点击成员查看初始 prompt、skills 与会话。</p>`;
  if (inspectTab === "goal")
    body = `<pre>${esc(t.goal)}</pre><div class="rule">依赖：${t.deps.map(esc).join("、") || "无"}</div><div class="rule">工作区：${t.newWorktree ? "独立 worktree" : "共享基线"}</div>${btn("edit-task", "编辑任务", "spaced", !["draft", "paused"].includes(g.status) || t.status === "done" )}`;
  if (inspectTab === "rules")
    body = `<div class="notice">规则由程序执行，不调用额外调度模型。</div><div class="rule">初始成员：${t.type.start.map(esc).join("、")}</div>${t.type.rules.map((r) => `<div class="rule"><code>${esc(r.from)} / ${esc(r.outcome)}</code><div>↓ ${r.action.type === "activate" ? `启动 ${esc(r.action.unit)}` : r.action.type === "finish" ? "进入合并队列" : "标记阻塞"}</div></div>`).join("")}<p class="hint">执行轮数 ${t.round} / ${t.type.maxRounds}<br>漏报补跑上限 ${t.type.maxReportRetries}</p>`;
  if (inspectTab === "reports")
    body = deliveryEvidence(g, t) + (t.submissions.length
      ? t.submissions
          .map(
            (s) =>
              `<button class="letter" data-report="${esc(s.id)}"><div class="row between"><code>${esc(s.unitId)}</code>${badge(s.outcome)}</div><h3>${esc(s.reportPath)}</h3><p>${esc(time(s.at))} · 查看固定内容 ↗</p></button>`,
          )
          .join("")
      : empty("暂无报告", "收到报告、执行结束与任务交付是不同状态。"));
  return `<div class="tasksummary"><div class="row between"><code class="muted">TASK / ${esc(t.id)}</code>${badge(t.status)}</div><h2>${esc(t.title)}</h2><p>${esc(t.type.name)} · v${t.type.version}<br>${t.units.length} 个成员 · ${t.deps.length} 个依赖</p></div><div class="tabs">${[
    ["members", "成员"],
    ["goal", "任务说明"],
    ["rules", "调度"],
    ["reports", "交付"],
  ]
    .map(
      ([id, label]) =>
        `<button data-inspect="${id}" class="${inspectTab === id ? "active" : ""}">${label}</button>`,
    )
    .join(
      "",
    )}</div><div class="panelbody">${t.blockReason ? `<div class="notice amber">${esc(t.blockReason)}<div class="spaced">${btn("resolve-task", "重新检查", "small")}</div></div>` : ""}${t.appendBarrier?.length ? `<div class="notice">等待加入：${t.appendBarrier.map(esc).join("、")} 完工后生效。</div>` : ""}${body}</div>`;
}
function subscription(g: Graph) {
  return `<section class="panel"><div class="panelhead"><strong>主控订阅</strong><span class="tiny muted">通知与恢复分开</span></div><form class="panelbody inline-form" data-form="subscription"><select name="subscription" aria-label="通知范围">${[
    ["blocked", "仅阻塞"],
    ["completed", "阻塞 + 完成报告"],
    ["review", "阻塞 + 完成 + 单次审查"],
  ]
    .map(
      ([v, l]) =>
        `<option value="${v}" ${g.subscription === v ? "selected" : ""}>${l}</option>`,
    )
    .join(
      "",
    )}</select><select name="controllerSessionId" aria-label="主控会话"><option value="">选择主控自由会话</option>${state?.sessions
    .filter((s) => s.workspaceId === workspaceId || s.id === g.controllerSessionId)
    .filter((s) => s.kind === "free")
    .map(
      (s) =>
        `<option value="${esc(s.id)}" ${g.controllerSessionId === s.id ? "selected" : ""}>${esc(s.title)}</option>`,
    )
    .join(
      "",
    )}</select><button class="btn small" type="submit">保存订阅</button></form></section>`;
}
function trace(full = false) {
  return `<section class="panel ${full ? "full-log" : ""}"><div class="panelhead"><strong>运行轨迹</strong><div class="row"><span class="tiny muted">${page === "sessions" ? "当前会话" : page === "graphs" ? "当前任务图" : supportsWorkspaces ? "当前工作区" : "当前项目"}</span>${btn("refresh-events", "↻ 刷新", "small")}</div></div><div class="tabs trace-tabs" role="tablist" aria-label="运行轨迹"><button role="tab" aria-selected="${traceTab === "events"}" data-trace-tab="events" class="${traceTab === "events" ? "active" : ""}">事件流</button><button role="tab" aria-selected="${traceTab === "statistics"}" data-trace-tab="statistics" class="${traceTab === "statistics" ? "active" : ""}">调用统计</button></div><div class="tracebody" id="trace" data-scroll="trace">${traceBody(full)}</div></section>`;
}
function traceBody(full: boolean) {
  if (traceTab === "statistics") return invocationStats();
  const scoped = currentEvents();
  const list = (full ? scoped : scoped.slice(-12)).slice().reverse();
  const calls = currentInvocations();
  return (
    list
      .map((e) => {
        const call = calls.find((c) => c.events.some((item) => item.id === e.id));
        const label = call?.name ?? eventLabel(e);
        const phase = e.type.endsWith(".started") ? "运行中" : call ? invocationLabels[call.status] : e.type;
        return `<button class="traceitem" data-event="${e.id}"><span class="mono muted">${esc(time(e.at))}</span><code>${esc([e.taskId, e.unitId].filter(Boolean).join("/") || (call ? invocationKinds[call.kind] : e.type))}</code><span class="msg">${esc(label)}<br><span class="muted">${esc(phase)}</span></span></button>`;
      })
      .join("") ||
    empty("暂无运行记录", "真实执行发生后，事件与工具记录会显示在这里。")
  );
}
const invocationLabels: Record<InvocationStatus, string> = { running: "运行中", completed: "已完成", failed: "失败", interrupted: "已中断", unknown: "结果未知" };
const invocationKinds = { tool: "工具", mcp: "MCP", skill: "Skill" };
function invocationStats() {
  const rows = invocationStatistics(currentInvocations());
  const extras: InvocationStatus[] = ["running", "interrupted", "unknown"];
  const columns = extras.filter((status) => rows.some((r) => r.counts[status]));
  return `<div class="invocation-statistics">${!invocationPages.has(eventSelection()) ? '<p class="hint">正在读取调用记录…</p>' : rows.length ? `<table><thead><tr><th>类型</th><th>名称</th><th>成功</th><th>失败</th>${columns.map((status) => `<th>${invocationLabels[status]}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr><td>${invocationKinds[r.kind]}</td><td><code>${esc(r.name)}</code></td><td>${r.counts.completed}</td><td>${r.counts.failed}</td>${columns.map((status) => `<td>${r.counts[status]}</td>`).join("")}</tr>`).join("")}</tbody></table>` : '<p class="hint">暂无工具调用记录。</p>'}${!rows.some((r) => r.kind === "skill") ? '<p class="hint">当前记录未提供可统计的 Skill 调用及执行结果。</p>' : ""}</div>`;
}

const commands = [
  { name: "new", description: "创建新的自由会话" },
  { name: "model", description: "选择模型和推理强度" },
  { name: "skills", description: "选择本项目可用的技能" },
  { name: "status", description: "查看当前会话和上下文状态" },
  { name: "sidechat", description: "从最近完整轮次开启只读侧聊，原会话继续运行" },
  { name: "interview", description: "访谈这个 Agent，收集开发反馈" },
  { name: "help", description: "查看命令与输入说明" },
  { name: "stop", description: "中断当前执行" },
];
function suggestions() {
  const text = draft().text;
  if (/^\/[^\s]*$/.test(text))
    return commands
      .filter((c) => c.name.startsWith(text.slice(1)))
      .filter((c) => session()?.kind !== "task" || !["model", "skills"].includes(c.name))
      .map((c) => {
        const reason = c.name === "sidechat" || c.name === "interview"
          ? observerUnavailable(session())
          : "";
        return `<button type="button" data-command="${c.name}" ${reason || requestPending ? "disabled" : ""}><strong>/${c.name}</strong><span>${esc(reason || c.description)}</span></button>`;
      })
      .join("");
  const match = text.match(/(?:^|\s)\$([^\s$]*)$/);
  if (!match) return "";
  const skills = options.skills.filter((s) =>
    s.name.toLowerCase().includes(match[1].toLowerCase()),
  );
  return (
    skills
      .map(
        (s) =>
          `<button type="button" data-skill="${esc(s.path)}"><strong>$${esc(s.name)}</strong><span>${esc(s.description)}</span></button>`,
      )
      .join("") ||
    `<p class="tiny muted">${optionsLoading ? "正在发现可用技能…" : "没有匹配的可用技能"}</p>`
  );
}
function contextLabel(s: Session) {
  const usage = s.contextUsage;
  if (!usage) return "上下文用量未知";
  return usage.window
    ? `上下文 ${fmt(usage.tokens)} / ${fmt(usage.window)} · ${fmt((usage.tokens / usage.window) * 100)}%`
    : `上下文 ${fmt(usage.tokens)} tokens · 容量未知`;
}
function attachmentView(a: Attachment) {
  const url = projectUrl(`/api/attachments/${enc(a.id)}`);
  return `<a class="attachment" href="${esc(url)}" target="_blank" rel="noopener">${a.kind === "image" ? `<img src="${esc(url)}" alt="${esc(a.name)}" loading="lazy">` : "▧ "}<span>${esc(a.name)} <small>${fmt(a.size / 1024)} KB</small></span></a>`;
}
function invocationView(call: Invocation) {
  return `<details class="tool-detail invocation ${call.status}" data-detail="call-${esc(call.key)}"><summary><code>${esc(call.name)}</code><span class="invocation-state">${invocationLabels[call.status]}</span></summary><pre>${json(call.detail)}</pre></details>`;
}
function chatTimeline(s: Session) {
  const entries = sessionTimeline(s.messages, currentInvocations().filter((c) => c.sessionId === s.id), currentEvents());
  const body = entries.map((entry) => {
    if (entry.kind === "invocation") return invocationView(entry.invocation);
    const m = entry.message;
    return `<article class="message ${esc(m.role)}"><div class="messageheader">${esc(m.role === "user" ? "你" : m.role === "assistant" ? "Codex" : m.role === "mailbox" ? "Mailbox" : "系统")} · ${esc(time(m.at))}${m.delivery ? ` · ${m.delivery === "steer" ? "已引导" : "来自队列"}` : ""}</div><p>${esc(m.text)}</p><div class="message-attachments">${(m.attachments ?? []).map(attachmentView).join("")}</div>${(m.skills ?? []).map((skill) => `<span class="badge">$${esc(skill.name)}</span>`).join("")}</article>`;
  }).join("");
  return (body || (s.executionOwner?.kind === "external" ? empty("外部主控", "在 Codex Desktop 对话中操作，并主动读取 Loom 通知。") : empty("开始对话", "输入目标或问题，或用 / 查看命令。"))) + (s.status === "running" ? '<div class="stream-indicator"><span></span> Codex 正在工作…</div>' : "");
}
function composer(s: Session) {
  if (s.executionOwner?.kind === "external")
    return '<div class="notice" data-external-controller>外部主控 · Codex Desktop。请在桌面对话中操作。Loom 只保存通知供主控主动读取和确认，不会启动或恢复此对话。</div>';
  const d = draft(s);
  if (s.kind === "task")
    return `<form class="composer" data-form="chat" data-session-owner="${esc(s.id)}" data-project-owner="${esc(projectId)}">
      <div class="notice">Task 会话由调度器管理。输入 / 执行本地命令，使用 /sidechat 开启只读侧聊。任务消息请通过成员收发件箱发送。</div>
      <div id="composer-suggestions" class="suggestions" role="listbox" aria-label="命令">${suggestions()}</div>
      <textarea id="chat-prompt-${esc(s.id)}" name="text" aria-label="命令" placeholder="/ 查看命令，/sidechat 开启只读侧聊">${esc(d.text)}</textarea>
      <div class="composer-controls"><span class="tiny muted">Ctrl / ⌘ + Enter</span><button class="btn primary" type="submit" ${requestPending ? "disabled" : ""}>执行命令 ↑</button></div>
    </form>`;
  const active = state?.executions?.find(
    (e) => e.sessionId === s.id && ["running", "starting"].includes(e.status),
  );
  const canSteer =
    !s.source && !!active && !!state?.runtime.capabilities.inject;
  const mode = s.source ? "queue" : d.mode;
  const paused = !!s.queuePaused;
  return `<form class="composer" data-form="chat" data-session-owner="${esc(s.id)}" data-project-owner="${esc(projectId)}">
    <div id="composer-suggestions" class="suggestions" role="listbox" aria-label="命令和技能">${suggestions()}</div>
    <div class="draft-references">${d.attachments.map((a) => `<span class="reference-chip">${attachmentView(a)}<button type="button" data-remove-attachment="${esc(a.id)}" aria-label="移除 ${esc(a.name)}">×</button></span>`).join("")}${d.skills.map((skill) => `<span class="reference-chip">$${esc(skill.name)}<button type="button" data-remove-skill="${esc(skill.path)}" aria-label="移除技能 ${esc(skill.name)}">×</button></span>`).join("")}${d.uploading ? `<span class="tiny muted">正在上传 ${d.uploading} 个附件…</span>` : ""}</div>
    <textarea id="chat-prompt-${esc(s.id)}" name="text" aria-label="消息" placeholder="发送消息，/ 查看命令，$ 选择技能。可粘贴或拖入文件。">${esc(d.text)}</textarea>
    <div class="composer-controls"><div class="row wrap"><button class="btn small" type="button" data-action="attach" aria-label="添加图片或文件">＋ 附件</button><select id="chat-model" aria-label="模型">${modelOptions(d.model)}</select><select id="chat-reasoning" aria-label="推理强度">${nativeReasonOptions(d.model, d.reasoning)}</select><button type="button" class="btn small" data-command="skills">$ Skills</button></div>
    <div class="row">${s.status === "running" ? `<select id="chat-mode" aria-label="发送方式"><option value="queue" ${mode === "queue" ? "selected" : ""}>排队下一轮</option>${s.source ? "" : `<option value="steer" ${mode === "steer" ? "selected" : ""} ${canSteer ? "" : "disabled"}>立即引导当前执行</option>`}</select>${btn("interrupt", "停止", "danger small", !state?.runtime.capabilities.interrupt)}` : ""}<button class="btn primary" type="submit" ${d.uploading || d.sending ? "disabled" : ""}>${d.sending ? "发送中…" : s.status === "running" ? (mode === "steer" ? "引导 ↑" : "排队 ↑") : paused ? "加入队列 ↑" : "发送 ↑"}</button></div></div>
    <div class="row between tiny muted"><span>Ctrl / ⌘ + Enter · 每个附件最多 10 MB</span><span>${esc(contextLabel(s))}</span></div>${optionsLoading ? '<div class="tiny muted">正在读取模型与技能目录…</div>' : ""}${options.warnings.map((w) => `<div class="tiny dangertext">${esc(w)}</div>`).join("")}
  </form>`;
}
const observer = (s: Session) =>
  s.kind === "sidechat" || s.kind === "interview";
function observerUnavailable(s?: Session) {
  if (!s) return "请先选择来源会话";
  if (observer(s)) return "侧聊和访谈会话不能再次创建分支";
  if (s.executionOwner?.kind === "external") return "请在 Codex Desktop 原对话中操作";
  if (!state?.runtime.capabilities.fork) return "当前运行时不支持独立分叉";
  if (!s.lastCompletedTurnId) return "首个完整轮次结束后可开启";
  return "";
}
function observerSource(s: Session) {
  const source = s.source;
  if (!source) return "";
  const title =
    state?.sessions.find((x) => x.id === source.sessionId)?.title ??
    source.sessionId;
  return `<div class="observer-source"><div class="row wrap"><strong>${s.kind === "interview" ? "独立访谈 · 开发开销" : "独立只读侧聊"}</strong><button class="btn small" data-open-session="${esc(source.sessionId)}">来源 ${esc(title)} ↗</button></div><p>上下文截至已完成轮次 <code>${esc(source.turnId)}</code> · ${esc(new Date(source.createdAt).toLocaleString())}</p><p>原 Agent 的后续消息不会同步到这里；这里的消息也不会回注。读取的是实时项目文件，并非分叉时的代码快照。</p><p>可以读取代码和报告，不能修改文件、交卷、发信或操作任务图。</p></div>`;
}
function preparationHistory(sid: string) {
  const records = (state?.preparations ?? []).filter(
    (p) => p.sessionId === sid,
  );
  if (!records.length)
    return '<p class="hint">尚无上下文准备记录。配置预览不代表已注入。</p>';
  const modes = {
    initialize: "首次初始化",
    continue: "继续会话",
    steer: "执行中引导",
  };
  const kinds = {
    role: "角色说明",
    goal: "任务目标",
    report: "报告",
    skill: "Skill",
    file: "文件",
    letter: "信件",
    instruction: "指令",
  };
  return `<div class="context-history">${records
    .slice()
    .reverse()
    .map(
      (p) =>
        `<details class="context-record" data-detail="preparation-${esc(p.id)}"><summary><span>${modes[p.mode]} · ${esc(time(p.createdAt))}</span>${badge(p.receipt.status)}<span class="tiny muted">${p.inputs.length} 项输入</span></summary>${"reason" in p.receipt ? `<p class="notice amber">${esc(p.receipt.reason)}</p>` : ""}${p.receipt.status === "uncertain" ? `<p class="hint">不会自动重发。请核对运行历史后处理。</p><button class="btn small" data-resolve-preparation="${esc(p.id)}">核对接收结果</button>` : ""}<div class="rule">执行 <code>${esc(p.executionId)}</code></div><details class="context-input" data-detail="preparation-config-${esc(p.id)}"><summary>本次配置 · v${p.config.revision}</summary><pre class="jsondetail">${json(p.config)}</pre></details>${p.inputs.map((input) => `<details class="context-input" data-detail="preparation-input-${esc(p.id)}-${esc(input.id)}"><summary>${kinds[input.kind]} · ${esc(input.path ?? input.letterId ?? input.id)}</summary><p class="tiny muted wordwrap">内容指纹 ${esc(input.digest)}</p><pre class="report">${esc(input.content)}</pre></details>`).join("")}<details class="context-input" data-detail="preparation-prompt-${esc(p.id)}"><summary>查看完整输入</summary><pre class="report">${esc(p.prompt)}</pre></details>${p.receipt.status === "accepted" ? `<p class="tiny muted wordwrap">已接收轮次 ${esc(p.receipt.turnId)}。接收回执不代表模型已理解或遵从内容。</p>` : ""}</details>`,
    )
    .join("")}</div>`;
}
function feedbackPage() {
  const feedback = workspaceFeedback();
  const trigger = {
    manual: "手动访谈",
    completed: "任务完成",
    blocked: "任务阻塞",
  };
  return `${intro("意见箱", "保留访谈原文与来源。反馈仅进入独立访谈会话，不影响原任务。", '<button class="btn" data-page="developer">访谈设置</button>')}<div class="stack">${
    feedback
      .map((item) => {
        const source = state?.sessions.find(
          (s) => s.id === item.source.sessionId,
        );
        return `<article class="panel feedback-card"><div class="panelhead"><div><h2>${esc(source?.title ?? item.source.sessionId)}</h2><p class="tiny muted">${trigger[item.trigger]} · ${esc(new Date(item.createdAt).toLocaleString())}</p></div>${badge(item.status)}</div><div class="panelbody"><p class="tiny muted wordwrap">${esc([item.source.graphId, item.source.taskId, item.source.unitId].filter(Boolean).join(" / ") || "自由会话")} · 来源轮次 ${esc(item.source.turnId)}</p><div class="row wrap spaced"><button class="btn small" data-open-session="${esc(item.source.sessionId)}">查看源会话</button>${item.sessionId ? `<button class="btn small" data-open-session="${esc(item.sessionId)}">打开访谈 ↗</button>` : ""}</div>${item.error ? `<div class="notice amber spaced">${esc(item.error)}</div>` : ""}<pre class="report spaced">${esc(item.content || (item.status === "pending" || item.status === "running" ? "正在收集回答…" : "没有收集到回答。"))}</pre><details class="context-input" data-detail="feedback-prompt-${esc(item.id)}"><summary>本次访谈问题</summary><pre class="report">${esc(item.prompt)}</pre></details></div></article>`;
      })
      .join("") ||
    empty(
      "暂无反馈",
      "从任意已有完整轮次的 Agent 发起访谈，或在开发者选项中启用自动访谈。",
    )
  }</div>`;
}
function developerPage() {
  const settings = state?.interviews ?? defaultInterviews();
  const skillCatalog = [
    ...options.skills,
    ...settings.skills
      .filter((skill) => !options.skills.some((s) => s.path === skill.path))
      .map((skill) => ({
        ...skill,
        description: "已配置；当前目录未返回此技能",
      })),
  ];
  return `${intro("开发者选项", "自动访谈使用独立只读会话。原 Agent 的上下文、信件和调度状态保持独立。", '<button class="btn" data-page="feedback">打开意见箱</button>')}<section class="panel developer-settings"><div class="panelhead"><strong>自动访谈</strong>${badge(settings.enabled ? "running" : "idle", settings.enabled ? "已启用" : "已关闭")}</div><form class="panelbody" data-form="interviews"><label class="checkrow"><input type="checkbox" name="interview-enabled" ${settings.enabled ? "checked" : ""}>启用自动访谈</label><p class="hint">默认关闭。关闭后仍可手动访谈；不会中断已经发起的访谈。</p><div class="grid2"><label class="checkrow"><input type="checkbox" name="interview-completed" ${settings.onCompleted ? "checked" : ""}>Task 完工后访谈</label><label class="checkrow"><input type="checkbox" name="interview-blocked" ${settings.onBlocked ? "checked" : ""}>Task 阻塞后访谈</label></div>${area("interview-prompt", "访谈提示词", settings.prompt, "required rows=7")}<div class="grid2"><label class="field"><span>访谈模型</span><select name="interview-model" id="interview-model">${modelOptions(settings.model, "沿用来源 Agent")}</select></label><label class="field"><span>推理强度</span><select name="interview-reasoning" id="interview-reasoning">${nativeReasonOptions(settings.model, settings.reasoning, settings.model ? "模型默认强度" : "沿用来源 Agent")}</select></label></div><fieldset class="interview-skills"><legend>访谈 Skills</legend><p class="hint">仅加载到访谈会话，不会加载到源 Agent。</p>${skillCatalog.map((skill) => `<label class="checkrow"><input type="checkbox" name="interview-skill-${enc(skill.path)}" data-interview-skill="${esc(skill.path)}" data-skill-name="${esc(skill.name)}" ${settings.skills.some((s) => s.path === skill.path) ? "checked" : ""}><span><strong>$${esc(skill.name)}</strong><small>${esc(skill.description)}</small></span></label>`).join("") || `<p class="hint">${optionsLoading ? "正在加载可用 Skills…" : "未发现可用 Skills。"}</p>`}</fieldset><p class="notice spaced">只访谈已有完整轮次的 Agent。访谈失败不会阻塞或恢复源任务；访谈的耗时和 tokens 单独计为开发开销。</p>${options.warnings.map((warning) => `<p class="notice amber spaced">${esc(warning)}</p>`).join("")}<button type="submit" class="btn primary spaced">保存访谈设置</button></form></section>`;
}
function sessionWorkspaceGroups() {
  if (!state) return "";
  const rendered = new Set<string>();
  const entry = (s: Session): string => {
    if (rendered.has(s.id)) return "";
    rendered.add(s.id);
    const children = state!.sessions.filter((child) => workspaceSessionParent(child)?.id === s.id && !rendered.has(child.id));
    const key = workspaceTreeKey("session", s.id);
    const label = s.kind === "sidechat" ? "侧聊" : s.kind === "interview" ? "访谈" : s.child ? s.child.access === "write" ? "可写 Agent" : "只读 Agent" : "";
    return `<div class="workspace-session-node" data-tree-session="${esc(s.id)}"><div class="workspace-tree-row">${children.length ? workspaceTreeToggle(key, s.title) : '<span class="workspace-tree-spacer" aria-hidden="true"></span>'}<button class="sessionitem ${page === "sessions" && s.id === sessionId ? "active" : ""}" data-session="${esc(s.id)}"><div class="row between"><h3>${esc(s.title)}</h3>${badge(s.status, s.executionOwner?.kind === "external" ? "外部主控" : undefined)}</div><small>${label ? `${label} · ` : ""}${esc(s.model || "默认模型")} · ${s.turns} turns${s.queue?.length ? ` · ${s.queue.length} 条待发送` : ""}</small></button></div>${children.length ? `<div class="workspace-session-children" ${workspaceTreeContent(key)}>${children.map(entry).join("")}</div>` : ""}</div>`;
  };
  return (state.workspaces ?? []).map((w) => {
    const sessions = state!.sessions.filter((s) => s.workspaceId === w.id);
    const roots = sessions.filter((s) => !workspaceSessionParent(s));
    const graphs = state!.graphs.filter((g) => g.workspaceId === w.id);
    const free = roots.filter((s) => s.kind === "free").map(entry).join("");
    const graphEntries = graphs.map((g) => {
      const tasks = g.tasks.map((t) => {
        const agents = t.units.map((u) => {
          const s = sessions.find((s) => s.id === u.sessionId);
          return s ? workspaceSessionParent(s) ? "" : entry(s) : `<div class="workspace-unit"><span>${esc(u.name)}</span>${badge(u.status)}</div>`;
        }).join("");
        const others = roots.filter((s) => s.kind === "task" && s.graphId === g.id && s.taskId === t.id).map(entry).join("");
        const key = workspaceTreeKey("task", g.id, t.id);
        return `<section class="workspace-task-group" data-tree-task="${esc(t.id)}"><div class="workspace-tree-row">${workspaceTreeToggle(key, `${t.id} ${t.title}`)}<button class="workspace-task-link" data-open-graph="${esc(g.id)}" data-open-task="${esc(t.id)}"><span>${esc(t.id)} · ${esc(t.title)}</span>${badge(t.status)}</button></div><div ${workspaceTreeContent(key)}>${agents}${others}</div></section>`;
      }).join("");
      const remaining = roots.filter((s) => s.kind === "task" && s.graphId === g.id).map(entry).join("");
      const key = workspaceTreeKey("graph", g.id);
      return `<section class="workspace-graph-group" data-tree-graph="${esc(g.id)}"><div class="workspace-tree-row">${workspaceTreeToggle(key, g.name)}<button class="workspace-graph-link ${page === "graphs" && graphId === g.id ? "active" : ""}" data-open-graph="${esc(g.id)}"><span>◇ ${esc(g.name)}</span>${badge(g.status)}</button></div><div ${workspaceTreeContent(key)}>${tasks}${remaining}</div></section>`;
    }).join("");
    const otherRoots = roots.map(entry).join("");
    const remaining = sessions.map((s) => {
      if (rendered.has(s.id)) return "";
      const visited = new Set<string>([s.id]);
      let root = s;
      let parent = workspaceSessionParent(root);
      while (parent && !visited.has(parent.id) && !rendered.has(parent.id)) {
        visited.add(parent.id);
        root = parent;
        parent = workspaceSessionParent(root);
      }
      return entry(root);
    }).join("");
    const key = workspaceTreeKey("workspace", w.id);
    return `<section class="workspace-session-group ${w.id === workspaceId ? "selected" : ""}" data-workspace-group="${esc(w.id)}"><header class="workspace-session-heading">${workspaceTreeToggle(key, w.name)}<button class="workspace-heading-link" data-workspace="${esc(w.id)}" title="${esc(w.path)}"><h3>${esc(w.name)}</h3><small>${w.kind === "main" ? "主工作区" : w.kind === "legacy" ? "历史工作区" : "独立工作区"}</small></button>${w.kind !== "legacy" ? `<div class="row"><button class="btn small" data-new-workspace-session="${esc(w.id)}" aria-label="在 ${esc(w.name)} 新建对话">＋ 对话</button><button class="btn small" data-new-workspace-graph="${esc(w.id)}" aria-label="在 ${esc(w.name)} 新建 Graph">＋ 图</button></div>` : ""}</header><div class="workspace-session-entries" ${workspaceTreeContent(key)}>${free}${graphEntries}${otherRoots || remaining ? `<div class="sessionsection">其他会话</div>${otherRoots}${remaining}` : ""}${!sessions.length && !graphs.length ? '<p class="workspace-session-empty">暂无对话或任务图</p>' : ""}</div></section>`;
  }).join("");
}
function workspacesPage() {
  const current = workspace();
  const activeSessions = workspaceSessions().filter((s) => s.status === "running").length;
  const activeGraphs = workspaceGraphs().filter((g) => g.status === "running" || g.status === "pausing").length;
  const branch = workspaceStatus?.status === "ready" ? workspaceStatus.branch ?? "Detached HEAD"
    : current && current.kind !== "main" ? current.branch : supportsWorkspaces ? "分支读取中" : "原项目目录";
  const location = current ? `<div class="workspace-context"><div class="row wrap"><strong>${esc(current.name)}</strong><code>${esc(branch)}</code><span class="tiny muted">${workspaceStatus?.status === "ready" ? workspaceStatus.dirty ? "有未提交修改" : "工作目录干净" : workspaceStatus?.status === "unavailable" ? esc(workspaceStatus.error) : supportsWorkspaces ? "正在读取目录状态" : "重启服务后显示目录状态"}</span><span class="tiny muted">${activeSessions || activeGraphs ? `${activeSessions} 个会话 · ${activeGraphs} 个图运行中` : "空闲"}</span></div><small title="${esc(current.path)}">${esc(current.path)}</small></div>` : "";
  const detail = page === "sessions" ? sessionContent() : page === "graphs" ? graphsPage() : current ?
    `<section class="panel workspace-overview"><div class="panelhead"><strong>${esc(current.name)}</strong><span class="tiny muted">${current.kind === "legacy" ? "历史工作区" : "工作区"}</span></div><div class="panelbody"><p>选择左侧对话继续发送消息，或打开任务图查看进度。</p><p class="hint">${esc(current.path)}</p>${workspaceStatus?.status === "ready" ? `<p class="hint">${esc(workspaceStatus.branch ?? "Detached HEAD")}${workspaceStatus.dirty ? " · 有未提交修改" : ""}</p>` : ""}${current.kind === "legacy" ? '<p class="hint">此工作区由旧版任务图的独立工作目录迁移而来。展开左侧工作区可查看其中的任务图；新功能请创建独立 Workspace。</p>' : `<div class="row wrap spaced"><button class="btn" data-new-workspace-session="${esc(current.id)}">＋ 对话</button><button class="btn" data-new-workspace-graph="${esc(current.id)}">＋ Graph</button></div>`}</div></section>` : empty("创建工作区", "在工作区里组织对话和任务图。");
  return `${intro("Workspaces", "按工作区组织对话和任务图。直接选择任意对话发送消息。", btn("new-workspace", "＋ Workspace", "primary", !supportsWorkspaces))}${!supportsWorkspaces ? '<div class="notice amber workspace-version-notice" role="status">当前服务尚未启用工作区。已有会话和任务图显示在主工作区，可继续使用；重启 Loom 服务后可创建独立 Workspace。</div>' : ""}<div class="sessionlayout workspaces-layout"><nav class="panel sessionlist workspace-tree" aria-label="工作区、对话与任务图" data-scroll="workspaces">${sessionWorkspaceGroups()}</nav><div class="workspace-detail">${location}${detail}</div></div>`;
}
const resourceStateNames: Record<SessionResources["state"], string> = {
  unavailable: "不支持资源管理", starting: "启动中", active: "正在执行", idle: "空闲保留",
  closing: "清理中", closed: "已关闭", failed: "异常",
};
function sessionResourcesPanel(s: Session) {
  const view = resourceView(s.id);
  const snapshot = view.snapshot;
  const blocked = !!view.pending || snapshot?.state === "closing";
  const execution = state?.executions?.filter((item) => item.sessionId === s.id).at(-1);
  const canClose = !!snapshot && snapshot.state !== "unavailable" &&
    (snapshot.state !== "closed" || snapshot.processes.length > 0);
  return `<section class="session-resources">
    <button type="button" class="resource-summary" data-action="toggle-resources" aria-expanded="${view.open}" aria-controls="session-resource-body"><span aria-hidden="true">${view.open ? "▾" : "▸"}</span>会话资源</button>
    ${view.open ? `<div id="session-resource-body" class="resource-body" aria-busy="${!!view.pending}">
      <div class="row wrap between"><div class="row wrap tiny"><span>本轮 ${execution ? badge(execution.status) : "未执行"}</span><span>资源状态 ${snapshot ? esc(resourceStateNames[snapshot.state]) : view.pending ? "正在查询" : "未读取"}</span></div>${btn("refresh-resources", view.pending === "refresh" ? "查询中…" : "刷新", "small", !!view.pending)}</div>
      ${view.error ? `<p class="resource-error dangertext" role="alert">${esc(view.error)} · 可点击刷新重试。</p>` : ""}
      ${snapshot?.error ? `<p class="resource-error dangertext" role="alert">${esc(snapshot.error)}</p>` : ""}
      ${snapshot ? snapshot.state === "unavailable" ? '<p class="tiny muted">当前运行时无法提供会话进程管理。</p>' : `<ul class="resource-list">${snapshot.processes.map((process) => `<li><div class="grow"><strong class="resource-name">${esc(process.name)}</strong><div class="tiny muted"><span class="mono">PID ${process.pid}</span> · ${process.role === "backend" ? "Codex 后端" : "会话进程"} · ${fmt(process.memoryBytes / 1048576)} MiB</div></div>${process.role === "descendant" ? `<button type="button" class="btn small danger" data-stop-resource="${esc(process.id)}" ${blocked ? "disabled" : ""} aria-label="停止 ${esc(process.name)}，PID ${process.pid}">停止进程</button>` : ""}</li>`).join("") || `<li class="tiny muted">${snapshot.error ? "暂时无法确认进程列表。" : "当前没有受管理的进程。"}</li>`}</ul>
      <p class="tiny muted">后台进程会跨轮保留，空闲后自动回收。列表按会话归属显示，尚未关联具体工具调用。</p>
      <div class="resource-cleanup row wrap between"><p class="tiny muted grow">清理会关闭本会话的运行时和后台进程，并中断执行中的本轮。</p>${btn("close-resources", view.pending === "close" ? "正在清理…" : s.status === "running" ? "停止本轮并清理资源" : "清理全部资源", "small danger", blocked || !canClose)}</div>` : ""}
      ${view.updatedAt ? `<p class="tiny muted resource-updated">上次读取 ${esc(new Date(view.updatedAt).toLocaleTimeString("zh-CN"))} · 展开时每 5 秒刷新</p>` : ""}
    </div>` : ""}
  </section>`;
}
function sessionContent() {
  const s = session();
  const queue = s?.queue ?? [];
  return `<div class="stack">${s ? `<section class="panel chat-panel"><div class="chathead"><div class="row between"><h2>${esc(s.title)}</h2>${badge(s.status, s.executionOwner?.kind === "external" ? "外部主控" : undefined)}</div><div class="tiny muted">${esc(s.model || "运行时默认模型")} · ${esc(s.reasoning || "默认推理")} · ${s.turns} turns</div><div class="chat-usage">输入 ${fmt(s.metrics.usage.inputTokens)} <span>缓存 ${fmt(s.metrics.usage.cachedInputTokens)}</span> 输出 ${fmt(s.metrics.usage.outputTokens)} <span>${esc(contextLabel(s))}</span></div></div>${sessionResourcesPanel(s)}${observerSource(s)}${agenticSession(state!, s)}<div id="chat-timeline" class="messages" data-scroll="messages-${esc(s.id)}">${chatTimeline(s)}</div>${sessionError(s)}${queue.length || s.queuePaused ? `<section class="queued-messages"><div class="row between"><strong>待发送 ${queue.length}${s.queuePaused ? " · 已暂停" : ""}</strong>${s.queuePaused && s.executionOwner?.kind !== "external" ? btn("continue-queue", "继续队列", "small", s.status === "running" || !queue.length) : ""}</div>${queue.map((q, i) => `<div class="queued-message"><span class="muted">${i + 1}</span><div class="grow"><p>${esc(q.input.text || "附件消息")}</p><small>${q.attachments.map((a) => esc(a.name)).join(" · ")}${q.input.skills?.map((skill) => ` $${esc(skill.name)}`).join("") ?? ""}</small></div><button class="btn small" data-cancel-queue="${esc(q.id)}">取消</button></div>`).join("")}</section>` : ""}${composer(s)}<details class="session-context" data-detail="session-context-${esc(s.id)}"><summary>Context · 本次会话输入记录</summary>${preparationHistory(s.id)}</details></section>` : empty("创建一个自由会话", "自由会话不属于任务图，适合调查、讨论与临时工作。", btn("new-session", "＋ 创建自由会话", "primary"))}${trace()}</div>`;
}
function mailboxPage() {
  const letters =
    workspaceLetters().filter(
      (l) =>
        !mailAddress ||
        (mailDirection === "sent"
          ? l.from === mailAddress
          : l.to.includes(mailAddress)),
    ) ?? [];
  return `${intro("Mailbox", "同一 Letter 索引的收件与发件视图。每位收件人分别记录投递状态。", btn("compose", "＋ 写信", "primary"))}<section class="panel"><div class="letterfilters"><select id="mail-direction" aria-label="收件或发件"><option value="inbox" ${mailDirection === "inbox" ? "selected" : ""}>收件箱</option><option value="sent" ${mailDirection === "sent" ? "selected" : ""}>发件箱</option></select><input id="mail-address" aria-label="按成员地址筛选" placeholder="全部地址，或输入 graph/task/unit、session/id" value="${esc(mailAddress)}">${btn("filter-mail", "筛选", "small")}${btn("clear-mail", "全部", "small")}</div>${
    letters.length
      ? letters
          .slice()
          .reverse()
          .map(
            (l) =>
              `<button class="letter" data-letter="${esc(l.id)}"><div class="row between"><span class="tiny muted">${esc(time(l.createdAt))} · ${esc(l.mode ?? "auto")}</span><span class="badge">${l.deliveries.filter((d) => d.status === "injected").length} injected · ${l.deliveries.filter((d) => d.status === "acknowledged").length} acknowledged / ${l.to.length} 收件人</span></div><h3>${esc(l.title)}</h3><p>${esc(l.from)} → ${l.to.map(esc).join("、")}</p></button>`,
          )
          .join("")
      : empty(
          "暂无信件",
          "信件引用项目中的报告文件。内容在发送时固定，之后修改文件不会改变已发送内容。",
        )
  }</section>`;
}
function statsPage() {
  return state ? statistics({ ...state, graphs: workspaceGraphs(), sessions: workspaceSessions(),
    letters: workspaceLetters(), feedback: workspaceFeedback(),
    executions: state.executions?.filter((e) => workspaceSessions().some((s) => s.id === e.sessionId)),
  }, statsFilters) : "";
}
function templatesPage() {
  return `${intro("Agent templates", "跨项目复用的成员配置。库更新不会回写已有任务的配置快照。", btn("new-template", "＋ 创建模板", "primary"), "PERSONAL LIBRARY / AGENTS")}<div class="grid3">${state?.agentTemplates.map((a) => `<article class="card"><span class="badge">v${a.version} · ${a.readOnly ? "只读" : "可写工作区"}</span><h2>${esc(a.name)}</h2><p>${esc(delegationLabel(a.delegation))}</p><p>${esc(a.model || "运行时默认模型")} · ${esc(a.reasoning || "默认推理")}</p><div class="librarymeta">${a.skills.map((s) => `<span class="badge">${esc(s)}</span>`).join("") || '<span class="tiny muted">未指定 skills</span>'}</div><p>${esc(a.prompt.slice(0, 150))}${a.prompt.length > 150 ? "…" : ""}</p><button class="btn" data-template="${esc(a.id)}">编辑模板 ↗</button></article>`).join("")}</div>`;
}
function typesPage() {
  return `${intro("Task types", "定义成员、初始执行与结果规则，Task 保存类型版本快照。", btn("new-type", "＋ 创建类型", "primary"), "PERSONAL LIBRARY / TASK TYPES")}<div class="grid3">${state?.taskTypes.map((t) => `<article class="card"><span class="badge">v${t.version} · 跨项目</span><h2>${esc(t.name)}</h2><p>${t.units.map((u) => esc(u.name)).join(" · ")}</p><div class="rule">启动：${t.start.map(esc).join("、")}</div><div class="rule">${t.rules.length} 条结果规则 · ${t.maxRounds} 轮执行上限</div><p>漏报补跑上限 ${t.maxReportRetries}</p><button class="btn" data-type="${esc(t.id)}">编辑类型 ↗</button></article>`).join("")}</div><div class="notice spaced">高级规则使用 JSON 编辑，支持 agent 与 command 成员。保存时由服务校验成员引用与规则。</div>`;
}

function modal(title: string, body: string, form = "", submit = "保存") {
  dialog.innerHTML = `${form ? `<form data-form="${form}">` : ""}<header class="modalhead"><h2>${esc(title)}</h2><button type="button" class="btn small" data-action="close" aria-label="关闭对话框">✕</button></header><div class="modalbody"><div class="modalerror" role="alert"></div>${body}</div><footer class="modalfoot"><button type="button" class="btn" data-action="close">${form ? "取消" : "关闭"}</button>${form ? `<button class="btn primary" type="submit">${submit}</button>` : ""}</footer>${form ? "</form>" : ""}`;
  if (!dialog.open) dialog.showModal();
}
function projectOptions() {
  return projects
    .map(
      (p) =>
        `<button type="button" class="project-option ${p.id === projectId ? "selected" : ""}" data-project="${esc(p.id)}"><strong>${esc(p.name)} ${p.id === projectId ? "✓" : ""}</strong><small>${esc(p.path)}</small><span>${p.activeSessions ?? 0} 个活动会话 · ${p.activeGraphs ?? 0} 个活动图</span></button>`,
    )
    .join("");
}
function projectModal() {
  modal(
    "项目",
    `<div class="project-list">${projectOptions()}</div><h3 class="spaced">打开或创建项目</h3>${field("path", "本地绝对路径", "", "required")}${field("name", "项目名称（可选）")}<p class="hint">路径不存在时创建目录并初始化 Git。切换项目后，原项目的执行继续运行。</p>`,
    "project",
    "打开项目",
  );
  void api<{ projects: ProjectEntry[] }>("/api/projects")
    .then((result) => {
      projects = result.projects;
      const list = dialog.querySelector(".project-list");
      if (list) list.innerHTML = projectOptions();
    })
    .catch(showError);
}
function modelOptions(selected = "", defaultLabel?: string) {
  return `<option value="">${esc(defaultLabel ?? (options.models.some((m) => m.isDefault) ? "运行时默认" : "沿用会话模型"))}</option>${options.models.map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? "selected" : ""}>${esc(m.name)}</option>`).join("")}${selected && !options.models.some((m) => m.id === selected) ? `<option value="${esc(selected)}" selected>${esc(selected)}（当前配置）</option>` : ""}`;
}
function nativeReasonOptions(model = "", selected = "", defaultLabel?: string) {
  const catalog =
    options.models.find((m) => m.id === model) ??
    options.models.find((m) => m.isDefault);
  return `<option value="">${esc(defaultLabel ?? (catalog?.defaultReasoning ? "默认推理强度" : "沿用会话推理强度"))}</option>${(catalog?.reasoning ?? []).map((r) => `<option value="${esc(r)}" ${r === selected ? "selected" : ""}>${esc(r)}</option>`).join("")}${selected && !catalog?.reasoning.includes(selected as Reasoning) ? `<option value="${esc(selected)}" selected>${esc(selected)}（当前配置）</option>` : ""}`;
}
function sessionModal() {
  if (workspace()?.kind === "legacy") throw new Error("请创建新的 Workspace 开发，历史工作区保留原 Graph 执行。");
  modal(
    "创建自由会话",
    field(
      "title",
      "会话名称",
      "",
      'required placeholder="例如：梳理项目结构"',
    ) +
      `<div class="grid2"><label class="field"><span>模型</span><select name="model" id="new-session-model">${modelOptions()}</select></label><label class="field"><span>推理强度</span><select name="reasoning" id="new-session-reasoning">${nativeReasonOptions()}</select></label></div>${options.warnings.map((w) => `<p class="notice amber">${esc(w)}</p>`).join("")}`,
    "new-session",
    "创建会话",
  );
  dialog.querySelector<HTMLFormElement>("form")!.dataset.workspaceOwner = workspaceId;
  dialog.querySelector<HTMLFormElement>("form")!.dataset.workspaceGeneration = String(workspaceGeneration);
}
function workspaceModal() {
  if (!supportsWorkspaces) throw new Error("重启 Loom 服务后可创建独立 Workspace。");
  modal("创建 Workspace",
    `${field("name", "工作区名称", "", 'required maxlength="120" placeholder="例如：登录功能"')}<label class="field"><span>从哪个工作区开始</span><select name="sourceWorkspaceId">${state?.workspaces?.map((w) => `<option value="${esc(w.id)}" ${w.id === workspaceId ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select></label><p class="hint">从所选工作区的已提交版本创建独立分支和代码目录。创建后，对话和任务图自动归属这里。</p>`,
    "new-workspace", "创建 Workspace");
}
function taskFields(input: TaskInput, index: number, existing: Task[] = []) {
  return `<div class="taskrow" data-task-row><header><strong>Task ${index + 1}</strong><button type="button" class="btn small danger" data-remove-row>移除</button></header><div class="grid2">${field("id", "稳定 ID", input.id ?? `T${String(index + 1).padStart(2, "0")}`, 'required pattern="[A-Za-z0-9_\\-]+"')}${field("title", "任务名称", input.title, "required")}</div>${area("goal", "目标与验收要求", input.goal, "required")}<div class="grid2"><label class="field"><span>Task type</span><select name="taskTypeId">${state?.taskTypes.map((t) => `<option value="${esc(t.id)}" ${input.taskTypeId === t.id ? "selected" : ""}>${esc(t.name)} · v${t.version}</option>`).join("")}</select></label>${field("deps", "依赖任务 ID（逗号分隔）", input.deps.join(", "), `placeholder="${esc(existing.map((t) => t.id).join(", ") || "例如 T01, T02")}"`)}</div><label class="checkrow"><input name="newWorktree" type="checkbox" checked disabled>独立 worktree <span class="tiny muted">首版使用独立任务工作区</span></label></div>`;
}
function graphModal() {
  if (workspace()?.kind === "legacy") throw new Error("请创建新的 Workspace 开发，历史工作区保留原 Graph 执行。");
  modal(
    "创建任务图",
    `<div class="grid2">${field("name", "Graph 名称", "", 'required placeholder="例如：认证流程改造"')}${field("concurrency", "并行任务上限", "2", 'type="number" min="1" max="8" required')}</div>${field("integrationCommand", "合并后验证命令（可选）", "", 'placeholder="例如 npm test"')}<p class="hint">在每个实际合并候选中运行；成功且代码未被改动才发布。留空表示未配置验证命令。</p><div id="task-rows">${taskFields({ title: "", goal: "", deps: [], taskTypeId: state?.taskTypes[0]?.id ?? "", newWorktree: true }, 0)}</div><button type="button" class="btn" data-action="add-row">＋ 添加任务</button><p class="hint">任务 ID 保持稳定；依赖必须存在且不能成环。创建后可先检查任务图，再启动执行。</p>`,
    "new-graph",
    "创建 Graph",
  );
  dialog.querySelector<HTMLFormElement>("form")!.dataset.workspaceOwner = workspaceId;
  dialog.querySelector<HTMLFormElement>("form")!.dataset.workspaceGeneration = String(workspaceGeneration);
}
function taskModal(edit: boolean) {
  const t = task();
  if (edit && !t) return;
  const input =
    edit && t
      ? {
          id: t.id,
          title: t.title,
          goal: t.goal,
          deps: t.deps,
          taskTypeId: t.type.id,
          newWorktree: t.newWorktree,
        }
      : {
          id: `T${String((graph()?.tasks.length ?? 0) + 1).padStart(2, "0")}`,
          title: "",
          goal: "",
          deps: [],
          taskTypeId: state?.taskTypes[0]?.id ?? "",
          newWorktree: true,
        };
  modal(
    edit ? "编辑任务" : "添加任务",
    taskFields(input, 0, graph()?.tasks ?? []) +
      (graph()?.status === "running"
        ? '<div class="notice">运行中追加的任务将等待提交时的活动任务完工后生效。</div>'
        : ""),
    edit ? "edit-task" : "new-task",
    edit ? "保存修改" : "添加任务",
  );
  dialog.querySelector("[data-remove-row]")?.remove();
  if (edit) {
    const id = dialog.querySelector<HTMLInputElement>("[name=id]");
    if (id) id.readOnly = true;
  }
}
function unitModal(id: string) {
  const t = task(),
    g = graph(),
    u = t?.units.find((x) => x.id === id);
  if (!u || !g || !t) return;
  const s = state?.sessions.find((session) => session.id === u.sessionId);
  const accepted = s?.acceptedConfig;
  const pending = !!accepted && accepted.revision < t.configRevision;
  modal(
    u.name,
    `<div class="row between">${badge(u.status)}<span class="tiny muted">${u.kind === "command" ? "命令执行" : u.readOnly ? "只读 Agent" : "工作区可写 Agent"}</span><button class="btn small" data-unit="${esc(u.id)}">刷新详情</button></div><div class="rule">地址 <code>${esc(`${g.id}/${t.id}/${u.id}`)}</code></div><h3 class="spaced">Config</h3><div class="config-grid"><section><h4>声明配置 · v${t.configRevision}</h4><div class="rule">模型 ${esc(u.model || "运行时默认")} · 推理 ${esc(u.reasoning || "默认")}</div><div class="rule">Skills ${u.skills.map(esc).join("、") || "未指定"}</div><div class="rule">${esc(delegationLabel(u.delegation))}</div><div class="rule">权限 ${u.readOnly ? "只读" : "工作区可写"}</div><div class="rule">工作目录 ${esc(t.workspace?.path ?? "依赖交付后准备")}</div><p class="hint">返修、再审默认沿用原 session。</p>${u.command ? `<pre class="report">${esc(u.command)}</pre>` : ""}</section><section><h4>已接受配置${accepted ? ` · v${accepted.revision}` : ""}</h4>${accepted ? `<div class="rule">模型 ${esc(accepted.model || "运行时默认")} · 推理 ${esc(accepted.reasoning || "默认")}</div><div class="rule">Skills ${accepted.skills.map(esc).join("、") || "未指定"}</div><div class="rule">${esc(delegationLabel(accepted.delegation))}</div><div class="rule">权限 ${accepted.readOnly ? "只读" : "工作区可写"}</div><div class="rule">工作目录 ${esc(accepted.cwd)}</div>` : `<p class="hint">${u.kind === "command" ? "命令 Unit 不做模型会话初始化。" : "尚未收到运行时接收回执。"}</p>`}${pending ? '<p class="notice amber">声明配置已更新，等待下一次执行接受。当前 session 尚未应用此版本。</p>' : ""}</section></div><h3 class="spaced">Context</h3><details class="context-input"><summary>配置来源预览 · 尚不代表已注入</summary><h4 class="spaced">初始 prompt</h4><pre class="report">${esc(u.prompt || "未指定额外 prompt")}</pre><h4 class="spaced">上下文选择</h4><pre class="jsondetail">${json(u.context ?? {})}</pre></details>${u.sessionId ? preparationHistory(u.sessionId) : '<p class="hint">首次运行前会根据配置组装上下文。</p>'}${s?.error ? `<p class="notice amber">${esc(s.error)}</p>` : ""}<div class="spaced">${u.sessionId ? `<button class="btn primary" data-open-session="${esc(u.sessionId)}">查看会话 ↗</button>` : '<span class="muted">成员尚未创建会话</span>'}</div>${s ? agenticSession(state!, s) : ""}`,
  );
}
function resolvePreparationModal(p: Preparation) {
  modal(
    "核对上下文接收结果",
    `<p class="notice amber">仅凭界面超时无法确定是否已接收。请先核对原生运行历史，再记录核对结果。此操作不重新发送内容。</p><div class="rule">执行 <code>${esc(p.executionId)}</code></div><label class="field spaced"><span>核对结果</span><select name="accepted"><option value="true">确认运行时已接收</option><option value="false">确认运行时未接收</option></select></label>${field("threadId", "已接收时填写 Thread ID")}${field("turnId", "已接收时填写 Turn ID")}<label class="checkrow"><input type="checkbox" name="verified" required>我已核对运行历史。确认未接收后，才能安全地重新发送。</label><input type="hidden" name="sessionId" value="${esc(p.sessionId)}"><input type="hidden" name="preparationId" value="${esc(p.id)}">`,
    "resolve-preparation",
    "保存核对结果",
  );
}
function composeModal() {
  const g = graph();
  const addresses =
    workspaceGraphs().flatMap((x) =>
      x.tasks.flatMap((t) =>
        t.units
          .filter((u) => u.kind === "agent")
          .map((u) => `${x.id}/${t.id}/${u.id}`),
      ),
    ) ?? [];
  const senders = [
    ...(workspaceSessions()
      .filter((s) => s.kind === "free")
      .map((s) => `session/${s.id}`) ?? []),
    ...addresses,
  ];
  modal(
    "发送 Letter",
    `<label class="field"><span>Graph</span><select name="graphId" required>${workspaceGraphs().map((x) => `<option value="${esc(x.id)}" ${x.id === g?.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label><label class="field"><span>发送者地址</span><select name="from" required>${senders.map((a) => `<option ${a === mailAddress ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>${area("to", "收件人地址（可多人，每行一个或逗号分隔）", mailDirection === "inbox" ? mailAddress : "", 'required placeholder="graph/task/unit 或 session/id"')}${field("title", "标题（最多 20 个 Unicode 字符）", "", "required")}${field("path", "报告文件路径", "", 'required placeholder="例如 reports/findings.md"')}<label class="field"><span>投递模式</span><select name="mode"><option value="auto">auto · 按收件状态选择</option><option value="steer" ${state?.runtime.capabilities.inject ? "" : "disabled"}>steer · 活动执行输入${state?.runtime.capabilities.inject ? "" : "（运行时不支持）"}</option><option value="followup">followup · 当前执行结束后续聊</option></select></label><div class="notice">文件必须已存在。服务将固定文件内容，并单独记录每位收件人的投递结果。</div>`,
    "compose",
    "发送信件",
  );
}
function templateModal(id?: string) {
  const a = state?.agentTemplates.find((x) => x.id === id);
  modal(
    a ? "编辑 Agent template" : "创建 Agent template",
    `<div class="grid2">${field("id", "模板 ID", a?.id ?? "", 'required pattern="[A-Za-z0-9_\\-]+" ' + (a ? "readonly" : ""))}${field("name", "显示名称", a?.name ?? "", "required")}</div><div class="grid2">${field("model", "模型", a?.model ?? "", 'placeholder="留空使用运行时默认"')}<label class="field"><span>推理强度</span><select name="reasoning">${reasonOptions(a?.reasoning)}</select></label></div>${delegationFields(a?.delegation)}${field("skills", "Skills（逗号或换行分隔）", a?.skills.join(", ") ?? "")}${area("prompt", "初始 prompt", a?.prompt ?? "", 'rows="7"')}<label class="checkrow"><input type="checkbox" name="readOnly" ${a?.readOnly ? "checked" : ""}>只读工作区权限</label><input type="hidden" name="version" value="${a?.version ?? 0}"><div class="notice">保存为新的配置版本。已有 Task 的成员配置快照不变。</div>`,
    "template",
    "保存模板",
  );
}
function typeModal(id?: string) {
  const t = state?.taskTypes.find((x) => x.id === id) ?? {
    id: "custom-type",
    name: "自定义类型",
    version: 1,
    units: [
      {
        id: "worker",
        name: "Worker",
        kind: "agent",
        skills: [],
        prompt: "完成任务，按运行提示提交报告。",
        readOnly: false,
      },
    ],
    start: ["worker"],
    rules: [
      { from: "worker", outcome: "ready", action: { type: "finish" } },
      { from: "worker", outcome: "blocked", action: { type: "block" } },
    ],
    maxRounds: 3,
    maxReportRetries: 2,
  };
  modal(
    "TaskType · 高级配置",
    area(
      "json",
      "成员与调度规则 JSON",
      JSON.stringify(t, null, 2),
      'class="codeeditor" spellcheck="false" required',
    ) +
      '<div class="notice">规则的 from 与 activate.unit 必须引用成员 ID。Command Unit 通过 command 字段配置程序验证。</div>' +
      t.units.filter((u) => u.kind === "agent").map((u) => `<section data-delegation-unit="${esc(u.id)}"><h3>${esc(u.name)} · 派工配置</h3>${delegationFields(u.delegation, `unit-${u.id}-`)}</section>`).join("") +
      '<p class="hint">下方控件优先于 JSON 中同名 Unit 的 delegation；新增 Unit 可直接在 JSON 配置。</p>',
    "type",
    "保存类型",
  );
}

function value(form: HTMLFormElement | Element, name: string) {
  const el = form.querySelector<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >(`[name="${name}"]`);
  return el?.value.trim() ?? "";
}
function split(value: string) {
  return value
    .split(/[,，\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function readTask(row: Element): TaskInput {
  return {
    id: value(row, "id"),
    title: value(row, "title"),
    goal: value(row, "goal"),
    deps: split(value(row, "deps")),
    taskTypeId: value(row, "taskTypeId"),
    newWorktree: true,
  };
}
function validateTasks(tasks: TaskInput[]) {
  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) throw new Error("任务 ID 不能重复。");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(t: TaskInput) {
    const id = t.id ?? "";
    if (visiting.has(id)) throw new Error("依赖存在环，请调整任务依赖。");
    if (visited.has(id)) return;
    visiting.add(id);
    t.deps.forEach((d) => {
      const dep = tasks.find((t) => t.id === d);
      if (!dep) throw new Error(`依赖 ${d} 不存在。`);
      visit(dep);
    });
    visiting.delete(id);
    visited.add(id);
  }
  tasks.forEach(visit);
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.form) return;
  event.preventDefault();
  const chat = form.dataset.form === "chat";
  if (!chat && (submitPending || requestPending)) return;
  if (!chat) submitPending = true;
  const buttons = [
    ...form.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
  ];
  buttons.forEach((button) => (button.disabled = true));
  void submit(form)
    .catch(showError)
    .finally(() => {
      if (!chat) submitPending = false;
      buttons.forEach((button) => (button.disabled = false));
    });
});
async function submit(form: HTMLFormElement) {
  const kind = form.dataset.form;
  if (requestPending && kind !== "chat") return;
  if (kind === "interviews") {
    const checked = (name: string) =>
      !!form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.checked;
    const settings: InterviewSettings = {
      enabled: checked("interview-enabled"),
      onCompleted: checked("interview-completed"),
      onBlocked: checked("interview-blocked"),
      prompt: value(form, "interview-prompt"),
      model: value(form, "interview-model") || undefined,
      reasoning: (value(form, "interview-reasoning") || undefined) as
        Reasoning | undefined,
      skills: [
        ...form.querySelectorAll<HTMLInputElement>(
          "[data-interview-skill]:checked",
        ),
      ].map((el) => ({
        name: el.dataset.skillName!,
        path: el.dataset.interviewSkill!,
      })),
    };
    await mutate("/api/developer/interviews", settings, "PUT");
    toast("访谈设置已保存");
    return;
  }
  if (kind === "resolve-preparation") {
    const accepted = value(form, "accepted") === "true";
    const threadId = value(form, "threadId");
    const turnId = value(form, "turnId");
    if (!form.querySelector<HTMLInputElement>('[name="verified"]')?.checked)
      throw new Error("请先核对运行历史。");
    if (accepted && (!threadId || !turnId))
      throw new Error("确认已接收需要填写 Thread ID 和 Turn ID。");
    await mutate(
      `/api/sessions/${enc(value(form, "sessionId"))}/preparations/${enc(value(form, "preparationId"))}/resolve`,
      {
        accepted,
        threadId: threadId || undefined,
        turnId: turnId || undefined,
      },
    );
    dialog.close();
    toast("接收结果已更新");
    return;
  }
  if (kind === "project") {
    const entry = await api<ProjectEntry>("/api/projects", "POST", {
      path: value(form, "path"),
      name: value(form, "name") || undefined,
    });
    if (!projects.some((p) => p.id === entry.id)) projects.push(entry);
    dialog.close();
    await selectProject(entry.id);
    toast("项目已打开");
    return;
  }
  if (kind === "new-session") {
    const owner = form.dataset.workspaceOwner ?? workspaceId;
    const created = await api<Session>("/api/sessions", "POST", {
      workspaceId: owner,
      title: value(form, "title"),
      model: value(form, "model") || undefined,
      reasoning: value(form, "reasoning") || undefined,
    });
    if (workspaceId !== owner || Number(form.dataset.workspaceGeneration) !== workspaceGeneration) { await refresh(); return; }
    sessionId = created.id;
    dialog.close();
    page = "sessions";
    await refresh();
    navigate("sessions");
    return;
  }
  if (kind === "new-workspace") {
    const generation = workspaceGeneration;
    const created = await api<ProjectWorkspace>("/api/workspaces", "POST", {
      name: value(form, "name"), sourceWorkspaceId: value(form, "sourceWorkspaceId"),
    });
    await refresh();
    if (generation !== workspaceGeneration) return;
    dialog.close();
    await selectWorkspace(created.id);
    navigate("workspaces");
    toast("Workspace 已创建");
    return;
  }
  if (kind === "chat-settings") {
    const d = draft();
    d.model = value(form, "model");
    d.reasoning = value(form, "reasoning");
    dialog.close();
    render(false);
    return;
  }
  if (kind === "chat") {
    const s = session();
    if (
      !s ||
      form.dataset.sessionOwner !== s.id ||
      form.dataset.projectOwner !== projectId
    )
      return;
    const d = draft(s);
    const prompt = value(form, "text");
    if (prompt.startsWith("/")) {
      await runCommand(prompt);
      return;
    }
    if (s.kind === "task")
      throw new Error("Task 会话仅支持 / 命令。任务消息请通过成员收发件箱发送。");
    if (
      (!prompt && !d.attachments.length && !d.skills.length) ||
      d.uploading ||
      d.sending
    )
      return;
    const active = state?.executions?.find(
      (e) => e.sessionId === s.id && ["running", "starting"].includes(e.status),
    );
    const mode =
      s.status === "running"
        ? s.source
          ? "queue"
          : d.mode
        : s.queuePaused
          ? "queue"
          : "send";
    if (mode === "steer" && !active)
      throw new Error("当前执行已结束，请重新选择发送方式。");
    const selectedModel = d.model
      ? options.models.find((model) => model.id === d.model)
      : options.models.find((model) => model.isDefault);
    const input: TurnInput = {
      text: prompt,
      mode,
      requestId: crypto.randomUUID(),
      model: mode === "steer" ? undefined : d.model || selectedModel?.id,
      reasoning: (mode === "steer"
        ? undefined
        : d.reasoning || selectedModel?.defaultReasoning) as
        Reasoning | undefined,
      expectedExecutionId: mode === "steer" ? active?.id : undefined,
      attachmentIds: d.attachments.map((a) => a.id),
      skills: [...d.skills],
    };
    const owner = projectId;
    d.sending = true;
    render();
    try {
      await api<Session>(
        `/api/sessions/${enc(s.id)}/turn`,
        "POST",
        input,
        owner,
        true,
      );
      if (d.text.trim() === prompt) d.text = "";
      d.attachments = d.attachments.filter(
        (a) => !input.attachmentIds?.includes(a.id),
      );
      d.skills = d.skills.filter(
        (skill) => !input.skills?.some((sent) => sent.path === skill.path),
      );
      if (owner === projectId) {
        if (sessionId === s.id) render(false);
        await refresh();
        scheduleEvents();
      }
    } catch (error) {
      if (owner !== projectId || s.id !== sessionId)
        throw new StaleProjectResponse();
      throw error;
    } finally {
      d.sending = false;
      if (owner === projectId && sessionId === s.id) render(false);
    }
    return;
  }
  if (kind === "subscription") {
    const g = graph();
    if (!g) return;
    await mutate(
      `/api/graphs/${enc(g.id)}`,
      {
        subscription: value(form, "subscription"),
        controllerSessionId: value(form, "controllerSessionId") || null,
      },
      "PATCH",
    );
    toast("订阅已保存");
    return;
  }
  if (kind === "new-graph") {
    const owner = form.dataset.workspaceOwner ?? workspaceId;
    const tasks = [...form.querySelectorAll("[data-task-row]")].map(readTask);
    if (!tasks.length) throw new Error("请至少添加一个任务。");
    validateTasks(tasks);
    const created = await api<Graph>("/api/graphs", "POST", {
      workspaceId: owner,
      name: value(form, "name"),
      concurrency: Number(value(form, "concurrency")),
      integrationCommand: value(form, "integrationCommand").trim() || undefined,
      tasks,
    });
    if (workspaceId !== owner || Number(form.dataset.workspaceGeneration) !== workspaceGeneration) { await refresh(); return; }
    graphId = created.id;
    taskId = created.tasks[0]?.id ?? "";
    page = "graphs";
    dialog.close();
    await refresh();
    navigate("graphs");
    return;
  }
  if (kind === "new-task" || kind === "edit-task") {
    const g = graph(),
      row = form.querySelector("[data-task-row]");
    if (!g || !row) return;
    const input = readTask(row);
    if (kind === "new-task" && g.tasks.some((t) => t.id === input.id))
      throw new Error("任务 ID 已存在，请使用新的 ID。");
    validateTasks([
      ...g.tasks
        .filter((t) => t.id !== input.id)
        .map((t) => ({
          id: t.id,
          title: t.title,
          goal: t.goal,
          deps: t.deps,
          taskTypeId: t.type.id,
        })),
      input,
    ]);
    await mutate(
      `/api/graphs/${enc(g.id)}/tasks${kind === "edit-task" ? "/" + enc(input.id ?? "") : ""}`,
      input,
      kind === "edit-task" ? "PATCH" : "POST",
    );
    taskId = input.id ?? "";
    dialog.close();
    render(false);
    return;
  }
  if (kind === "compose") {
    const title = value(form, "title");
    if ([...title].length > 20)
      throw new Error("标题最多 20 个 Unicode 字符。");
    const to = split(value(form, "to"));
    if (!to.length) throw new Error("请至少指定一位收件人。");
    await mutate("/api/letters", {
      graphId: value(form, "graphId"),
      from: value(form, "from"),
      to,
      title,
      path: value(form, "path"),
      mode: value(form, "mode"),
    });
    dialog.close();
    toast("信件已保存，投递状态见收发件箱");
    return;
  }
  if (kind === "template") {
    const reason = value(form, "reasoning");
    if (!["", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(reason))
      throw new Error("推理强度无效");
    const payload = {
      id: value(form, "id"),
      name: value(form, "name"),
      version: Number(value(form, "version")) + 1,
      model: value(form, "model") || undefined,
      reasoning: reason || undefined,
      skills: split(value(form, "skills")),
      prompt: value(form, "prompt"),
      delegation: readDelegation(form),
      readOnly:
        form.querySelector<HTMLInputElement>("[name=readOnly]")?.checked ??
        false,
    };
    await mutate("/api/catalog/agents", payload);
    dialog.close();
    toast("模板已保存");
    return;
  }
  if (kind === "type") {
    const payload: unknown = JSON.parse(value(form, "json"));
    if (
      !payload ||
      typeof payload !== "object" ||
      !("id" in payload) ||
      !("units" in payload) ||
      !Array.isArray(payload.units)
    )
      throw new Error("TaskType 必须包含 id 与 units 数组。");
    for (const section of form.querySelectorAll<HTMLElement>("[data-delegation-unit]")) {
      const id = section.dataset.delegationUnit!;
      const unit = payload.units.find((u: { id?: string }) => u.id === id);
      if (unit?.kind === "agent") unit.delegation = readDelegation(section, `unit-${id}-`);
    }
    await mutate("/api/catalog/task-types", payload);
    dialog.close();
    toast("类型已保存");
  }
}
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const el = target.closest<HTMLElement>("button,[data-page]");
  if (!el || (el instanceof HTMLButtonElement && el.disabled)) return;
  void click(el).catch(showError);
});
async function click(el: HTMLElement) {
  if (el.dataset.treeToggle) {
    const key = el.dataset.treeToggle;
    if (collapsedWorkspaceNodes.has(key)) collapsedWorkspaceNodes.delete(key);
    else collapsedWorkspaceNodes.add(key);
    saveWorkspaceTree();
    render();
    app.querySelectorAll<HTMLButtonElement>("[data-tree-toggle]").forEach((toggle) => {
      if (toggle.dataset.treeToggle === key) toggle.focus({ preventScroll: true });
    });
    return;
  }
  if (el.dataset.traceTab === "events" || el.dataset.traceTab === "statistics") {
    traceTab = el.dataset.traceTab;
    render();
    return;
  }
  if (el.dataset.sessionUnit) {
    const source = state?.sessions.find((s) => s.id === el.dataset.sessionUnit);
    if (source?.graphId && source.taskId && source.unitId) {
      if (source.workspaceId !== workspaceId) await selectWorkspace(source.workspaceId ?? "main");
      graphId = source.graphId;
      taskId = source.taskId;
      navigate("graphs");
      unitModal(source.unitId);
    }
    return;
  }
  if (el.dataset.resolvePreparation) {
    const record = state?.preparations?.find(
      (p) => p.id === el.dataset.resolvePreparation,
    );
    if (record) resolvePreparationModal(record);
    return;
  }
  if (el.dataset.project) {
    await selectProject(el.dataset.project);
    return;
  }
  if (el.dataset.workspace) {
    await selectWorkspace(el.dataset.workspace);
    navigate("workspaces");
    return;
  }
  if (el.dataset.newWorkspaceSession || el.dataset.newWorkspaceGraph) {
    await selectWorkspace(el.dataset.newWorkspaceSession ?? el.dataset.newWorkspaceGraph!);
    if (el.dataset.newWorkspaceSession) sessionModal();
    else graphModal();
    return;
  }
  if (el.dataset.openGraph) {
    const target = state?.graphs.find((g) => g.id === el.dataset.openGraph);
    if (!target) return;
    if (target.workspaceId !== workspaceId) await selectWorkspace(target.workspaceId ?? "main");
    graphId = target.id;
    taskId = el.dataset.openTask ?? target.tasks[0]?.id ?? "";
    navigate("graphs");
    return;
  }
  if (el.dataset.command) {
    await runCommand(`/${el.dataset.command}`);
    return;
  }
  if (el.dataset.skill) {
    const skill = options.skills.find((s) => s.path === el.dataset.skill);
    if (!skill) return;
    const d = draft();
    if (!d.skills.some((s) => s.path === skill.path))
      d.skills.push({ name: skill.name, path: skill.path });
    d.text = d.text.replace(/(^|\s)\$[^\s$]*$/, "$1");
    dialog.close();
    render(false);
    app.querySelector<HTMLTextAreaElement>('[name="text"]')?.focus();
    return;
  }
  if (el.dataset.removeAttachment || el.dataset.removeSkill) {
    const d = draft();
    d.attachments = d.attachments.filter(
      (a) => a.id !== el.dataset.removeAttachment,
    );
    d.skills = d.skills.filter((s) => s.path !== el.dataset.removeSkill);
    render(false);
    return;
  }
  if (el.dataset.cancelQueue) {
    await mutate(
      `/api/sessions/${enc(sessionId)}/queue/${enc(el.dataset.cancelQueue)}`,
      undefined,
      "DELETE",
    );
    return;
  }
  if (el.dataset.stopResource) {
    await updateSessionResources("stop", el.dataset.stopResource);
    return;
  }
  if (el.dataset.page) {
    navigate(el.dataset.page);
    return;
  }
  if (el.dataset.task) {
    taskId = el.dataset.task;
    render(false);
    return;
  }
  if (el.dataset.inspect) {
    inspectTab = el.dataset.inspect;
    render();
    return;
  }
  if (el.dataset.session || el.dataset.openSession) {
    const targetId = el.dataset.session ?? el.dataset.openSession ?? "";
    const target = state?.sessions.find((s) => s.id === targetId);
    if (target && target.workspaceId !== workspaceId) await selectWorkspace(target.workspaceId ?? "main");
    sessionId = targetId;
    dialog.close();
    navigate("sessions");
    return;
  }
  if (el.dataset.unit) {
    unitModal(el.dataset.unit);
    return;
  }
  if (el.dataset.mailAddress) {
    mailAddress = el.dataset.mailAddress;
    mailDirection = el.dataset.direction ?? "inbox";
    navigate("mailbox");
    return;
  }
  if (el.dataset.template) {
    templateModal(el.dataset.template);
    return;
  }
  if (el.dataset.type) {
    typeModal(el.dataset.type);
    return;
  }
  if (el.hasAttribute("data-remove-row")) {
    el.closest("[data-task-row]")?.remove();
    return;
  }
  if (el.dataset.event) {
    const e = events.find((e) => String(e.id) === el.dataset.event);
    if (e)
      modal(
        e.type,
        `<p class="muted">${esc(e.at)}</p><p class="spaced">${esc(e.message)}</p><pre class="jsondetail">${json(e.detail ?? e)}</pre>`,
      );
    return;
  }
  if (el.dataset.report) {
    const report = await api<{ content: string; reportPath?: string }>(
      `/api/reports/${enc(el.dataset.report)}`,
    );
    modal(
      "报告 · 固定内容",
      `<p class="muted wordwrap">${esc(report.reportPath ?? "")}</p><pre class="report spaced">${esc(report.content)}</pre>`,
    );
    return;
  }
  if (el.dataset.letter) {
    const l = state?.letters.find((l) => l.id === el.dataset.letter);
    if (l)
      modal(
        l.title,
        `<div class="rule address">${esc(l.from)} → ${l.to.map(esc).join("、")}</div><div class="rule">报告文件：${esc(l.path)}</div>${l.deliveries.map((d) => `<div class="rule address">${esc(d.to)} ${badge(d.status)}${d.error ? `<p class="dangertext">${esc(d.error)}</p>` : ""}</div>`).join("")}<pre class="report spaced">${esc(l.content)}</pre>`,
      );
    return;
  }
  const action = el.dataset.action;
  const g = graph();
  switch (action) {
    case "toggle-resources": {
      const view = resourceView();
      view.open = !view.open;
      render();
      if (view.open) await updateSessionResources("refresh");
      break;
    }
    case "refresh-resources":
      await updateSessionResources("refresh");
      break;
    case "close-resources":
      await updateSessionResources("close");
      break;
    case "attach": {
      const owner = projectId;
      const s = session();
      const picker = document.createElement("input");
      picker.type = "file";
      picker.multiple = true;
      picker.hidden = true;
      document.body.append(picker);
      picker.addEventListener(
        "change",
        () => {
          void uploadFiles([...(picker.files ?? [])], s, owner).catch(
            showError,
          );
          picker.remove();
        },
        { once: true },
      );
      picker.addEventListener("cancel", () => picker.remove(), { once: true });
      picker.click();
      break;
    }
    case "continue-queue":
      await mutate(`/api/sessions/${enc(sessionId)}/continue`);
      break;
    case "reset-stats":
      Object.assign(statsFilters, {
        graph: "",
        task: "",
        unit: "",
        session: "",
        model: "",
        status: "",
        from: "",
        to: "",
        group: "project",
        purpose: "",
      });
      render(false);
      break;
    case "close":
      dialog.close();
      break;
    case "project":
      projectModal();
      break;
    case "new-workspace":
      workspaceModal();
      break;
    case "new-session":
      sessionModal();
      break;
    case "new-graph":
      graphModal();
      break;
    case "new-task":
      taskModal(false);
      break;
    case "edit-task":
      taskModal(true);
      break;
    case "new-template":
      templateModal();
      break;
    case "new-type":
      typeModal();
      break;
    case "compose":
      composeModal();
      break;
    case "add-row": {
      const rows = dialog.querySelector("#task-rows");
      const index = rows?.children.length ?? 0;
      rows?.insertAdjacentHTML(
        "beforeend",
        taskFields(
          {
            title: "",
            goal: "",
            deps: [],
            taskTypeId: state?.taskTypes[0]?.id ?? "",
          },
          index,
        ),
      );
      break;
    }
    case "run":
    case "resume":
      if (g) await mutate(`/api/graphs/${enc(g.id)}/${action}`);
      break;
    case "pause-soft":
    case "pause-hard":
      if (g)
        await mutate(`/api/graphs/${enc(g.id)}/pause`, {
          mode: action === "pause-soft" ? "soft" : "hard",
        });
      break;
    case "resolve":
    case "resolve-task":
      if (g)
        await mutate(
          `/api/graphs/${enc(g.id)}/resolve`,
          action === "resolve-task" ? { taskId } : {},
        );
      break;
    case "interrupt":
      await stopSession();
      break;
    case "debug":
      if (g) {
        const debug = await api<unknown>(`/api/graphs/${enc(g.id)}/debug`);
        modal(
          "Debug · 内部运行记录",
          `<div class="notice">Git 版本、工作区路径与内部运行状态。凭据不会显示在这里。</div><pre class="jsondetail">${json(debug)}</pre>`,
        );
      }
      break;
    case "refresh-events":
      await loadEvents();
      break;
    case "filter-mail":
      mailAddress =
        app.querySelector<HTMLInputElement>("#mail-address")?.value.trim() ??
        "";
      mailDirection =
        app.querySelector<HTMLSelectElement>("#mail-direction")?.value ??
        "inbox";
      render(false);
      break;
    case "clear-mail":
      mailAddress = "";
      render(false);
      break;
  }
}
async function stopSession() {
  const active = state?.executions?.find(
    (e) =>
      e.sessionId === sessionId && ["starting", "running"].includes(e.status),
  );
  if (!active) throw new Error("没有正在执行的消息。");
  await mutate(`/api/sessions/${enc(sessionId)}/interrupt`, {
    expectedExecutionId: active.id,
  });
}
async function openObserver(kind: "sidechat" | "interview", source: Session) {
  if (requestPending) return;
  const reason = observerUnavailable(source);
  if (reason) throw new Error(reason);
  const owner = projectId;
  const selectionGeneration = workspaceGeneration;
  requestPending = true;
  render(false);
  try {
    let createdId: string | undefined;
    if (kind === "sidechat") {
      const created = await api<Session>(
        `/api/sessions/${enc(source.id)}/sidechats`, "POST", {},
      );
      createdId = created.id;
    } else {
      const feedback = await api<Feedback>(
        `/api/sessions/${enc(source.id)}/interviews`, "POST", {},
      );
      createdId = feedback.sessionId;
    }
    if (selectionGeneration !== workspaceGeneration) { await refresh(); return; }
    dialog.close();
    if (createdId) {
      sessionId = createdId;
      page = "sessions";
    } else page = "feedback";
    await refresh();
    revealWorkspaceSelection();
    scheduleEvents();
  } finally {
    requestPending = false;
    if (owner === projectId) render(false);
  }
}
async function runCommand(text: string) {
  const [name, ...args] = text.trim().slice(1).split(/\s+/);
  if (!commands.some((c) => c.name === name))
    throw new Error(`未知命令 /${name}。输入 /help 查看支持的命令。`);
  const s = session();
  if (!s) return;
  const d = draft(s);
  if (name === "sidechat" || name === "interview")
    await openObserver(name, s);
  if (name === "stop") await stopSession();
  if (name === "new") {
    const owner = workspaceId;
    const generation = workspaceGeneration;
    const next = await api<Session>("/api/sessions", "POST", {
      workspaceId: owner,
      title: args.join(" ") || "新会话",
      model: d.model || undefined,
      reasoning: d.reasoning || undefined,
    });
    if (owner !== workspaceId || generation !== workspaceGeneration) { await refresh(); return; }
    sessionId = next.id;
    page = "sessions";
    await refresh();
    navigate("sessions");
  }
  if (name === "model") {
    if (args.length) {
      const selected = options.models.find((m) => m.id === args[0]);
      if (!selected)
        throw new Error("模型不在运行时目录中，请用 /model 查看可用模型。");
      d.model = selected.id;
      d.reasoning = selected.defaultReasoning ?? "";
    } else
      modal(
        "模型与推理强度",
        `<p class="hint">设置应用于下一条消息。</p><label class="field"><span>模型</span><select name="model" id="new-session-model">${modelOptions(d.model)}</select></label><label class="field"><span>推理强度</span><select name="reasoning" id="new-session-reasoning">${nativeReasonOptions(d.model, d.reasoning)}</select></label>${options.warnings.map((w) => `<p class="notice amber">${esc(w)}</p>`).join("")}`,
        "chat-settings",
        "应用",
      );
  }
  if (name === "skills")
    modal(
      "本项目可用的 Skills",
      `<p class="hint">选择后，技能以原生引用随下一条消息发送。</p><div class="skill-list">${options.skills.map((skill) => `<button type="button" data-skill="${esc(skill.path)}"><strong>$${esc(skill.name)}</strong><p>${esc(skill.description)}</p><small>${esc(skill.path)}</small></button>`).join("") || `<p>${optionsLoading ? "正在加载技能目录…" : "运行时没有返回可用技能。"}</p>`}</div>${options.warnings.map((w) => `<p class="notice amber">${esc(w)}</p>`).join("")}`,
    );
  if (name === "status")
    modal(
      "会话状态",
      `<div class="rule">${esc(s.title)} ${badge(s.status)}</div><div class="rule">模型 ${esc(s.model ?? "运行时默认")} · ${esc(s.reasoning ?? "默认推理")}</div><div class="rule">${esc(contextLabel(s))}</div><div class="rule">累计输入 / 缓存 / 输出 ${tokenSummary(s.metrics)}</div><div class="rule">待发送 ${s.queue?.length ?? 0} · ${s.queuePaused ? "队列已暂停" : "队列正常"}</div><div class="rule">项目 ${esc(state?.project?.path)}</div>`,
    );
  if (name === "help")
    modal(
      "命令与输入",
      `${commands.map((c) => `<div class="rule"><code>/${c.name}</code> ${esc(c.description)}</div>`).join("")}<p class="hint">输入 $ 可搜索技能。附件支持选择、拖入或粘贴，每个文件最多 10 MB。执行期间可选择排队下一轮或引导当前执行；停止后队列等待你手动继续。</p>`,
    );
  if (d.text.startsWith("/")) d.text = "";
  render(false);
}
async function uploadFiles(files: File[], s = session(), owner = projectId) {
  if (!s || s.kind === "task") return;
  const d = drafts.get(draftKey(s.id, owner));
  if (!d) return;
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) {
      toast(`${file.name} 超过 10 MB，未上传。`, true);
      continue;
    }
    d.uploading++;
    render();
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
        reader.readAsDataURL(file);
      });
      const attachment = await api<Attachment>(
        "/api/attachments",
        "POST",
        {
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          base64,
        },
        owner,
        true,
      );
      d.attachments.push(attachment);
    } catch (error) {
      if (owner === projectId && s.id === sessionId) showError(error);
    } finally {
      d.uploading--;
      if (owner === projectId && s.id === sessionId) render();
    }
  }
}
document.addEventListener("input", (event) => {
  const el = event.target;
  if (el instanceof HTMLTextAreaElement && el.closest('[data-form="chat"]')) {
    draft().text = el.value;
    const target = app.querySelector("#composer-suggestions");
    if (target) target.innerHTML = suggestions();
  }
});
document.addEventListener("change", (event) => {
  const el = event.target;
  if (
    (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) &&
    el.dataset.statFilter
  ) {
    statsFilters[el.dataset.statFilter as keyof StatsFilters] = el.value;
    if (el.dataset.statFilter === "graph") {
      statsFilters.task = "";
      statsFilters.unit = "";
    }
    if (el.dataset.statFilter === "task") statsFilters.unit = "";
    render(false);
    return;
  }
  if (el instanceof HTMLSelectElement && el.id === "new-session-model") {
    const reason = dialog.querySelector<HTMLSelectElement>(
      "#new-session-reasoning",
    );
    if (reason) reason.innerHTML = nativeReasonOptions(el.value);
    return;
  }
  if (el instanceof HTMLSelectElement && el.id === "interview-model") {
    const reason = app.querySelector<HTMLSelectElement>("#interview-reasoning");
    if (reason)
      reason.innerHTML = nativeReasonOptions(
        el.value,
        "",
        el.value ? "模型默认强度" : "沿用来源 Agent",
      );
    return;
  }
  if (
    el instanceof HTMLSelectElement &&
    ["chat-model", "chat-reasoning", "chat-mode"].includes(el.id)
  ) {
    const d = draft();
    if (el.id === "chat-model") {
      d.model = el.value;
      d.reasoning = "";
    }
    if (el.id === "chat-reasoning") d.reasoning = el.value;
    if (el.id === "chat-mode")
      d.mode = el.value === "steer" ? "steer" : "queue";
    render(false);
    return;
  }
});
app.addEventListener("paste", (event) => {
  if (
    !(event.target instanceof Element) ||
    !event.target.closest('[data-form="chat"]')
  )
    return;
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length) {
    event.preventDefault();
    void uploadFiles(files).catch(showError);
  }
});
app.addEventListener("dragover", (event) => {
  if (
    event.target instanceof Element &&
    event.target.closest('[data-form="chat"]')
  )
    event.preventDefault();
});
app.addEventListener("drop", (event) => {
  if (
    !(event.target instanceof Element) ||
    !event.target.closest('[data-form="chat"]')
  )
    return;
  event.preventDefault();
  void uploadFiles([...(event.dataTransfer?.files ?? [])]).catch(showError);
});
document.addEventListener("keydown", (event) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key === "Enter" &&
    event.target instanceof HTMLTextAreaElement &&
    event.target.closest('[data-form="chat"]')
  ) {
    event.preventDefault();
    event.target.closest("form")?.requestSubmit();
  }
});
app.addEventListener("compositionstart", () => (composing = true));
app.addEventListener("compositionend", () => {
  composing = false;
  render();
});
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      dialog.close();
  }
});
async function loadOptions(owner: string) {
  const generation = projectGeneration;
  const selectedWorkspace = workspaceId;
  const selectionGeneration = workspaceGeneration;
  optionsLoading = true;
  if (supportsWorkspaces) void api<WorkspaceStatus>(`/api/workspaces/${enc(selectedWorkspace)}/status`, "GET", undefined, owner)
    .then((value) => {
      if (owner === projectId && generation === projectGeneration && selectionGeneration === workspaceGeneration) {
        workspaceStatus = value;
        render();
      }
    }).catch(() => {});
  try {
    const discovered = await api<RuntimeOptions>(
      supportsWorkspaces ? `/api/runtime/options?workspaceId=${enc(selectedWorkspace)}` : "/api/runtime/options",
      "GET",
      undefined,
      owner,
    );
    if (selectedWorkspace !== workspaceId || selectionGeneration !== workspaceGeneration) return;
    options = discovered;
  } catch (error) {
    if (owner !== projectId || generation !== projectGeneration || selectionGeneration !== workspaceGeneration) return;
    options = {
      models: [],
      skills: [],
      warnings: [error instanceof Error ? error.message : String(error)],
    };
  } finally {
    if (owner === projectId && generation === projectGeneration && selectionGeneration === workspaceGeneration) {
      optionsLoading = false;
      const modelSelect =
        dialog.querySelector<HTMLSelectElement>("#new-session-model");
      const reasoningSelect = dialog.querySelector<HTMLSelectElement>(
        "#new-session-reasoning",
      );
      if (dialog.open && modelSelect && reasoningSelect) {
        const selectedModel = modelSelect.value;
        const selectedReasoning = reasoningSelect.value;
        modelSelect.innerHTML = modelOptions(selectedModel);
        reasoningSelect.innerHTML = nativeReasonOptions(
          selectedModel,
          selectedReasoning,
        );
      }
      render();
    }
  }
}
async function selectWorkspace(id: string) {
  if (!state?.workspaces?.some((w) => w.id === id)) throw new Error("工作区不存在");
  const composer = app.querySelector<HTMLTextAreaElement>('.composer textarea[name="text"]');
  if (composer && session()) draft().text = composer.value;
  workspaceId = id;
  workspaceStatus = undefined;
  workspaceGeneration++;
  sessionStorage.setItem(`harness.workspace.${projectId}`, id);
  graphId = taskId = sessionId = mailAddress = "";
  Object.assign(statsFilters, { graph: "", task: "", unit: "", session: "" });
  events = [];
  eventGeneration++;
  pendingEventLoads.clear();
  clearTimeout(eventTimer);
  eventTimer = undefined;
  composing = false;
  dialog.close();
  options = { models: [], skills: [], warnings: [] };
  render(false);
  void loadOptions(projectId);
  scheduleEvents();
}
async function selectProject(id: string) {
  projectGeneration++;
  stream?.close();
  projectId = id;
  workspaceId = sessionStorage.getItem(`harness.workspace.${id}`) ?? "main";
  workspaceStatus = undefined;
  workspaceGeneration++;
  sessionStorage.setItem("harness.project", id);
  graphId = taskId = sessionId = "";
  Object.assign(statsFilters, {
    graph: "",
    task: "",
    unit: "",
    session: "",
    model: "",
    status: "",
    from: "",
    to: "",
    group: "project",
    purpose: "",
  });
  composing = false;
  events = [];
  eventGeneration++;
  pendingEventLoads.clear();
  clearTimeout(eventTimer);
  eventTimer = undefined;
  connected = false;
  state = null;
  supportsWorkspaces = false;
  options = { models: [], skills: [], warnings: [] };
  optionsLoading = true;
  dialog.close();
  render(false);
  await refresh();
  if (projectId !== id) return;
  void loadOptions(id);
  const source = new EventSource(projectUrl("/api/stream", id));
  stream = source;
  source.addEventListener("open", () => {
    if (projectId === id && stream === source) {
      connected = true;
      render();
    }
  });
  source.addEventListener("state", (event) => {
    if (projectId !== id || stream !== source) return;
    try {
      acceptState(JSON.parse(event.data));
    } catch (error) {
      showError(error);
    }
  });
  source.addEventListener("error", () => {
    if (projectId === id && stream === source) {
      connected = false;
      render();
    }
  });
  scheduleEvents();
}
async function start() {
  try {
    const registry = await api<{ projects: ProjectEntry[] }>("/api/projects");
    projects = registry.projects;
    const id = projects.find((p) => p.id === projectId)?.id ?? projects[0]?.id;
    if (id) await selectProject(id);
    else {
      app.innerHTML = `<div class="welcome"><h1>打开本地项目</h1><p class="muted">选择目录，或输入新路径创建项目。</p><button class="btn primary" data-action="project">打开或创建项目</button></div>`;
    }
  } catch (error) {
    if (error instanceof StaleProjectResponse) return;
    app.innerHTML = `<div class="welcome"><h1>无法连接本地服务</h1><p class="muted">${esc(error instanceof Error ? error.message : error)}</p><button class="btn primary" id="retry">重新连接</button></div>`;
    document
      .querySelector("#retry")
      ?.addEventListener("click", () => void start());
  }
}
setInterval(() => {
  if (document.hidden || page !== "sessions" || !session()) return;
  const view = sessionResourceViews.get(draftKey());
  if (view?.open && !view.pending) void updateSessionResources("refresh");
}, 5000);
void start();
