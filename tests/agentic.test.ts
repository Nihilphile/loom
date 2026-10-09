import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessEngine } from "../src/server/engine.ts";
import { Catalog } from "../src/server/catalog.ts";
import type { AgentCommand, GitAdapter, Runtime, RuntimeInput, RuntimeResult } from "../src/shared/types.ts";

class ManualRuntime implements Runtime {
  name = "agentic lifecycle";
  capabilities = { inject: true, interrupt: true, readOnly: true };
  turns: { input: RuntimeInput; finish: (value?: Partial<RuntimeResult>) => void }[] = [];
  async discoverOptions() {
    return { models: [{ id: "test-model", name: "Test", reasoning: ["high" as const] }], skills: [], warnings: [] };
  }
  async start(input: RuntimeInput) {
    const index = this.turns.length;
    const threadId = input.threadId ?? `thread-${index}`;
    let finish!: (result?: Partial<RuntimeResult>) => void;
    const done = new Promise<RuntimeResult>((resolve) => {
      finish = (result) => resolve({ status: "completed", text: `result-${index}`, threadId, completedTurnId: `turn-${index}`, ...result });
    });
    this.turns.push({ input, finish });
    return {
      accepted: Promise.resolve({ status: "accepted" as const, threadId, turnId: `turn-${index}` }),
      done, inject: async () => true,
      interrupt: async () => { finish({ status: "interrupted" }); },
    };
  }
}
async function flush() {
  for (let i = 0; i < 16; i++) await new Promise((r) => setImmediate(r));
}
function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "loom-agentic-"));
  const runtime = new ManualRuntime();
  const integrations: string[] = [];
  const git: GitAdapter = {
    createGraph: async () => ({ path: root, branch: "graph", baseCommit: "base" }),
    createTask: async (_, id) => {
      const path = join(root, id); mkdirSync(path, { recursive: true });
      return { path, branch: id, baseCommit: "base" };
    },
    createChild: async (parent, id) => {
      const path = join(root, "children", id); mkdirSync(path, { recursive: true });
      return { path, branch: id, baseCommit: parent.baseCommit };
    },
    snapshot: async (workspace) => `sha-${workspace.branch}`,
    integrateChild: async (_, __, sha) => { integrations.push(sha); return sha; },
    mergeFinal: async () => "final",
  };
  const catalog = new Catalog(join(root, "catalog.json"));
  for (const type of catalog.taskTypes)
    type.units[0].delegation = { enabled: true, maxDepth: 2, maxConcurrent: 4 };
  const engine = new HarnessEngine(root, runtime, git, catalog);
  let closed = false;
  t.after(async () => { if (!closed) { await engine.shutdown(); engine.close(); } });
  return { root, runtime, integrations, git, catalog, engine, release: () => { closed = true; engine.close(); } };
}
async function begin(f: ReturnType<typeof fixture>, type = "reviewed") {
  const graph = f.engine.createGraph({ name: "agentic", tasks: [{ title: "work", goal: "implement", deps: [], taskTypeId: type }] });
  await f.engine.runGraph(graph.id); await flush();
  return graph;
}
async function call(f: ReturnType<typeof fixture>, turn: number, command: AgentCommand) {
  const result = await f.runtime.turns[turn].input.agentTool!(command);
  if (result && typeof result === "object" && !("sessionId" in result) && "error" in result && typeof result.error === "string") throw new Error(result.error);
  await flush();
  return result as { sessionId: string; executionId: string; output: string; children: { sessionId: string; executionId: string }[] };
}
function report(f: ReturnType<typeof fixture>, turn: number, outcome: "ready" | "approved" = "ready") {
  const input = f.runtime.turns[turn].input;
  const path = join(input.cwd, `report-${turn}.md`); writeFileSync(path, "evidence");
  return f.engine.submit(input.env!.HARNESS_TOKEN, { outcome, report: path });
}

test("nested child completion continues the direct parent and integrated delivery still requires outer review", async (t) => {
  const f = fixture(t), graph = await begin(f);
  const writer = await call(f, 0, { op: "spawn", requestId: "writer", title: "writer", prompt: "write", access: "write" });
  assert.deepEqual(f.runtime.turns[1].input.env, {});
  assert.equal(f.engine.state.executions[1].tokenHash, undefined);
  assert.notEqual(f.runtime.turns[0].input.cwd, f.runtime.turns[1].input.cwd);
  const nested = await call(f, 1, { op: "spawn", requestId: "nested", title: "nested", prompt: "inspect", access: "read" });
  assert.throws(() => report(f, 0), /descendants/);
  f.runtime.turns[0].finish(); f.runtime.turns[1].finish(); await flush();
  assert.equal(graph.tasks[0].units[0].reportRetries, 0);
  assert.equal(f.runtime.turns.length, 3);
  f.runtime.turns[2].finish(); await flush();
  assert.equal(f.runtime.turns.length, 4);
  assert.equal(f.runtime.turns[3].input.threadId, "thread-1");
  assert.match(f.runtime.turns[3].input.prompt, /result-2/);
  assert.equal(f.engine.session(nested.sessionId).child!.state, "finished");
  f.runtime.turns[3].finish(); await flush();
  assert.equal(f.runtime.turns.length, 5);
  assert.equal(f.runtime.turns[4].input.threadId, "thread-0");
  assert.throws(() => report(f, 4), /descendants/);
  const resultId = f.engine.session(writer.sessionId).child!.resultExecutionId!;
  await assert.rejects(call(f, 4, { op: "integrate", requestId: "wrong", sessionId: writer.sessionId, executionId: "old" }), /changed/);
  const command = { op: "integrate" as const, requestId: "merge", sessionId: writer.sessionId, executionId: resultId };
  await call(f, 4, command); await call(f, 4, command);
  assert.equal(f.integrations.length, 1);
  report(f, 4);
  await assert.rejects(call(f, 4, { op: "spawn", requestId: "late", title: "late", prompt: "late" }), /unavailable/);
  assert.equal(f.runtime.turns.length, 5);
  f.runtime.turns[4].finish(); await flush();
  assert.equal(f.runtime.turns.length, 6);
  assert.equal(f.runtime.turns[5].input.delegation, "disabled");
  report(f, 5, "approved"); f.runtime.turns[5].finish(); await flush();
  assert.equal(graph.status, "done");
});

test("spawn retries are idempotent and readonly results need no acceptance before same-thread continuation", async (t) => {
  const f = fixture(t); await begin(f);
  const command = { op: "spawn" as const, requestId: "read", title: "reader", prompt: "read", access: "read" as const, model: "test-model", reasoning: "high" as const };
  const child = await call(f, 0, command), duplicate = await call(f, 0, command);
  assert.equal(child.sessionId, duplicate.sessionId); assert.equal(f.runtime.turns.length, 2);
  await assert.rejects(call(f, 1, { op: "spawn", requestId: "elevate", title: "bad", prompt: "write", access: "write" }), /exceed/);
  await assert.rejects(call(f, 0, { ...command, requestId: "bad-model", model: "missing" }), /catalog/);
  f.runtime.turns[1].finish(); await flush();
  await call(f, 0, { op: "wait", sessionIds: [child.sessionId] });
  await call(f, 0, { op: "send", requestId: "continue", sessionId: child.sessionId, prompt: "verify again" });
  assert.equal(f.runtime.turns[2].input.threadId, "thread-1");
  f.runtime.turns[2].finish(); await flush();
  await call(f, 0, { op: "list" });
  report(f, 0); f.runtime.turns[0].finish(); await flush();
  assert.equal(f.runtime.turns.length, 4);
  assert.equal(f.runtime.turns[3].input.readOnly, true);
});

test("soft pause persists notices and starts no continuation until resume", async (t) => {
  const f = fixture(t), graph = await begin(f);
  await call(f, 0, { op: "spawn", requestId: "read", title: "reader", prompt: "read", access: "read" });
  f.runtime.turns[0].finish(); await flush();
  await f.engine.pauseGraph(graph.id, "soft");
  f.runtime.turns[1].finish(); await flush();
  assert.equal(graph.status, "paused"); assert.equal(f.runtime.turns.length, 2);
  assert.equal(graph.tasks[0].units[0].reportRetries, 0);
  f.engine.resumeGraph(graph.id); await flush();
  assert.equal(f.runtime.turns.length, 3);
  assert.equal(f.runtime.turns[2].input.threadId, "thread-0");
});

test("hard pause interrupts all descendants and preserves resumable identity", async (t) => {
  const f = fixture(t), graph = await begin(f);
  const child = await call(f, 0, { op: "spawn", requestId: "read", title: "reader", prompt: "read", access: "read" });
  await f.engine.pauseGraph(graph.id, "hard"); await flush();
  assert.equal(graph.status, "paused");
  assert(f.engine.state.executions.every((e) => e.status === "interrupted"));
  assert.equal(f.engine.session(child.sessionId).child!.state, "interrupted");
  f.engine.resumeGraph(graph.id); await flush();
  assert.equal(f.runtime.turns.length, 3);
  await call(f, 2, { op: "send", requestId: "resume-child", sessionId: child.sessionId, prompt: "continue" });
  assert.equal(f.runtime.turns[3].input.threadId, "thread-1");
});

test("single agent units cannot delegate through the engine callback boundary", async (t) => {
  const f = fixture(t); f.catalog.taskTypes.find((x) => x.id === "direct")!.units[0].delegation = { enabled: false };
  await begin(f, "direct");
  assert.equal(f.runtime.turns[0].input.agentTool, undefined);
  assert.equal(f.runtime.turns[0].input.delegation, "disabled");
  await assert.rejects(f.engine.agentCommand(f.engine.state.executions[0].id, { op: "spawn", requestId: "x", title: "x", prompt: "x" }), /unavailable/);
});

test("report cannot seal while child workspace preparation is pending and soft pause prevents its dispatch", async (t) => {
  const f = fixture(t), graph = await begin(f);
  const create = f.git.createChild!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.git.createChild = async (parent, id) => { await gate; return create(parent, id); };
  const pending = call(f, 0, { op: "spawn", requestId: "slow", title: "slow", prompt: "read", access: "read" });
  const outcome = assert.rejects(pending, /interrupted/);
  await flush();
  assert.throws(() => report(f, 0), /descendants/);
  await f.engine.pauseGraph(graph.id, "soft");
  release(); await outcome;
  f.runtime.turns[0].finish(); await flush();
  assert.equal(graph.status, "paused");
  assert.equal(f.runtime.turns.length, 1);
  assert.equal(f.engine.state.sessions.find((s) => s.child)!.child!.state, "failed");
  f.engine.resumeGraph(graph.id); await flush();
  assert.equal(f.runtime.turns.length, 2);
  assert.match(f.runtime.turns[1].input.prompt, /interrupted before dispatch/);
});

test("restart retains child and native identity, pauses safely, and never replays an uncertain input", async (t) => {
  const f = fixture(t), graph = await begin(f);
  const child = await call(f, 0, { op: "spawn", requestId: "child", title: "child", prompt: "read", access: "read" });
  const preparation = f.engine.state.preparations.find((p) => p.sessionId === child.sessionId)!;
  assert.equal(preparation.mode, "initialize");
  preparation.receipt = { status: "dispatching" };
  f.engine.record("test.crash", "Simulate lost runtime acceptance");
  const crashed = structuredClone(f.engine.state);
  await f.engine.shutdown();
  f.engine.store.save(crashed);
  f.release();
  const recoveredRuntime = new ManualRuntime();
  const recovered = new HarnessEngine(f.root, recoveredRuntime, f.git, f.catalog);
  t.after(async () => { await recovered.shutdown(); recovered.close(); });
  assert.equal(recovered.graph(graph.id).status, "paused");
  assert.equal(recovered.session(child.sessionId).threadId, "thread-1");
  assert.equal(recovered.session(child.sessionId).child!.state, "interrupted");
  assert.equal(recovered.state.preparations.find((p) => p.id === preparation.id)!.receipt.status, "uncertain");
  assert.equal(recoveredRuntime.turns.length, 0);
  await assert.rejects(recovered.sendMessage(child.sessionId, "bypass"), /Task sessions/);
});

test("failed child input preparation notifies its parent instead of leaving an active child barrier", async (t) => {
  const f = fixture(t), graph = await begin(f);
  const child = await call(f, 0, { op: "spawn", requestId: "child", title: "child", prompt: "read", access: "read" });
  f.runtime.turns[1].finish(); await flush();
  await call(f, 0, { op: "wait" });
  f.engine.state.preparations.find((p) => p.sessionId === child.sessionId)!.receipt = { status: "uncertain", reason: "test" };
  await call(f, 0, { op: "send", requestId: "uncertain", sessionId: child.sessionId, prompt: "continue" }).catch(() => {});
  assert.equal(f.engine.session(child.sessionId).child!.state, "failed");
  assert(f.engine.session(graph.tasks[0].units[0].sessionId!).childNotices?.some((n) => !n.consumed));
  assert.throws(() => report(f, 0), /descendants/);
});

test("cancelling and explicitly discarding a writable subtree releases delivery without deleting its workspaces", async (t) => {
  const f = fixture(t); await begin(f);
  const child = await call(f, 0, { op: "spawn", requestId: "writer", title: "writer", prompt: "write", access: "write" });
  const nested = await call(f, 1, { op: "spawn", requestId: "nested", title: "nested", prompt: "write", access: "write" });
  await call(f, 0, { op: "cancel", sessionId: child.sessionId });
  const direct = f.engine.session(child.sessionId);
  assert.equal(direct.child!.state, "cancelled");
  assert.equal(f.engine.session(nested.sessionId).child!.output, "pending");
  assert.throws(() => report(f, 0), /descendants/);
  await call(f, 0, { op: "discard", requestId: "discard-tree", sessionId: child.sessionId, executionId: direct.child!.resultExecutionId! });
  assert.equal(f.engine.session(nested.sessionId).child!.output, "discarded");
  report(f, 0);
  assert.equal(f.integrations.length, 0);
});

for (const mode of ["soft", "hard"] as const) test(`${mode} pause waits for the completed child's pending Git snapshot`, async (t) => {
  const f = fixture(t), graph = await begin(f);
  await call(f, 0, { op: "spawn", requestId: "writer", title: "writer", prompt: "write", access: "write" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const snapshot = f.git.snapshot;
  f.git.snapshot = async (...args) => { await gate; return snapshot(...args); };
  f.runtime.turns[0].finish(); f.runtime.turns[1].finish(); await flush();
  assert(f.engine.state.executions.every((e) => e.status === "completed"));
  await f.engine.pauseGraph(graph.id, mode);
  assert.equal(graph.status, "pausing");
  release(); await flush();
  assert.equal(graph.status, "paused");
});

test("a child cannot inherit a model outside the delegation model allowlist", async (t) => {
  const f = fixture(t);
  f.catalog.taskTypes.find((x) => x.id === "direct")!.units[0].delegation = { enabled: true, maxDepth: 2, maxConcurrent: 4, models: ["test-model"] };
  await begin(f, "direct");
  await assert.rejects(call(f, 0, { op: "spawn", requestId: "default", title: "child", prompt: "read", access: "read" }), /allowed catalog/);
  await call(f, 0, { op: "spawn", requestId: "selected", title: "child", prompt: "read", access: "read", model: "test-model", reasoning: "high" });
  assert.equal(f.runtime.turns[1].input.model, "test-model");
});

test("failed writable snapshots still block delivery until explicit discard", async (t) => {
  const f = fixture(t); await begin(f);
  const child = await call(f, 0, { op: "spawn", requestId: "writer", title: "writer", prompt: "write", access: "write" });
  f.git.snapshot = async () => { throw new Error("snapshot failed"); };
  f.runtime.turns[1].finish(); await flush();
  const output = f.engine.session(child.sessionId).child!;
  assert.equal(output.state, "failed");
  assert.equal(output.output, "conflict");
  await call(f, 0, { op: "wait" });
  assert.throws(() => report(f, 0), /descendants/);
  await call(f, 0, { op: "discard", requestId: "discard", sessionId: child.sessionId, executionId: output.resultExecutionId! });
  report(f, 0);
});

test("failed workspace creation cannot continue a child inside the parent's workspace", async (t) => {
  const f = fixture(t); await begin(f);
  f.git.createChild = async () => { throw new Error("workspace unavailable"); };
  await assert.rejects(call(f, 0, { op: "spawn", requestId: "writer", title: "writer", prompt: "write", access: "write" }), /workspace unavailable/);
  const child = f.engine.state.sessions.find((s) => s.child)!;
  assert.equal(child.child!.workspace.path, "");
  await assert.rejects(call(f, 0, { op: "send", requestId: "resume", sessionId: child.id, prompt: "write" }), /workspace preparation failed/);
  assert.equal(f.runtime.turns.length, 1);
});

test("shutdown drains a child workspace operation after the native parent turn is interrupted", async (t) => {
  const f = fixture(t); await begin(f);
  const create = f.git.createChild!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.git.createChild = async (parent, id) => { await gate; return create(parent, id); };
  const pending = call(f, 0, { op: "spawn", requestId: "slow", title: "slow", prompt: "read", access: "read" });
  const rejected = assert.rejects(pending, /interrupted/);
  await flush();
  let stopped = false;
  const shutdown = f.engine.shutdown().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  release(); await rejected; await shutdown;
  assert.equal(stopped, true);
  assert.equal(f.runtime.turns.length, 1);
});
