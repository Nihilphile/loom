import type { ChatMessage, Execution, HarnessEvent } from "../src/shared/types.ts";

export type InvocationStatus = "running" | "completed" | "failed" | "interrupted" | "unknown";
export type InvocationKind = "tool" | "mcp" | "skill";
export interface Invocation {
  key: string;
  sessionId: string;
  executionId?: string;
  itemId: string;
  kind: InvocationKind;
  name: string;
  at: string;
  firstEventId: number;
  status: InvocationStatus;
  detail: Record<string, unknown>;
  events: HarnessEvent[];
}
export interface InvocationSummary {
  kind: InvocationKind;
  name: string;
  counts: Record<InvocationStatus, number>;
}
export type TranscriptEntry =
  | { kind: "message"; message: ChatMessage }
  | { kind: "invocation"; invocation: Invocation };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const lifecycle = /^runtime\.(tool|skill|mcp)\.(started|completed|failed|interrupted)$/;

function identity(event: HarnessEvent, item: Record<string, unknown>): { kind: InvocationKind; name: string } {
  if (event.type.startsWith("runtime.skill.") || item.type === "skillInvocation")
    return { kind: "skill", name: text(item.name) || text(item.skill) || "未知 Skill" };
  if (event.type.startsWith("runtime.mcp.") || item.type === "mcpToolCall")
    return { kind: "mcp", name: [text(item.server), text(item.tool) || text(item.name)].filter(Boolean).join(" / ") || "未知 MCP 工具" };
  const names: Record<string, string> = {
    commandExecution: "shell", fileChange: "apply_patch", webSearch: "web_search",
    imageGeneration: "image_generation", computerUse: "computer_use", collabAgentToolCall: "agent",
  };
  return { kind: "tool", name: text(item.tool) || text(item.name) || names[text(item.type)] || text(item.type) || "未知工具" };
}

function outcome(event: HarnessEvent, item: Record<string, unknown>): InvocationStatus {
  const status = text(item.status).toLowerCase();
  const result = record(item.result);
  if (event.type.endsWith(".interrupted") || ["interrupted", "cancelled", "canceled", "declined"].includes(status)) return "interrupted";
  if (event.type.endsWith(".failed") || ["failed", "error"].includes(status) || item.success === false || item.isError === true || result.isError === true || item.error != null || (typeof item.exitCode === "number" && item.exitCode !== 0)) return "failed";
  if (event.type.endsWith(".started")) return "running";
  if (["completed", "succeeded", "success"].includes(status) || item.success === true || item.exitCode === 0 || item.isError === false || result.isError === false) return "completed";
  return "unknown";
}

function owningExecution(event: HarnessEvent, executions: readonly Execution[]) {
  if (event.executionId) return executions.find((e) => e.id === event.executionId);
  return executions
    .filter((e) => e.sessionId === event.sessionId && e.startedAt <= event.at && (!e.endedAt || event.at <= e.endedAt))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export function deriveInvocations(events: readonly HarnessEvent[], executions: readonly Execution[] = []): Invocation[] {
  const calls = new Map<string, Invocation>();
  const active = new Map<string, Invocation>();
  const seen = new Set<number>();
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (!lifecycle.test(event.type) || seen.has(event.id)) continue;
    seen.add(event.id);
    const runtime = record(event.detail);
    const item = record(runtime.detail);
    const itemId = text(runtime.itemId) || text(item.id);
    const execution = owningExecution(event, executions);
    const executionId = event.executionId || execution?.id;
    const scope = JSON.stringify([event.sessionId ?? "", executionId ?? text(runtime.threadId), itemId || event.id]);
    let call = active.get(scope);
    if (!call || (!executionId && event.type.endsWith(".started") && call.status !== "running")) {
      const key = `${scope}/${event.id}`;
      call = {
        key, sessionId: event.sessionId ?? "", executionId, itemId,
        ...identity(event, item), at: event.at, firstEventId: event.id,
        status: "running", detail: {}, events: [],
      };
      active.set(scope, call);
      calls.set(key, call);
    }
    call.detail = { ...call.detail, ...item };
    Object.assign(call, identity(event, call.detail));
    call.status = outcome(event, call.detail);
    call.events.push(event);
  }
  for (const call of calls.values()) {
    if (call.status !== "running" || !call.executionId) continue;
    const execution = executions.find((e) => e.id === call.executionId);
    if (execution?.status === "interrupted") call.status = "interrupted";
    else if (execution?.status === "failed" || execution?.status === "completed") call.status = "unknown";
  }
  return [...calls.values()];
}

export function invocationStatistics(calls: readonly Invocation[]): InvocationSummary[] {
  const rows = new Map<string, InvocationSummary>();
  for (const call of calls) {
    const key = JSON.stringify([call.kind, call.name]);
    let row = rows.get(key);
    if (!row) {
      row = { kind: call.kind, name: call.name, counts: { running: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 } };
      rows.set(key, row);
    }
    row.counts[call.status]++;
  }
  return [...rows.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

export function sessionTimeline(messages: readonly ChatMessage[], calls: readonly Invocation[], events: readonly HarnessEvent[] = []): TranscriptEntry[] {
  const anchors = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "runtime.assistant.delta") continue;
    const runtime = record(event.detail);
    const itemId = text(runtime.itemId);
    if (!itemId) continue;
    const key = event.executionId ? `${event.executionId}/${itemId}` : itemId;
    if (!anchors.has(key)) anchors.set(key, event.id);
  }
  const entries = [
    ...messages.map((message, index) => ({ entry: { kind: "message", message } satisfies TranscriptEntry, at: message.at, eventId: anchors.get(message.id) ?? anchors.get(message.id.slice(message.id.indexOf("/") + 1)), index })),
    ...calls.map((invocation, index) => ({ entry: { kind: "invocation", invocation } satisfies TranscriptEntry, at: invocation.at, eventId: invocation.firstEventId, index: messages.length + index })),
  ];
  entries.sort((a, b) => a.at.localeCompare(b.at) || (a.eventId !== undefined && b.eventId !== undefined ? a.eventId - b.eventId : a.index - b.index));
  return entries.map((row) => row.entry);
}

export function eventLabel(event: HarnessEvent): string {
  const runtime = record(event.detail);
  if (lifecycle.test(event.type)) return identity(event, record(runtime.detail)).name;
  if (event.type === "runtime.log") return text(record(runtime.detail).method) || event.message;
  return event.message;
}
