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
import type { Runtime, RuntimeInput, RuntimeEvent, RuntimeResult } from "../src/shared/types.ts";

const key = "fixture-controller-key-01234567890123456789";
class ControllerRuntime implements Runtime {
  name = "controller fixture";
  capabilities = { inject: true, interrupt: true, readOnly: true, fork: true };
  starts: RuntimeInput[] = [];
  injections: string[] = [];
  finish: (() => void)[] = [];
  discoverOptions = async (_cwd: string) => ({ models: [{ id: "fixture", name: "fixture", reasoning: [] }], skills: [], warnings: [] });
  async start(input: RuntimeInput, emit: (event: RuntimeEvent) => void) {
    this.starts.push(input);
    const threadId = input.fork ? `fork-${this.starts.length}` : input.threadId ?? "native";
    emit({ type: "thread.started", threadId });
    let finish!: () => void;
    const done = new Promise<RuntimeResult>((resolve) => { finish = () => resolve({ status: "completed", text: "done", threadId }); });
    this.finish.push(finish);
    return { accepted: Promise.resolve({ status: "accepted" as const, threadId, turnId: "checkpoint" }), done,
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

test("Desktop binding freezes queued input, preserves native identity and persists inbox until explicit idempotent ack", async (t) => {
  const f = fixture(t);
  const session = f.engine.createSession({ title: "Desktop" });
  session.queuePaused = true;
  await f.engine.sendMessage(session.id, { text: "preserve me", mode: "queue" });
  session.status = "failed"; session.threadId = "desktop-native";
  await f.call(session.id, { op: "connect" });
  const created = await f.call(session.id, graphInput("first")) as { graphId: string };
  const second = await f.call(session.id, graphInput("second")) as { graphId: string };
  const graph = f.engine.graph(created.graphId);
  graph.status = "done";
  const file = join(f.root, "feedback.md"); writeFileSync(file, "durable notice");
  const sender = f.engine.createSession({ title: "Sender" });
  const letter = f.engine.sendLetter({ graphId: graph.id, from: `session/${sender.id}`, to: [`session/${session.id}`], title: "Notice", path: file });
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
  assert.equal(f.engine.session(session.id).queue?.[0].input.text, "preserve me");
  assert.equal(f.engine.session(session.id).threadId, "desktop-native");
  assert.equal(f.engine.session(session.id).queuePaused, true);
  assert.equal(f.runtime.starts.length, 0); assert.equal(f.runtime.injections.length, 0);
  assert.doesNotMatch(JSON.stringify(f.engine.view()), /keyHash|controllerAccess|fixture-controller-key/);
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
