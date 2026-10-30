import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, Execution, HarnessEvent } from "../src/shared/types.ts";
import { ProjectStore } from "../src/server/store.ts";
import { deriveInvocations, eventLabel, invocationStatistics, sessionTimeline } from "../web/invocations.ts";

const at = (second: number) => new Date(second * 1000).toISOString();
const tool = (id: number, phase: string, itemId: string, detail: Record<string, unknown>, second = id): HarnessEvent => ({
  id, at: at(second), type: `runtime.tool.${phase}`, message: phase, sessionId: "session", executionId: "run",
  detail: { type: `tool.${phase}`, itemId, detail },
});
const execution = (id: string, status: Execution["status"], start = 0, end = 20): Execution => ({
  id, sessionId: "session", purpose: "chat", status, startedAt: at(start), endedAt: at(end),
});

test("正文与单次调用按发生顺序混排，完成事件更新原位置并保留开始详情", () => {
  const events = [
    tool(1, "started", "one", { type: "commandExecution", command: "first command", status: "inProgress" }, 2),
    { id: 2, at: at(4), type: "runtime.assistant.delta", message: "between", executionId: "run", detail: { itemId: "between" } },
    tool(3, "started", "two", { type: "dynamicToolCall", tool: "read_file", arguments: { path: "a" } }, 4),
    tool(4, "completed", "one", { exitCode: 0 }, 5),
    tool(5, "completed", "two", { success: true }, 6),
  ];
  const messages: ChatMessage[] = [
    { id: "run/before", role: "assistant", text: "before", at: at(1) },
    { id: "run/between", role: "assistant", text: "between", at: at(4) },
  ];
  const calls = deriveInvocations(events);
  const timeline = sessionTimeline(messages, calls, events);
  assert.deepEqual(timeline.map((entry) => entry.kind === "message" ? entry.message.text : entry.invocation.name), ["before", "shell", "between", "read_file"]);
  assert.equal(calls[0].status, "completed");
  assert.equal(calls[0].at, at(2));
  assert.equal(calls[0].detail.command, "first command");
  assert.equal(calls[0].key, deriveInvocations(events.slice(0, 1))[0].key);
});

test("统计按工具名归并不同参数，成功失败各按一次调用计数且忽略原始通知", () => {
  const events = [
    tool(1, "started", "one", { type: "commandExecution", command: "first" }),
    tool(2, "completed", "one", { exitCode: 0 }),
    tool(3, "started", "two", { type: "commandExecution", command: "second" }),
    tool(4, "completed", "two", { status: "completed", exitCode: 1 }),
    { id: 5, at: at(5), type: "runtime.log", message: "log", sessionId: "session", detail: { detail: { method: "item/completed", params: { item: { type: "commandExecution", id: "one" } } } } },
  ];
  const rows = invocationStatistics(deriveInvocations([...events, events[0]]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "shell");
  assert.deepEqual(rows[0].counts, { completed: 1, failed: 1, running: 0, interrupted: 0, unknown: 0 });
  assert.equal(eventLabel(events[4]), "item/completed");
});

test("MCP 以服务与工具区分，Skill 只统计明确的调用记录", () => {
  const skill = { ...tool(5, "completed", "skill", { name: "research", success: true }), type: "runtime.skill.completed" };
  const events = [
    tool(1, "completed", "mcp1", { type: "mcpToolCall", server: "github", tool: "search", status: "completed" }),
    tool(2, "completed", "mcp2", { type: "mcpToolCall", server: "github", tool: "search", arguments: { query: "other" }, result: { isError: true } }),
    tool(3, "completed", "mcp3", { type: "mcpToolCall", server: "files", tool: "search", status: "completed" }),
    tool(4, "completed", "read-skill", { type: "dynamicToolCall", tool: "read_file", arguments: { path: "research/SKILL.md" }, success: true }),
    skill,
  ];
  const rows = invocationStatistics(deriveInvocations(events));
  assert.deepEqual(rows.filter((row) => row.kind === "mcp").map((row) => [row.name, row.counts.completed, row.counts.failed]), [["files / search", 1, 0], ["github / search", 1, 1]]);
  assert.deepEqual(rows.filter((row) => row.kind === "skill").map((row) => [row.name, row.counts.completed]), [["research", 1]]);
});

test("运行中、中断与未知结果分别保留，跨执行复用 itemId 不合并", () => {
  const first = tool(1, "started", "shared", { type: "commandExecution" }, 1);
  const second = { ...tool(2, "started", "shared", { type: "commandExecution" }, 11), executionId: "next" };
  const third = tool(3, "completed", "unknown", { type: "dynamicToolCall", tool: "read_file" }, 12);
  const calls = deriveInvocations([first, second, third], [execution("run", "interrupted", 0, 10), execution("next", "running", 11, 20)]);
  assert.deepEqual(calls.map((call) => call.status), ["interrupted", "running", "unknown"]);
  const legacy = deriveInvocations([{ ...first, executionId: undefined }, { ...second, executionId: undefined }], [execution("run", "interrupted", 0, 10), execution("next", "running", 11, 20)]);
  assert.equal(legacy.length, 2);
});

test("调用统计分页读取完整历史，默认事件流仍返回最近记录", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-invocations-"));
  const store = new ProjectStore(root);
  try {
    const state = store.load();
    for (let index = 0; index < 2001; index++) {
      const { id, ...event } = tool(index, "completed", String(index), { type: "commandExecution", exitCode: 0 });
      store.save(state, event);
    }
    store.save(state, { at: at(2100), type: "runtime.log", message: "noise", sessionId: "session" });
    store.save(state, { at: at(2101), type: "runtime.tool.completed", message: "other", sessionId: "other" });
    const first = store.events({ sessionId: "session", kind: "invocations", after: 0 });
    const second = store.events({ sessionId: "session", kind: "invocations", after: first[first.length - 1].id });
    assert.equal(first.length, 2000);
    assert.equal(first[0].id, 1);
    assert.equal(second.length, 1);
    assert.equal(invocationStatistics(deriveInvocations([...first, ...second]))[0].counts.completed, 2001);
    const recent = store.events({ sessionId: "session" });
    assert.equal(recent.length, 2000);
    assert.equal(recent[recent.length - 1].type, "runtime.log");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
