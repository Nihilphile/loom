import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessEngine } from "../src/server/engine.ts";
import { Catalog } from "../src/server/catalog.ts";
import { GitWorkspaces } from "../src/server/git.ts";
import { createHttpServer } from "../src/server/http.ts";
import { controllerCommandSchema } from "../src/shared/controller.ts";
import { sessionError } from "../web/agentic.ts";
import type { Runtime, RuntimeInput, RuntimeEvent, RuntimeResult } from "../src/shared/types.ts";

const key = "fixture-controller-key-01234567890123456789";
class ControllerRuntime implements Runtime {
  name = "controller fixture";
  capabilities = { inject: true, interrupt: true, readOnly: true, fork: true };
  starts: RuntimeInput[] = [];
  injections: string[] = [];
  uncertain = false;
  rejected = false;
  rejectionReason = "native turn rejected";
  eventThreadId?: string;
  receiptThreadId?: string;
  resultThreadId?: string;
  finish: (() => void)[] = [];
  discoverOptions = async (_cwd: string) => ({ models: [{ id: "fixture", name: "fixture", reasoning: [] }], skills: [], warnings: [] });
  async start(input: RuntimeInput, emit: (event: RuntimeEvent) => void) {
    this.starts.push(input);
    const threadId = input.fork ? `fork-${this.starts.length}` : input.threadId ?? "native";
    emit({ type: "thread.started", threadId: this.eventThreadId ?? threadId });
    let finish!: () => void;
    const done = new Promise<RuntimeResult>((resolve) => { finish = () => resolve({ status: "completed", text: "done", threadId: this.resultThreadId ?? threadId }); });
    this.finish.push(finish);
    return { accepted: Promise.resolve(this.rejected ? { status: "rejected" as const, reason: this.rejectionReason } : this.uncertain ? { status: "uncertain" as const, reason: "lost native acknowledgement" } : { status: "accepted" as const, threadId: this.receiptThreadId ?? threadId, turnId: "checkpoint" }), done,
      inject: async (text: string) => { this.injections.push(text); return true; }, interrupt: async () => { finish(); } };
  }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Controller fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "loom-controller-"));
  const runtime = new ControllerRuntime();
  const catalog = new Catalog(join(root, "catalog.json"));
  let engine = new HarnessEngine(root, runtime, new GitWorkspaces(), catalog);
  t.after(async () => { await engine.shutdown(); engine.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (session: string, input: unknown, principal = key) => engine.controllerCommand(session, principal, controllerCommandSchema.parse(input));
  return { root, runtime, get engine() { return engine; }, call,
    restart: () => { engine.close(); engine = new HarnessEngine(root, runtime, new GitWorkspaces(), catalog); } };
}
const graphInput = (requestId: string) => ({ op: "graph_create", requestId, name: requestId,
  tasks: [{ id: "A", title: "A", goal: "fixture", deps: [], taskTypeId: "direct" }] });

test("controller identity rejects active, idle and historical native thread aliases without partial binding", async (t) => {
  for (const history of ["active", "idle", "execution-only"]) {
    const f = fixture(t), original = f.engine.createSession({ title: history }), alias = randomUUID();
    await f.engine.sendMessage(original.id, "normal Loom execution");
    const threadId = original.threadId!;
    if (history !== "active") { f.runtime.finish[0](); await until(() => !f.engine.busy); }
    if (history === "execution-only") original.threadId = undefined;
    await assert.rejects(f.call(alias, { op: "connect", create: true, threadId }), /native thread.*another session/i);
    assert.equal(f.engine.state.sessions.some((s) => s.id === alias), false);
    assert.equal(f.engine.state.controllerAccess?.some((a) => a.sessionId === alias) ?? false, false);
    const empty = f.engine.createSession({ title: "existing empty target" });
    await assert.rejects(f.call(empty.id, { op: "connect", threadId }), /native thread.*another session/i);
    assert.notEqual(empty.executionOwner?.kind, "external");
    if (history === "active") { f.runtime.finish[0](); await until(() => !f.engine.busy); }
    original.threadId = threadId;
    await f.call(original.id, { op: "connect" });
    assert.equal(original.executionOwner?.kind, "external");
    assert.equal(original.threadId, threadId);
    await f.call(original.id, { op: "connect", threadId });
  }
});

test("unique external native identities reconnect and block legacy aliases at Loom execution entries", async (t) => {
  const f = fixture(t), id = randomUUID(), threadId = "desktop-unique-native";
  await f.call(id, { op: "connect", create: true, threadId });
  f.restart();
  await f.call(id, { op: "connect", threadId });
  const alias = f.engine.createSession({ title: "legacy alias" }); alias.threadId = threadId;
  await assert.rejects(f.engine.sendMessage(alias.id, "must not resume Desktop"), /managed by Desktop/);
  assert.throws(() => f.engine.continueQueue(alias.id), /managed by Desktop/);
  assert.equal(f.runtime.starts.length, 0);
  await assert.rejects(f.call(randomUUID(), { op: "connect", create: true, threadId }), /native thread.*another session/i);
});

test("native identity updates cannot assign a Desktop thread through events, receipts, results or preparation resolution", async (t) => {
  for (const channel of ["eventThreadId", "receiptThreadId", "resultThreadId"] as const) {
    const f = fixture(t), external = randomUUID(), threadId = "desktop-protected-native";
    await f.call(external, { op: "connect", create: true, threadId });
    f.runtime[channel] = threadId;
    const internal = f.engine.createSession({ title: channel });
    await f.engine.sendMessage(internal.id, "new independent execution");
    await until(() => f.runtime.starts.length === 1);
    f.runtime.finish[0]?.(); await until(() => !f.engine.busy);
    assert.equal(internal.status, "failed");
    assert.notEqual(internal.threadId, threadId);
    assert.equal(f.engine.session(external).threadId, threadId);
    assert.notEqual(f.runtime.starts[0].threadId, threadId);
  }
  const f = fixture(t), internal = f.engine.createSession({ title: "uncertain" });
  f.runtime.uncertain = true;
  await f.engine.sendMessage(internal.id, "uncertain execution");
  f.runtime.finish[0](); await until(() => !f.engine.busy);
  await f.call(randomUUID(), { op: "connect", create: true, threadId: "desktop-resolve-native" });
  const preparation = f.engine.state.preparations.find((p) => p.sessionId === internal.id)!;
  assert.throws(() => f.engine.resolvePreparation(internal.id, preparation.id,
    { accepted: true, threadId: "desktop-resolve-native", turnId: "turn" }), /managed by Desktop/);
  assert.equal(preparation.receipt.status, "uncertain");
  assert.notEqual(internal.threadId, "desktop-resolve-native");
});

test("failed session takeover clears its current warning and preserves historical execution failure", async (t) => {
  const f = fixture(t), session = f.engine.createSession({ title: "Desktop takeover after writer conflict" });
  f.runtime.rejected = true; f.runtime.rejectionReason = "already has an active writer";
  await f.engine.sendMessage(session.id, "reproduce rejected writer");
  f.runtime.finish[0](); await until(() => !f.engine.busy);
  assert.match(sessionError(session), /already has an active writer/);
  f.restart();
  const before = f.engine.view(); assert.ok(before.executions);
  const execution = structuredClone(before.executions.find((e) => e.sessionId === session.id)!);
  assert.equal(execution.status, "failed");
  await f.call(session.id, { op: "connect" });
  f.restart();
  const view = f.engine.view(), current = view.sessions.find((s) => s.id === session.id)!;
  assert.ok(view.executions);
  assert.equal(current.status, "idle");
  assert.equal(current.executionOwner?.kind, "external");
  assert.equal(current.error, undefined);
  assert.equal(sessionError(current), "");
  assert.deepEqual(view.executions.find((e) => e.id === execution.id), execution);
  assert.equal(execution.error, "already has an active writer");
});

test("observer rejected acceptance cannot fork an externally owned source on retry or cross binding while pending", async (t) => {
  const f = fixture(t);
  f.runtime.rejected = true;
  for (const pending of [false, true]) {
    const source = f.engine.createSession({ title: "source before Desktop takeover" });
    source.threadId = `source-native-${pending}`; source.lastCompletedTurnId = "checkpoint";
    const observer = f.engine.createSidechat(source.id);
    await f.engine.sendMessage(observer.id, "first fork");
    const index = f.runtime.starts.length - 1;
    assert.ok(observer.threadId);
    assert.equal(observer.acceptedConfig, undefined);
    if (pending) await assert.rejects(f.call(source.id, { op: "connect" }), /pending Loom work/);
    f.runtime.finish[index](); await until(() => !f.engine.busy);
    assert.equal(observer.status, "failed");
    await f.call(source.id, { op: "connect" });
    const starts = f.runtime.starts.length;
    await assert.rejects(f.engine.sendMessage(observer.id, "retry after rejected turn"), /managed by Desktop/);
    assert.equal(f.runtime.starts.length, starts);
  }
});

test("acknowledging a full inbox page preserves its continuation through restart", async (t) => {
  const f = fixture(t), sessionId = randomUUID();
  await f.call(sessionId, { op: "connect", create: true });
  const created = await f.call(sessionId, graphInput("pagination")) as { graphId: string };
  const sender = f.engine.createSession({ title: "sender" });
  const path = join(f.root, "notices.md"); writeFileSync(path, "three durable notices");
  const letters = [1, 2, 3].map((n) => f.engine.sendLetter({ graphId: created.graphId, from: `session/${sender.id}`,
    to: [`session/${sessionId}`], title: `Notice ${n}`, path }));
  const page = await f.call(sessionId, { op: "inbox", graphId: created.graphId, limit: 2 }) as { items: { id: string }[]; next: string };
  assert.deepEqual(page.items.map((l) => l.id), letters.slice(0, 2).map((l) => l.id));
  assert.equal(page.next, letters[1].id);
  for (const item of page.items) await f.call(sessionId, { op: "ack", graphId: created.graphId, letterId: item.id });
  f.restart();
  const continuation = await f.call(sessionId, { op: "inbox", graphId: created.graphId, after: page.next, limit: 2 }) as { items: { id: string }[]; next: null };
  assert.deepEqual(continuation.items.map((l) => l.id), [letters[2].id]);
  assert.equal(continuation.next, null);
  assert.equal(f.runtime.starts.length, 0);
});

test("Desktop binding freezes queued input, preserves native identity and persists inbox until explicit idempotent ack", async (t) => {
  const f = fixture(t);
  const session = f.engine.createSession({ title: "Desktop" });
  session.queuePaused = true;
  await f.engine.sendMessage(session.id, { text: "preserve me", mode: "queue" });
  session.status = "failed"; session.threadId = "desktop-native";
  const graph = f.engine.createGraph({ name: "existing controller graph", tasks: [{ id: "A", title: "A", goal: "fixture", deps: [], taskTypeId: "direct" }] });
  f.engine.updateGraph(graph.id, { controllerSessionId: session.id, subscription: "completed" });
  graph.status = "done";
  const file = join(f.root, "feedback.md"); writeFileSync(file, "durable notice");
  const sender = f.engine.createSession({ title: "Sender" });
  const letter = f.engine.sendLetter({ graphId: graph.id, from: `session/${sender.id}`, to: [`session/${session.id}`], title: "Notice", path: file });
  await f.call(session.id, { op: "connect" });
  const second = await f.call(session.id, graphInput("second")) as { graphId: string };
  for (const mode of ["send", "queue", "steer"] as const)
    await assert.rejects(f.engine.sendMessage(session.id, { text: "do not dispatch", mode }), /managed by Desktop/);
  assert.throws(() => f.engine.continueQueue(session.id), /managed by Desktop/);
  await assert.rejects(f.engine.interrupt(session.id), /managed by Desktop/);
  assert.throws(() => f.engine.createSidechat(session.id), /managed by Desktop/);
  for (let i = 0; i < 2; i++) {
    const inbox = await f.call(session.id, { op: "inbox", graphId: graph.id }) as { items: { id: string }[] };
    assert.deepEqual(inbox.items.map((l) => l.id), [letter.id]);
    assert.equal(letter.deliveries[0].status, "queued");
  }
  await assert.rejects(f.call(session.id, { op: "ack", graphId: second.graphId, letterId: letter.id }), /outside this graph/);
  const ack = await f.call(session.id, { op: "ack", graphId: graph.id, letterId: letter.id });
  const eventCount = f.engine.store.events().filter((e) => e.type === "controller.acknowledged").length;
  assert.deepEqual(await f.call(session.id, { op: "ack", graphId: graph.id, letterId: letter.id }), ack);
  assert.equal(f.engine.store.events().filter((e) => e.type === "controller.acknowledged").length, eventCount);
  const newer = f.engine.sendLetter({ graphId: graph.id, from: `session/${sender.id}`, to: [`session/${session.id}`], title: "Newer", path: file });
  f.restart();
  await f.call(session.id, { op: "connect" });
  assert.deepEqual(await f.call(session.id, { op: "ack", graphId: graph.id, letterId: letter.id }), ack);
  const inbox = await f.call(session.id, { op: "inbox" }) as { items: { id: string }[] };
  assert.deepEqual(inbox.items.map((l) => l.id), [newer.id]);
  assert.deepEqual(await f.call(session.id, { op: "inbox", after: letter.id }), inbox);
  assert.equal(f.engine.session(session.id).queue?.[0].input.text, "preserve me");
  assert.equal(f.engine.session(session.id).threadId, "desktop-native");
  assert.equal(f.engine.session(session.id).queuePaused, true);
  assert.equal(f.runtime.starts.length, 0); assert.equal(f.runtime.injections.length, 0);
  assert.doesNotMatch(JSON.stringify(f.engine.view()), /keyHash|controllerAccess|fixture-controller-key/);
});

test("binding refuses uncertain native input and a still-live previous Loom process", async (t) => {
  const f = fixture(t);
  f.runtime.uncertain = true;
  const session = f.engine.createSession({ title: "uncertain native input" });
  await f.engine.sendMessage(session.id, "pending native acceptance");
  await until(() => f.runtime.starts.length === 1);
  f.runtime.finish[0](); await until(() => !f.engine.busy);
  assert.equal(session.status, "failed");
  await assert.rejects(f.call(session.id, { op: "connect" }), /pending Loom work/);
  const previous = f.engine.createSession({ title: "live previous process" });
  f.runtime.uncertain = false;
  await f.engine.sendMessage(previous.id, "fixture");
  await until(() => f.runtime.starts.length === 2);
  f.runtime.finish[1](); await until(() => !f.engine.busy);
  const execution = f.engine.state.executions.findLast((e) => e.sessionId === previous.id)!;
  execution.pid = process.pid;
  await assert.rejects(f.call(previous.id, { op: "connect" }), /previous Loom process is still alive/);
  assert.equal(execution.pid, process.pid);
});

test("controller retries survive restart, keep graphs isolated and cannot reassign an external owner", async (t) => {
  const f = fixture(t), id = randomUUID(), other = randomUUID();
  await f.call(id, { op: "connect", create: true });
  await f.call(other, { op: "connect", create: true }, key + "other");
  const graph = await f.call(id, graphInput("once")) as { graphId: string };
  const input = { op: "send_feedback", requestId: "repair", graphId: graph.graphId, taskId: "A", unitId: "worker", title: "Repair", content: "Please revise" };
  const letter = await f.call(id, input);
  f.restart();
  assert.deepEqual(await f.call(id, graphInput("once")), graph);
  assert.deepEqual(await f.call(id, input), letter);
  assert.equal(f.engine.state.graphs.length, 1); assert.equal(f.engine.state.letters.length, 1);
  await assert.rejects(f.call(id, { ...input, content: "different" }), /different arguments/);
  await assert.rejects(f.call(id, { ...graphInput("once"), name: "different" }), /different arguments/);
  for (const op of ["state", "reports", "inbox"])
    await assert.rejects(f.call(other, { op, graphId: graph.graphId }, key + "other"), /does not belong/);
  await assert.rejects(f.call(id, { op: "connect" }, key + "wrong"), /another principal/);
  const owned = f.engine.graph(graph.graphId);
  assert.throws(() => f.engine.updateGraph(owned.id, { controllerSessionId: other, subscription: "blocked" }), /cannot be reassigned/);
  assert.equal(owned.subscription, "completed");
  for (const extra of [{ integrationCommand: "shell" }, { tasks: [{ taskTypeId: "inline", units: [] }] }])
    assert.equal(controllerCommandSchema.safeParse({ ...graphInput("invalid"), ...extra }).success, false);
  await assert.rejects(f.call(id, { ...graphInput("missing"), tasks: [{ id: "A", title: "a", goal: "a", deps: [], taskTypeId: "missing" }] }));
});

test("binding refuses Task/observer/child and in-flight work; dormant first forks recheck source ownership", async (t) => {
  const f = fixture(t);
  for (const kind of ["task", "sidechat", "interview"] as const) {
    const s = f.engine.createSession({ title: kind }); s.kind = kind;
    await assert.rejects(f.call(s.id, { op: "connect" }), /idle or failed free/);
  }
  const active = f.engine.createSession({ title: "active" });
  await f.engine.sendMessage(active.id, "run");
  await assert.rejects(f.call(active.id, { op: "connect" }), /idle or failed free/);
  f.runtime.finish[0](); await until(() => !f.engine.busy);
  const child = f.engine.createSession({ title: "child" });
  child.child = { parentSessionId: active.id, depth: 1, access: "read", state: "finished", output: "none", workspace: { path: f.root, branch: "fixture", baseCommit: "fixture" } };
  await assert.rejects(f.call(child.id, { op: "connect" }), /idle or failed free/);
  const source = f.engine.createSession({ title: "fork source" });
  source.threadId = "source-native"; source.lastCompletedTurnId = "checkpoint";
  const dormant = f.engine.createSidechat(source.id);
  await f.call(source.id, { op: "connect" });
  await assert.rejects(f.engine.sendMessage(dormant.id, "first fork"), /managed by Desktop/);
  assert.equal(f.runtime.starts.length, 1);
});

test("binding cannot cross asynchronous turn validation or a first interview fork", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.runtime.discoverOptions = async () => { await gate; return { models: [{ id: "fixture", name: "fixture", reasoning: [] }], skills: [], warnings: [] }; };
  const s = f.engine.createSession({ title: "validation" });
  const send = f.engine.sendMessage(s.id, { text: "pending", skills: [{ name: "absent", path: "fixture" }] });
  await assert.rejects(f.call(s.id, { op: "connect" }), /pending Loom work/);
  const source = f.engine.createSession({ title: "interview source" });
  source.threadId = "native"; source.lastCompletedTurnId = "checkpoint";
  f.engine.state.interviews.model = "fixture";
  const interview = f.engine.interview(source.id);
  await assert.rejects(f.call(source.id, { op: "connect" }), /pending Loom work/);
  release();
  await assert.rejects(send, /unavailable/);
  await interview;
  await until(() => f.runtime.starts.length === 1);
  await f.call(source.id, { op: "connect" });
  f.runtime.finish[0](); await until(() => !f.engine.busy);
});

test("HTTP controller routes require dedicated credentials, strict inputs and explicit project selection", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loom-controller-http-"));
  const app = await createHttpServer({ runtime: new ControllerRuntime(), git: new GitWorkspaces(), projectRoot: root, catalogPath: join(root, "catalog.json") });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const address = app.server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const id = randomUUID();
  const path = `/api/projects/${app.engine!.state.project.id}/controller/${id}`;
  const request = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  assert.equal((await request(path, { op: "connect", create: true })).status, 401);
  assert.equal((await request(path, { op: "connect", create: true }, { "X-Loom-Controller-Key": key })).status, 200);
  const mixed: Record<string, string>[] = [{ Authorization: "Bearer unit-fixture" }, { Authorization: "Bearer unit-fixture", "X-Loom-Controller-Key": key }];
  for (const headers of mixed)
    assert.equal((await request(path, { op: "state" }, headers)).status, 403);
  assert.equal((await request(path, { op: "state" }, { "X-Loom-Controller-Key": key + "wrong" })).status, 403);
  assert.equal((await request(`/api/controller/${id}`, { op: "state" }, { "X-Loom-Controller-Key": key })).status, 403);
  assert.equal((await request("/api/graphs", graphInput("wrong"), { "X-Loom-Controller-Key": key })).status, 403);
  const invalid = await request(path, { op: "state", url: "http://remote" }, { "X-Loom-Controller-Key": key });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, "INVALID_ARGUMENT");
});
