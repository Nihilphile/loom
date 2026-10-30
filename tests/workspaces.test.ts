import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHttpServer } from "../src/server/http.ts";
import { GitWorkspaces } from "../src/server/git.ts";
import { ProjectStore } from "../src/server/store.ts";
import type { AppState, Graph, ProjectState, ProjectWorkspace, Runtime, RuntimeInput, RuntimeResult, RuntimeAcceptance, Session, HarnessEvent } from "../src/shared/types.ts";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "-c", "commit.gpgSign=false", ...args], { cwd, windowsHide: true })).stdout.trim();
const noValidation = async () => ({ status: "not_configured" } satisfies { status: "not_configured" });

class WorkspaceRuntime implements Runtime {
  name = "workspace test";
  capabilities = { inject: true, interrupt: true, readOnly: true, fork: true };
  holdNextAcceptance = false;
  nextPid?: number;
  turns: { input: RuntimeInput; finish: () => void; accept: () => void }[] = [];
  async start(input: RuntimeInput) {
    let finish = () => {};
    const threadId = input.threadId ?? randomUUID();
    const done = new Promise<RuntimeResult>((resolve) => { finish = () => resolve({ status: "completed", text: "done", threadId, completedTurnId: randomUUID() }); });
    let accept = () => {};
    const accepted = new Promise<RuntimeAcceptance>((resolve) => { accept = () => resolve({ status: "accepted", threadId, turnId: randomUUID() }); });
    if (!this.holdNextAcceptance) accept();
    this.holdNextAcceptance = false;
    const pid = this.nextPid;
    this.nextPid = undefined;
    this.turns.push({ input, finish, accept });
    return { accepted, done, pid,
      interrupt: async () => finish(), inject: async () => true };
  }
  async discoverOptions() { return { models: [], skills: [], warnings: [] }; }
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Workspace execution timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function repository() {
  const directory = await mkdtemp(join(tmpdir(), "loom-workspaces-"));
  const root = join(directory, "project");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await writeFile(join(root, ".gitignore"), ".newharness/\n");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  return { root, directory };
}
async function fixture(adapter = new GitWorkspaces()) {
  const { root, directory } = await repository();
  const runtime = new WorkspaceRuntime();
  const configuration = { runtime, git: adapter, projectRoot: root, catalogPath: join(directory, "catalog.json") };
  let app = await createHttpServer(configuration);
  const listen = async () => {
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    assert(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  let url = await listen();
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json();
    assert(response.ok, JSON.stringify(payload));
    return payload;
  }
  return { root, directory, runtime, request, get app() { return app; }, get url() { return url; },
    restart: async (snapshot?: ProjectState) => {
      await app.close();
      if (snapshot) { const store = new ProjectStore(root); store.save(snapshot); store.close(); }
      app = await createHttpServer(configuration); url = await listen();
    } };
}
class HeldPublication extends GitWorkspaces {
  entered = false;
  release = () => {};
  override integrateTask(...args: Parameters<GitWorkspaces["integrateTask"]>) {
    const [workspace, source, id, validate, cancelled] = args;
    return super.integrateTask(workspace, source, id, async (candidate, sha) => {
      this.entered = true;
      await new Promise<void>((resolve) => { this.release = resolve; });
      return validate(candidate, sha);
    }, cancelled);
  }
}
const graphInput = (workspaceId: string) => ({ name: "Feature graph", workspaceId,
  tasks: [{ id: "T01", title: "Implement", goal: "Write feature", deps: [], taskTypeId: "direct" }] });

test("Workspace creation isolates code and preserves session, CLI and controller ownership across restart", async () => {
  const f = await fixture();
  try {
    const a = await f.request<ProjectWorkspace>("/api/workspaces", { name: "Feature A" });
    const b = await f.request<ProjectWorkspace>("/api/workspaces", { name: "Feature B", sourceWorkspaceId: a.id });
    assert.notEqual(a.path, b.path);
    await writeFile(join(a.path, "only-a.txt"), "A");
    await assert.rejects(readFile(join(b.path, "only-a.txt")));
    await assert.rejects(readFile(join(f.root, "only-a.txt")));
    const sa = await f.request<Session>("/api/sessions", { title: "A chat", workspaceId: a.id });
    const sb = await f.request<Session>("/api/sessions", { title: "B chat", workspaceId: b.id });
    await f.request(`/api/sessions/${sa.id}/turn`, { text: "A", requestId: "A-1" });
    await f.request(`/api/sessions/${sb.id}/turn`, { text: "B", requestId: "B-1" });
    await waitFor(() => f.runtime.turns.length === 2);
    assert.equal(f.runtime.turns[0].input.cwd, a.path);
    assert.equal(f.runtime.turns[1].input.cwd, b.path);
    assert.equal(f.runtime.turns[0].input.permissionMode, "inherit");
    assert.equal(f.runtime.turns[1].input.permissionMode, "inherit");
    assert.equal(f.runtime.turns[0].input.env?.HARNESS_WORKSPACE_ID, a.id);
    assert.equal(f.runtime.turns[1].input.env?.HARNESS_WORKSPACE_ID, b.id);
    const state = await f.request<AppState>("/api/state");
    const file = join(f.directory, "graph.json");
    const input = graphInput(b.id);
    await writeFile(file, JSON.stringify({ name: input.name, tasks: input.tasks }));
    const cli = await exec(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "graph", "create", "--file", file], {
      cwd: resolve("."), windowsHide: true, env: { ...process.env, HARNESS_URL: f.url, HARNESS_PROJECT_ID: state.project?.id, HARNESS_WORKSPACE_ID: a.id, HARNESS_TOKEN: "" },
    });
    const created: Graph = JSON.parse(cli.stdout);
    assert.equal(created.workspaceId, a.id);
    const controllerId = randomUUID(), key = "workspace-controller-key-".repeat(3);
    const controller = async (body: unknown) => fetch(`${f.url}/api/projects/${state.project?.id}/controller/${controllerId}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Loom-Controller-Key": key }, body: JSON.stringify(body),
    });
    assert.equal((await controller({ op: "connect", create: true, workspaceId: b.id })).status, 200);
    const response = await controller({ op: "graph_create", requestId: "bound", name: "B controller", tasks: input.tasks });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(f.app.engine!.graph(result.graphId).workspaceId, b.id);
    assert.equal((await controller({ op: "connect", workspaceId: a.id })).status, 409);
    const before = f.app.engine!.state.sessions.length;
    assert.equal((await fetch(f.url + "/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Invalid", workspaceId: "missing" }) })).status, 400);
    assert.equal(f.app.engine!.state.sessions.length, before);
    f.runtime.turns.forEach((turn) => turn.finish());
    await waitFor(() => !f.app.engine!.busy);
    const side = await f.request<Session>(`/api/sessions/${sa.id}/sidechats`, {});
    assert.equal(side.workspaceId, a.id);
    await f.restart();
    const reopened = await f.request<AppState>("/api/state");
    assert.equal(reopened.workspaces?.find((w) => w.id === a.id)?.path, a.path);
    assert.equal(reopened.sessions.find((s) => s.id === sa.id)?.workspaceId, a.id);
    await f.request(`/api/sessions/${sa.id}/turn`, { text: "A again", requestId: "A-2" });
    await waitFor(() => f.runtime.turns.length === 3);
    assert.equal(f.runtime.turns[2].input.cwd, a.path);
    assert.equal(f.runtime.turns[2].input.permissionMode, "inherit");
    assert.equal(f.runtime.turns[2].input.threadId, reopened.sessions.find((s) => s.id === sa.id)?.threadId);
    f.runtime.turns[2].finish();
  } finally { await f.app.close(); }
});

test("Graphs share a Workspace delivery target while keeping Task branches isolated and dirty code intact", async () => {
  const { root } = await repository();
  const adapter = new GitWorkspaces();
  const main: ProjectWorkspace = { id: "main", name: "Main", path: root, kind: "main", createdAt: new Date().toISOString() };
  const original = await git(root, "rev-parse", "HEAD");
  const code = await adapter.createWorkspace(root, "feature", main);
  const feature: ProjectWorkspace = { id: "feature", name: "Feature", kind: "feature", createdAt: main.createdAt, ...code };
  const a = await adapter.createGraph(root, "a", "run", feature);
  const b = await adapter.createGraph(root, "b", "run", feature);
  const ta = await adapter.createTask(a, "T01", original);
  const tb = await adapter.createTask(b, "T01", original);
  assert.notEqual(ta.branch, tb.branch);
  await writeFile(join(ta.path, "a.txt"), "A");
  await writeFile(join(tb.path, "b.txt"), "B");
  const sa = await adapter.snapshot(ta, "A", "A");
  const sb = await adapter.snapshot(tb, "B", "B");
  await writeFile(join(code.path, "user.txt"), "keep me");
  await assert.rejects(adapter.integrateTask(a, sa, "a", noValidation, () => false), /未提交修改/);
  assert.equal(await adapter.integrationHead(a), original);
  assert.equal(await readFile(join(code.path, "user.txt"), "utf8"), "keep me");
  await unlink(join(code.path, "user.txt"));
  const receipts = await Promise.all([
    adapter.integrateTask(a, sa, "a", noValidation, () => false),
    adapter.integrateTask(b, sb, "b", noValidation, () => false),
  ]);
  assert(receipts[1].baseSha === receipts[0].integratedSha || receipts[0].baseSha === receipts[1].integratedSha);
  const publishedHead = await adapter.integrationHead(a);
  assert.equal(await readFile(join(code.path, "a.txt"), "utf8"), "A");
  assert.equal(await readFile(join(code.path, "b.txt"), "utf8"), "B");
  assert.equal(await git(code.path, "branch", "--show-current"), code.branch);
  assert.equal(await git(root, "rev-parse", "HEAD"), original);
  const manifestPath = a.path + ".json";
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.pendingPublication = receipts[0];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const key = createHash("sha256").update(JSON.stringify([a.branch, "delivery", "a"])).digest("hex");
  await git(root, "update-ref", "-d", `refs/newharness/ops/${key}`);
  const reopened = new GitWorkspaces();
  const recovery = await reopened.integrateTask(a, sa, "after-recovery", noValidation, () => false);
  assert.equal(recovery.baseSha, publishedHead);
  assert.deepEqual(await reopened.integrationReceipt(a, "a"), receipts[0]);
  assert.deepEqual(await reopened.integrateTask(a, sa, "a", noValidation, () => false), receipts[0]);
  assert.equal(await reopened.integrationHead(a), recovery.integratedSha);
});

test("Workspace Graph delivers into its checkout and blocks publication during a free Agent write", async () => {
  const adapter = new HeldPublication();
  const f = await fixture(adapter);
  try {
    const w = await f.request<ProjectWorkspace>("/api/workspaces", { name: "Feature" });
    const chat = await f.request<Session>("/api/sessions", { title: "Editing", workspaceId: w.id });
    const graph = await f.request<Graph>("/api/graphs", graphInput(w.id));
    await f.request(`/api/graphs/${graph.id}/run`, {});
    await waitFor(() => f.runtime.turns.length === 1);
    const taskTurn = f.runtime.turns[0];
    assert.equal(taskTurn.input.permissionMode, "workspace");
    assert.notEqual(taskTurn.input.cwd, w.path);
    await writeFile(join(taskTurn.input.cwd, "feature.txt"), "feature");
    const report = join(taskTurn.input.cwd, ".newharness", "reports", "result.md");
    await mkdir(join(taskTurn.input.cwd, ".newharness", "reports"), { recursive: true });
    await writeFile(report, "Ready");
    const notice = join(w.path, ".newharness", "reports", "notice.md");
    await mkdir(join(w.path, ".newharness", "reports"), { recursive: true });
    await writeFile(notice, "Read-only notification");
    await f.request("/api/letters", { graphId: graph.id, from: `session/${chat.id}`, to: [`session/${chat.id}`], title: "Notice", path: notice });
    await waitFor(() => f.runtime.turns.length === 2);
    assert.equal(f.runtime.turns[1].input.readOnly, true);
    f.runtime.turns[1].finish();
    await waitFor(() => f.app.engine!.session(chat.id).status === "idle");
    assert.equal(f.app.engine!.session(chat.id).acceptedConfig?.readOnly, true);
    f.runtime.holdNextAcceptance = true;
    await f.request(`/api/sessions/${chat.id}/turn`, { text: "Editing", requestId: "edit" });
    await waitFor(() => f.runtime.turns.length === 3);
    const response = await fetch(f.url + "/api/unit/report", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${taskTurn.input.env?.HARNESS_TOKEN}` }, body: JSON.stringify({ outcome: "ready", report }) });
    assert.equal(response.status, 200);
    taskTurn.finish();
    await waitFor(() => f.app.engine!.graph(graph.id).tasks[0].status === "blocked");
    await assert.rejects(readFile(join(w.path, "feature.txt")));
    f.runtime.turns[2].accept();
    f.runtime.turns[2].finish();
    await waitFor(() => !f.app.engine!.busy);
    await f.request(`/api/graphs/${graph.id}/resolve`, {});
    await waitFor(() => adapter.entered);
    const retryInput = { text: "After publication", requestId: "retry-after-publication" };
    const rejected = await fetch(f.url + `/api/sessions/${chat.id}/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(retryInput) });
    assert.equal(rejected.status, 400);
    adapter.release();
    await waitFor(() => f.app.engine!.graph(graph.id).status === "done");
    assert.equal(await readFile(join(w.path, "feature.txt"), "utf8"), "feature");
    await assert.rejects(readFile(join(f.root, "feature.txt")));
    assert.equal(f.runtime.turns.length, 3);
    await f.request(`/api/sessions/${chat.id}/turn`, retryInput);
    await waitFor(() => f.runtime.turns.length === 4);
    f.runtime.turns[3].finish();
  } finally { adapter.release(); f.runtime.turns.forEach((turn) => { turn.accept(); turn.finish(); }); await f.app.close(); }
});

test("Workspace publication waits for an interrupted free Agent process after service restart", async () => {
  const f = await fixture();
  const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  const stopped = new Promise<void>((resolve) => writer.once("exit", () => resolve()));
  try {
    assert(writer.pid);
    const w = await f.request<ProjectWorkspace>("/api/workspaces", { name: "Recovery" });
    const graph = await f.request<Graph>("/api/graphs", graphInput(w.id));
    await f.request(`/api/graphs/${graph.id}/run`, {});
    await waitFor(() => f.runtime.turns.length === 1);
    const turn = f.runtime.turns[0];
    await writeFile(join(turn.input.cwd, "recovered.txt"), "recovered");
    const report = join(turn.input.cwd, ".newharness", "reports", "ready.md");
    await mkdir(join(turn.input.cwd, ".newharness", "reports"), { recursive: true });
    await writeFile(report, "Ready");
    const chat = await f.request<Session>("/api/sessions", { title: "Surviving writer", workspaceId: w.id });
    f.runtime.nextPid = writer.pid;
    await f.request(`/api/sessions/${chat.id}/turn`, { text: "Write", requestId: "write" });
    await waitFor(() => f.runtime.turns.length === 2);
    const result = await fetch(f.url + "/api/unit/report", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${turn.input.env?.HARNESS_TOKEN}` }, body: JSON.stringify({ outcome: "ready", report }) });
    assert.equal(result.status, 200);
    turn.finish();
    await waitFor(() => f.app.engine!.graph(graph.id).status === "blocked");
    const snapshot = structuredClone(f.app.engine!.state);
    f.runtime.turns[1].finish();
    await f.restart(snapshot);
    await f.request(`/api/graphs/${graph.id}/resolve`, {});
    await waitFor(() => f.app.engine!.graph(graph.id).status === "blocked");
    assert.match(f.app.engine!.graph(graph.id).tasks[0].blockReason ?? "", /尚未退出/);
    await assert.rejects(readFile(join(w.path, "recovered.txt")));
    writer.kill();
    await stopped;
    await f.request(`/api/graphs/${graph.id}/resolve`, {});
    await waitFor(() => f.app.engine!.graph(graph.id).status === "done");
    assert.equal(await readFile(join(w.path, "recovered.txt"), "utf8"), "recovered");
  } finally { writer.kill(); await stopped; await f.app.close(); }
});

test("Workspace event filtering precedes the result limit", async () => {
  const f = await fixture();
  try {
    const a = await f.request<Session>("/api/sessions", { title: "Quiet" });
    const b = await f.request<ProjectWorkspace>("/api/workspaces", { name: "Busy" });
    const chat = await f.request<Session>("/api/sessions", { title: "Busy chat", workspaceId: b.id });
    f.app.engine!.record("test.quiet", "Quiet event", { sessionId: a.id });
    for (let i = 0; i < 2001; i++) f.app.engine!.record("test.busy", "Busy event", { sessionId: chat.id });
    const events = await f.request<HarnessEvent[]>("/api/events?workspaceId=main");
    assert(events.some((e) => e.type === "test.quiet"));
    assert(!events.some((e) => e.type === "test.busy"));
  } finally { await f.app.close(); }
});
