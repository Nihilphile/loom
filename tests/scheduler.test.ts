import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHttpServer } from "../src/server/http.ts";
import { GitWorkspaces } from "../src/server/git.ts";
import type {
  Runtime,
  RuntimeInput,
  RuntimeEvent,
  RuntimeResult,
  Graph,
  Session,
  AppState,
} from "../src/shared/types.ts";

const exec = promisify(execFile);
class ControlledRuntime implements Runtime {
  name = "controlled test runtime";
  capabilities = { inject: true, interrupt: true, readOnly: true };
  turns: {
    input: RuntimeInput;
    emit: (e: RuntimeEvent) => void;
    finish: (result?: Partial<RuntimeResult>) => void;
    injected: string[];
  }[] = [];
  async start(input: RuntimeInput, emit: (e: RuntimeEvent) => void) {
    let finish!: (result?: Partial<RuntimeResult>) => void;
    const done = new Promise<RuntimeResult>(
      (resolve) =>
        (finish = (result) =>
          resolve({
            status: "completed",
            text: "finished",
            threadId: input.threadId || "thread-" + this.turns.length,
            ...result,
          })),
    );
    const turn = { input, emit, finish, injected: [] as string[] };
    this.turns.push(turn);
    emit({
      type: "thread.started",
      threadId: input.threadId || "thread-" + this.turns.length,
    });
    return {
      accepted: Promise.resolve({
        status: "accepted" as const,
        threadId: input.threadId || "thread",
        turnId: "turn",
      }),
      done,
      interrupt: async () => {
        finish({ status: "interrupted" });
        await done;
      },
      inject: async (text: string) => {
        turn.injected.push(text);
        return true;
      },
    };
  }
}
async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out " + label);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function fixture(git = new GitWorkspaces()) {
  const root = await mkdtemp(join(tmpdir(), "harness-behavior-"));
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(join(root, "base.txt"), "base");
  await exec("git", ["add", "."], { cwd: root });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@local",
      "commit",
      "-m",
      "base",
    ],
    { cwd: root },
  );
  const runtime = new ControlledRuntime();
  const app = await createHttpServer({
    runtime,
    git,
    projectRoot: root,
    catalogPath: join(root, "catalog.json"),
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  async function request(
    path: string,
    body?: unknown,
    token?: string,
    method = body ? "POST" : "GET",
  ) {
    const response = await fetch(url + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  async function report(turnIndex: number, outcome: string) {
    const turn = runtime.turns[turnIndex],
      path = join(
        turn.input.cwd,
        ".newharness",
        "reports",
        `test-${turnIndex}.md`,
      );
    await mkdir(join(turn.input.cwd, ".newharness", "reports"), {
      recursive: true,
    });
    await writeFile(path, "Evidence for " + outcome);
    const result = await request(
      "/api/unit/report",
      { outcome, report: path },
      turn.input.env!.HARNESS_TOKEN,
    );
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return { path, data: result.data };
  }
  return { root, runtime, app, url, request, report };
}

class HeldIntegration extends GitWorkspaces {
  release?: () => void;
  entered = false;
  override integrateTask(...args: Parameters<GitWorkspaces["integrateTask"]>) {
    const [workspace, source, id, validate, cancelled] = args;
    return super.integrateTask(workspace, source, id, async (candidate, sha) => {
      this.entered = true;
      await new Promise<void>((resolve) => { this.release = resolve; });
      return validate(candidate, sha);
    }, cancelled);
  }
}

class HeldIntegrationHead extends GitWorkspaces {
  hold = false;
  entered = false;
  release?: () => void;
  override async integrationHead(workspace: Parameters<GitWorkspaces["integrationHead"]>[0]) {
    if (this.hold) {
      this.hold = false;
      this.entered = true;
      await new Promise<void>((resolve) => { this.release = resolve; });
    }
    return super.integrationHead(workspace);
  }
}

test("resuming an idle blocked graph restores blocked status without rerunning work", async () => {
  const f = await fixture();
  try {
    const created = await f.request("/api/graphs", {
      name: "blocked resume",
      tasks: [{ id: "A", title: "a", goal: "a", deps: [], taskTypeId: "direct" }],
    });
    assert.equal(created.status, 201);
    const graph = f.app.engine!.graph(created.data.id);
    assert.equal((await f.request(`/api/graphs/${graph.id}/run`, {})).status, 200);
    await waitFor(() => f.runtime.turns.length === 1, "initial worker");
    await f.report(0, "blocked");
    f.runtime.turns[0].finish();
    await waitFor(() => graph.status === "blocked" && !f.app.engine!.busy, "blocked work settled");
    const blockReason = graph.tasks[0].blockReason;

    assert.equal((await f.request(`/api/graphs/${graph.id}/pause`, { mode: "hard" })).status, 200);
    assert.equal(graph.status, "paused");
    assert.equal((await f.request(`/api/graphs/${graph.id}/resume`, {})).status, 200);
    await waitFor(() => !f.app.engine!.busy, "resume settled");

    assert.equal(graph.status, "blocked");
    assert.equal(graph.tasks[0].status, "blocked");
    assert.equal(graph.tasks[0].blockReason, blockReason);
    assert.equal(f.runtime.turns.length, 1);
  } finally {
    await f.app.close();
  }
});

for (const action of ["resume", "resolve", "close"] as const) {
  test(`pending ${action === "resolve" ? "resolve" : "resume"} cannot override concurrent ${action === "close" ? "close" : "hard pause"} or permit edits`, async () => {
    const adapter = new HeldIntegrationHead();
    const f = await fixture(adapter);
    try {
      const graph = f.app.engine!.createGraph({ name: "lifecycle race", tasks: [
        { id: "A", title: "a", goal: "a", deps: [], taskTypeId: "direct" },
      ] });
      await f.app.engine!.runGraph(graph.id);
      await waitFor(() => f.runtime.turns.length === 1, "initial worker");
      if (action === "resolve") {
        await f.report(0, "blocked"); f.runtime.turns[0].finish();
        await waitFor(() => graph.status === "blocked", "blocked work");
      } else await f.app.engine!.pauseGraph(graph.id, "hard");
      adapter.hold = true;
      const control = action === "resolve" ? f.app.engine!.resolveGraph(graph.id) : f.app.engine!.resumeGraph(graph.id);
      await waitFor(() => adapter.entered, "reconciliation held");
      assert.equal(f.app.engine!.busy, true);
      assert.throws(() => f.app.engine!.editTask(graph.id, "A", { goal: "unsafe edit" }), /等待当前执行结束/);
      const stopping = action === "close" ? f.app.close() : f.app.engine!.pauseGraph(graph.id, "hard");
      assert.equal(graph.status, "pausing");
      adapter.release!();
      await Promise.all([control, stopping]);
      assert.equal(graph.status, "paused");
      assert.equal(f.runtime.turns.length, 1);
      assert.equal(f.app.engine!.busy, false);
    } finally {
      adapter.release?.();
      if (f.app.server.listening) await f.app.close();
    }
  });
}

test("accepted work frees slots, dependent waits for both publications and later launch includes unrelated delivery", async () => {
  const adapter = new HeldIntegration();
  const f = await fixture(adapter);
  try {
    const graph = f.app.engine!.createGraph({ name: "queue", concurrency: 3, tasks: [
      { id: "D", title: "unrelated", goal: "d", deps: [], taskTypeId: "direct" },
      { id: "B", title: "first", goal: "b", deps: [], taskTypeId: "direct" },
      { id: "C", title: "second", goal: "c", deps: [], taskTypeId: "direct" },
      { id: "A", title: "dependent", goal: "a", deps: ["B", "C"], taskTypeId: "direct" },
    ] });
    await f.app.engine!.runGraph(graph.id);
    await waitFor(() => f.runtime.turns.length === 3, "parallel tasks");
    const initial = graph.integration!.headSha;
    for (let i = 0; i < 3; i++) {
      const id = graph.tasks.find((t) => t.workspace?.path === f.runtime.turns[i].input.cwd)!.id;
      await writeFile(join(f.runtime.turns[i].input.cwd, `${id}.txt`), id);
    }
    const finish = async (id: string) => {
      const index = f.runtime.turns.findIndex((turn) => turn.input.cwd === graph.tasks.find((t) => t.id === id)!.workspace?.path);
      await f.report(index, "ready"); f.runtime.turns[index].finish();
    };
    await finish("D");
    await waitFor(() => adapter.entered, "candidate validation");
    assert.equal(f.app.engine!.busy, true);
    await finish("B"); await finish("C");
    await waitFor(() => graph.tasks.filter((t) => t.status === "merge_queued").length === 2, "queued accepted work");
    assert.equal(graph.tasks.find((t) => t.id === "A")!.status, "waiting");
    assert.equal(graph.integration!.headSha, initial);
    const appended = f.app.engine!.appendTask(graph.id, { id: "E", title: "appended", goal: "e", deps: [], taskTypeId: "direct" });
    assert.deepEqual(appended.appendBarrier?.sort(), ["B", "C", "D"]);
    for (let i = 0; i < 3; i++) {
      adapter.entered = false; adapter.release!();
      if (i < 2) await waitFor(() => adapter.entered, "next serial candidate");
    }
    await waitFor(() => f.runtime.turns.length === 5, "downstream and append launch");
    const a = graph.tasks.find((t) => t.id === "A")!;
    for (const id of ["B", "C", "D"]) assert.equal(await readFile(join(a.workspace!.path, `${id}.txt`), "utf8"), id);
    for (const id of ["B", "C", "D"]) assert.equal(graph.tasks.find((t) => t.id === id)!.startCommit, initial);
    assert.equal(a.startCommit, graph.integration!.headSha);
  } finally { adapter.release?.(); await f.app.close(); }
});

test("soft pause drains active publication while queued edit supersedes source without losing history", async () => {
  const adapter = new HeldIntegration();
  const f = await fixture(adapter);
  try {
    const graph = f.app.engine!.createGraph({ name: "edit queue", tasks: [
      { id: "A", title: "a", goal: "a", deps: [], taskTypeId: "direct" },
      { id: "B", title: "b", goal: "b", deps: [], taskTypeId: "direct" },
    ] });
    await f.app.engine!.runGraph(graph.id);
    await waitFor(() => f.runtime.turns.length === 2, "workers");
    await f.report(0, "ready"); f.runtime.turns[0].finish();
    await waitFor(() => adapter.entered, "integration");
    await f.report(1, "ready"); f.runtime.turns[1].finish();
    await waitFor(() => graph.integration!.deliveries.length === 2, "second delivery queued");
    const queued = graph.integration!.deliveries[1];
    await f.app.engine!.pauseGraph(graph.id, "soft");
    assert.equal(graph.status, "pausing");
    adapter.release!();
    await waitFor(() => graph.status === "paused", "integration drain");
    assert.equal(graph.integration!.deliveries[0].state.status, "published");
    assert.equal(queued.state.status, "queued");
    const task = graph.tasks.find((t) => t.id === queued.taskId)!;
    const base = task.startCommit;
    f.app.engine!.editTask(graph.id, task.id, { goal: "new goal" });
    assert.equal(queued.state.status, "superseded");
    assert.equal(task.startCommit, base);
    assert.throws(() => f.app.engine!.editTask(graph.id, graph.integration!.deliveries[0].taskId, { goal: "no" }), /已交付/);
    await f.app.engine!.resumeGraph(graph.id);
    await waitFor(() => f.runtime.turns.length === 3, "edited work resumes");
    assert.equal(await adapter.integrationReceipt(graph.workspace!, queued.id), undefined);
    assert.equal(graph.integration!.deliveries.length, 2);
  } finally { adapter.release?.(); await f.app.close(); }
});

test("hard pause waits for integration and retry delivers accepted source without another agent turn", async () => {
  const adapter = new HeldIntegration();
  const f = await fixture(adapter);
  try {
    const graph = f.app.engine!.createGraph({ name: "hard queue", tasks: [
      { id: "A", title: "a", goal: "a", deps: [], taskTypeId: "direct" },
    ] });
    await f.app.engine!.runGraph(graph.id);
    await waitFor(() => f.runtime.turns.length === 1, "worker");
    await f.report(0, "ready"); f.runtime.turns[0].finish();
    await waitFor(() => adapter.entered, "candidate");
    const initial = graph.integration!.headSha;
    const pausing = f.app.engine!.pauseGraph(graph.id, "hard");
    assert.equal(graph.status, "pausing");
    adapter.release!(); await pausing;
    assert.equal(graph.status, "paused");
    assert.equal(graph.integration!.headSha, initial);
    assert.equal(graph.tasks[0].status, "blocked");
    assert.equal(graph.tasks[0].deliverySha, undefined);
    await f.app.engine!.resolveGraph(graph.id, "A");
    adapter.entered = false;
    await f.app.engine!.resumeGraph(graph.id);
    await waitFor(() => adapter.entered, "retry same delivery");
    adapter.release!();
    await waitFor(() => graph.status === "done", "published retry");
    assert.equal(f.runtime.turns.length, 1);
    assert.equal(graph.integration!.deliveries.length, 1);
  } finally { adapter.release?.(); await f.app.close(); }
});

test("failed integration command blocks dependents while independent delivery proceeds and resolve retries only delivery", async () => {
  const f = await fixture();
  try {
    const allow = join(f.root, ".newharness", "allow").replaceAll("\\", "/");
    const graph = f.app.engine!.createGraph({ name: "validation queue", concurrency: 2,
      integrationCommand: `node -e "if(require('fs').existsSync('A.txt')&&!require('fs').existsSync('${allow}'))process.exit(7);console.log('candidate verified')"`, tasks: [
        { id: "A", title: "a", goal: "a", deps: [], taskTypeId: "direct" },
        { id: "B", title: "b", goal: "b", deps: [], taskTypeId: "direct" },
        { id: "C", title: "c", goal: "c", deps: ["A"], taskTypeId: "direct" },
      ] });
    await f.app.engine!.runGraph(graph.id);
    await waitFor(() => f.runtime.turns.length === 2, "workers");
    const index = (id: string) => f.runtime.turns.findIndex((turn) => turn.input.cwd === graph.tasks.find((t) => t.id === id)!.workspace?.path);
    const a = index("A"), b = index("B");
    await writeFile(join(f.runtime.turns[a].input.cwd, "A.txt"), "A");
    await writeFile(join(f.runtime.turns[b].input.cwd, "B.txt"), "B");
    await f.report(a, "ready"); f.runtime.turns[a].finish();
    await waitFor(() => graph.tasks[0].status === "blocked", "failed validation");
    assert.equal(graph.integration!.headSha, graph.workspace!.baseCommit);
    assert.match(graph.tasks[0].blockReason!, /integrations/);
    await f.report(b, "ready"); f.runtime.turns[b].finish();
    await waitFor(() => graph.tasks[1].status === "done", "independent delivery");
    assert.equal(f.runtime.turns.length, 2);
    assert.equal(graph.tasks[2].status, "waiting");
    const source = graph.integration!.deliveries[0].sourceSha;
    await writeFile(allow, "allow");
    await waitFor(() => graph.status === "blocked", "graph block settlement");
    await f.app.engine!.resolveGraph(graph.id, "A");
    await waitFor(() => f.runtime.turns.length === 3, "dependent after retry");
    assert.equal(graph.tasks[0].deliverySha, source);
    assert.equal(graph.integration!.deliveries.length, 2);
    const delivered = graph.integration!.deliveries[0];
    assert.equal(delivered.state.status, "published");
    if (delivered.state.status === "published") assert.equal(delivered.state.receipt.validation.status, "passed");
    assert.equal(await readFile(join(graph.tasks[2].workspace!.path, "B.txt"), "utf8"), "B");
  } finally { await f.app.close(); }
});

test("startup pauses and reconciles a committed receipt before dispatch without republishing or rerunning work", async () => {
  const adapter = new HeldIntegration();
  const f = await fixture(adapter);
  let reopened: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  try {
    const graph = f.app.engine!.createGraph({ name: "receipt recovery", tasks: [
      { id: "A", title: "a", goal: "a", deps: [], taskTypeId: "direct" },
      { id: "B", title: "b", goal: "b", deps: ["A"], taskTypeId: "direct" },
    ] });
    await f.app.engine!.runGraph(graph.id);
    await waitFor(() => f.runtime.turns.length === 1, "worker");
    await f.report(0, "ready"); f.runtime.turns[0].finish();
    await waitFor(() => adapter.entered, "integration before publication");
    const saved = structuredClone(f.app.engine!.state);
    await f.app.engine!.pauseGraph(graph.id, "soft");
    adapter.release!();
    await waitFor(() => graph.status === "paused", "published before state recovery");
    const published = graph.integration!.headSha;
    await f.app.close();
    const { ProjectStore } = await import("../src/server/store.ts");
    const store = new ProjectStore(f.root); store.save(saved); store.close();
    const runtime = new ControlledRuntime();
    reopened = await createHttpServer({ runtime, git: new GitWorkspaces(), projectRoot: f.root, catalogPath: join(f.root, "catalog.json") });
    await new Promise<void>((resolve) => reopened!.server.listen(0, "127.0.0.1", resolve));
    const restored = reopened.engine!.graph(graph.id);
    assert.equal(restored.status, "paused");
    assert.equal(runtime.turns.length, 0);
    assert.throws(() => reopened!.engine!.editTask(graph.id, "A", { goal: "unsafe edit" }), /Reconcile/);
    await reopened.engine!.resumeGraph(graph.id);
    await waitFor(() => runtime.turns.length === 1, "dependent only");
    assert.equal(restored.tasks[0].status, "done");
    assert.equal(restored.tasks[1].startCommit, published);
    assert.equal(restored.integration!.headSha, published);
    assert.equal(restored.integration!.deliveries.length, 1);
    assert.equal(await adapter.integrationHead(restored.workspace!), published);
    await reopened.engine!.pauseGraph(graph.id, "hard");
    const refs = (await exec("git", ["for-each-ref", "--format=%(refname) %(objecttype)", "refs/newharness/ops"], { cwd: f.root })).stdout;
    const receiptRef = refs.split("\n").find((line) => line.endsWith(" blob"))!.split(" ")[0];
    await exec("git", ["update-ref", "-d", receiptRef], { cwd: f.root });
    await assert.rejects(reopened.engine!.resumeGraph(graph.id), /Published delivery receipt is missing/);
    assert.equal(runtime.turns.length, 1);
    assert.equal(restored.status, "paused");
  } finally {
    adapter.release?.();
    if (reopened) await reopened.close();
    else if (f.app.server.listening) await f.app.close();
  }
});

test("hard pause terminates the real integration validator before publishing", async () => {
  const f = await fixture();
  try {
    const graph = f.app.engine!.createGraph({ name: "validator cancellation", integrationCommand: 'node -e "setTimeout(()=>{},60000)"', tasks: [
      { id: "A", title: "a", goal: "a", deps: [], taskTypeId: "direct" },
    ] });
    await f.app.engine!.runGraph(graph.id);
    await waitFor(() => f.runtime.turns.length === 1, "worker");
    await f.report(0, "ready"); f.runtime.turns[0].finish();
    await waitFor(() => {
      const state = graph.integration!.deliveries[0]?.state;
      return state?.status === "integrating" && !!state.validatorPid;
    }, "validator process");
    await f.app.engine!.pauseGraph(graph.id, "hard");
    assert.equal(graph.status, "paused");
    assert.equal(graph.integration!.headSha, graph.workspace!.baseCommit);
    assert.equal(graph.integration!.deliveries[0].state.status, "blocked");
    assert.equal(await f.app.engine!.git.integrationReceipt(graph.workspace!, graph.integration!.deliveries[0].id), undefined);
  } finally { await f.app.close(); }
});

test("report receipt does not dispatch review before turn end; review gates DAG and resumes the original sessions", async () => {
  const f = await fixture();
  try {
    const base = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })
    ).stdout.trim();
    const created = await f.request("/api/graphs", {
      name: "Review graph",
      tasks: [
        {
          id: "A",
          title: "A",
          goal: "Implement feature",
          deps: [],
          taskTypeId: "reviewed",
        },
        {
          id: "B",
          title: "B",
          goal: "Use feature",
          deps: ["A"],
          taskTypeId: "direct",
        },
      ],
    });
    assert.equal(created.status, 201);
    const graph = f.app.engine!.graph(created.data.id);
    await f.request(`/api/graphs/${graph.id}/run`, {});
    await waitFor(() => f.runtime.turns.length === 1, "worker start");
    await writeFile(join(f.runtime.turns[0].input.cwd, "feature.txt"), "v1");
    const receipt = await f.report(0, "ready");
    assert.equal(f.runtime.turns.length, 1);
    assert.equal(graph.tasks[0].status, "running");
    const duplicate = await f.request(
      "/api/unit/report",
      { outcome: "ready", report: receipt.path },
      f.runtime.turns[0].input.env!.HARNESS_TOKEN,
    );
    assert.equal(duplicate.data.id, receipt.data.id);
    f.runtime.turns[0].finish();
    await waitFor(() => f.runtime.turns.length === 2, "review start");
    assert.equal(f.runtime.turns[1].input.readOnly, true);
    await f.report(1, "changes_requested");
    f.runtime.turns[1].finish();
    await waitFor(() => f.runtime.turns.length === 3, "repair start");
    assert.equal(f.runtime.turns[2].input.threadId, "thread-1");
    await writeFile(join(f.runtime.turns[2].input.cwd, "feature.txt"), "v2");
    await f.report(2, "ready");
    f.runtime.turns[2].finish();
    await waitFor(() => f.runtime.turns.length === 4, "second review");
    assert.equal(f.runtime.turns[3].input.threadId, "thread-2");
    await f.report(3, "approved");
    f.runtime.turns[3].finish();
    await waitFor(() => f.runtime.turns.length === 5, "dependent start");
    assert.equal(graph.tasks[0].status, "done");
    assert.equal(
      await readFile(join(f.runtime.turns[4].input.cwd, "feature.txt"), "utf8"),
      "v2",
    );
    await f.report(4, "ready");
    f.runtime.turns[4].finish();
    await waitFor(() => graph.status === "done", "graph completion");
    assert.equal(
      (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim(),
      base,
    );
    const stale = await f.request(
      "/api/unit/report",
      { outcome: "ready", report: receipt.path },
      f.runtime.turns[0].input.env!.HARNESS_TOKEN,
    );
    assert.equal(stale.status, 400);
    assert(
      !JSON.stringify((await f.request("/api/state")).data).includes(
        "tokenHash",
      ),
    );
  } finally {
    await f.app.close();
  }
});

test("soft pause drains execution, holds review and mail; hard pause interrupts and resumes original thread", async () => {
  const f = await fixture();
  try {
    const created = await f.request("/api/graphs", {
      name: "Pause",
      tasks: [
        { id: "A", title: "A", goal: "goal", deps: [], taskTypeId: "reviewed" },
      ],
    });
    const graph = f.app.engine!.graph(created.data.id);
    await f.request(`/api/graphs/${graph.id}/run`, {});
    await waitFor(() => f.runtime.turns.length === 1, "first worker");
    await f.request(`/api/graphs/${graph.id}/pause`, { mode: "soft" });
    assert.equal(graph.status, "pausing");
    const blockedEdit = await f.request(
      `/api/graphs/${graph.id}/tasks/A`,
      { goal: "changed" },
      undefined,
      "PATCH",
    );
    assert.equal(blockedEdit.status, 400);
    await f.report(0, "ready");
    f.runtime.turns[0].finish();
    await waitFor(() => graph.status === "paused", "pause drain");
    assert.equal(f.runtime.turns.length, 1);
    const letter = join(f.root, "letter.md");
    await writeFile(letter, "Please check the edge case");
    const free = (await f.request("/api/sessions", { title: "Controller" }))
      .data;
    await f.request("/api/letters", {
      graphId: graph.id,
      from: `session/${free.id}`,
      to: [`${graph.id}/A/reviewer`],
      title: "Check",
      path: letter,
    });
    assert.equal(f.runtime.turns.length, 1);
    await f.request(`/api/graphs/${graph.id}/resume`, {});
    await waitFor(() => f.runtime.turns.length === 2, "review after resume");
    assert.match(f.runtime.turns[1].input.prompt, /Please check the edge case/);
    await f.request(`/api/graphs/${graph.id}/pause`, { mode: "hard" });
    assert.equal(graph.status, "paused");
    assert.equal(f.runtime.turns.length, 2);
    await f.request(`/api/graphs/${graph.id}/resume`, {});
    await waitFor(
      () => f.runtime.turns.length === 3,
      "interrupted review resumed",
    );
    assert.equal(f.runtime.turns[2].input.threadId, "thread-2");
    await f.report(2, "approved");
    f.runtime.turns[2].finish();
    await waitFor(() => graph.status === "done", "done");
  } finally {
    await f.app.close();
  }
});

test("missing reports use a bounded original-session repair; invalid DAG and cross-project report paths are rejected", async () => {
  const f = await fixture();
  try {
    const invalid = await f.request("/api/graphs", {
      name: "cycle",
      tasks: [
        { id: "A", title: "A", goal: "g", deps: ["A"], taskTypeId: "direct" },
      ],
    });
    assert.equal(invalid.status, 400);
    const created = await f.request("/api/graphs", {
      name: "Missing",
      tasks: [
        { id: "A", title: "A", goal: "g", deps: [], taskTypeId: "direct" },
      ],
    });
    const graph = f.app.engine!.graph(created.data.id);
    await f.request(`/api/graphs/${graph.id}/run`, {});
    await waitFor(() => f.runtime.turns.length === 1, "start");
    await writeFile(join(f.root, "outside.md"), "not in task workspace");
    const outside = await f.request(
      "/api/unit/report",
      { outcome: "ready", report: join(f.root, "outside.md") },
      f.runtime.turns[0].input.env!.HARNESS_TOKEN,
    );
    assert.equal(outside.status, 400);
    f.runtime.turns[0].finish();
    await waitFor(() => f.runtime.turns.length === 2, "repair");
    assert.match(f.runtime.turns[1].input.prompt, /不要重复完成工作/);
    assert.equal(f.runtime.turns[1].input.threadId, "thread-1");
    f.runtime.turns[1].finish();
    await waitFor(() => f.runtime.turns.length === 3, "last repair");
    f.runtime.turns[2].finish();
    await waitFor(() => graph.status === "blocked", "bounded block");
    assert.equal(f.runtime.turns.length, 3);
  } finally {
    await f.app.close();
  }
});

test("completed task mailbox delivers once read-only and does not reopen delivery", async () => {
  const f = await fixture();
  try {
    const created = await f.request("/api/graphs", {
      name: "Mail",
      tasks: [
        { id: "A", title: "A", goal: "g", deps: [], taskTypeId: "direct" },
      ],
    });
    const graph = f.app.engine!.graph(created.data.id);
    await f.request(`/api/graphs/${graph.id}/run`, {});
    await waitFor(() => f.runtime.turns.length === 1, "work");
    await f.report(0, "ready");
    f.runtime.turns[0].finish();
    await waitFor(() => graph.status === "done", "delivery");
    const sha = graph.tasks[0].deliverySha;
    const free = (await f.request("/api/sessions", { title: "Controller" }))
      .data;
    const file = join(f.root, "question.md");
    await writeFile(file, "Explain the result");
    const sent = await f.request("/api/letters", {
      graphId: graph.id,
      from: `session/${free.id}`,
      to: [`${graph.id}/A/worker`],
      title: "Question",
      path: file,
    });
    assert.equal(sent.status, 201);
    await waitFor(() => f.runtime.turns.length === 2, "reply");
    assert.equal(f.runtime.turns[1].input.readOnly, true);
    assert.match(f.runtime.turns[1].input.prompt, /Explain the result/);
    assert.equal(f.runtime.turns[1].input.env?.HARNESS_TOKEN, undefined);
    f.runtime.turns[1].finish();
    await waitFor(() => !f.app.engine!.busy, "reply finish");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(f.runtime.turns.length, 2);
    assert.equal(graph.status, "done");
    assert.equal(graph.tasks[0].deliverySha, sha);
    assert.equal(
      f.app.engine!.state.letters[0].deliveries[0].status,
      "injected",
    );
  } finally {
    await f.app.close();
  }
});

test("runtime live steering and followup have separate boundaries; append barriers wait for the active task set", async () => {
  const f = await fixture();
  try {
    const created = await f.request("/api/graphs", {
      name: "Barrier",
      concurrency: 2,
      tasks: [
        { id: "A", title: "A", goal: "g", deps: [], taskTypeId: "direct" },
      ],
    });
    const graph = f.app.engine!.graph(created.data.id);
    await f.request(`/api/graphs/${graph.id}/run`, {});
    await waitFor(() => f.runtime.turns.length === 1, "A");
    const added = await f.request(`/api/graphs/${graph.id}/tasks`, {
      id: "B",
      title: "B",
      goal: "g",
      deps: [],
      taskTypeId: "direct",
    });
    assert.equal(added.data.status, "queued");
    assert.deepEqual(added.data.appendBarrier, ["A"]);
    const free = (await f.request("/api/sessions", { title: "Controller" }))
      .data;
    const file = join(f.root, "question.md");
    await writeFile(file, "live question");
    const letter = {
      graphId: graph.id,
      from: `session/${free.id}`,
      to: [`${graph.id}/A/worker`],
      title: "Question",
      path: file,
    };
    await f.request("/api/letters", { ...letter, mode: "steer" });
    await waitFor(() => f.runtime.turns[0].injected.length === 1, "steer");
    assert.match(f.runtime.turns[0].injected[0], /live question/);
    await f.request("/api/letters", { ...letter, mode: "followup" });
    assert.equal(f.runtime.turns[0].injected.length, 1);
    await f.report(0, "ready");
    f.runtime.turns[0].finish();
    await waitFor(() => f.runtime.turns.length >= 2, "after A");
    await waitFor(() => graph.tasks[1].status === "running", "B runs");
    assert.equal(graph.tasks[0].status, "done");
    for (let i = 1; i < f.runtime.turns.length; i++) {
      if (f.runtime.turns[i].input.env?.HARNESS_TOKEN)
        await f.report(i, "ready");
      f.runtime.turns[i].finish();
    }
    await waitFor(() => graph.status === "done", "graph done");
  } finally {
    await f.app.close();
  }
});

test("public CLI reports with launcher identity and persists a fixed copy independent of later file edits", async () => {
  const f = await fixture();
  try {
    const created = await f.request("/api/graphs", {
      name: "CLI",
      tasks: [
        { id: "A", title: "A", goal: "g", deps: [], taskTypeId: "direct" },
      ],
    });
    const graph = f.app.engine!.graph(created.data.id);
    await f.request(`/api/graphs/${graph.id}/run`, {});
    await waitFor(() => f.runtime.turns.length === 1, "start");
    const path = join(f.runtime.turns[0].input.cwd, "report.md");
    await writeFile(path, "immutable proof");
    const cli = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "unit",
        "report",
        "--outcome",
        "ready",
        "--report",
        path,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...f.runtime.turns[0].input.env },
      },
    );
    const receipt = JSON.parse(cli.stdout);
    assert.equal(receipt.content, "immutable proof");
    await writeFile(path, "changed later");
    assert.equal(
      (await f.request("/api/reports/" + receipt.id)).data.content,
      "immutable proof",
    );
    f.runtime.turns[0].finish();
    await waitFor(() => graph.status === "done", "done");
  } finally {
    await f.app.close();
  }
});

test("recovering an interrupted completed-task reply preserves delivery and paused letters drain on resume", async () => {
  const f = await fixture();
  let reopened: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  try {
    const created = await f.request("/api/graphs", {
      name: "Recovery",
      tasks: [
        { id: "A", title: "A", goal: "g", deps: [], taskTypeId: "direct" },
      ],
    });
    const graph = f.app.engine!.graph(created.data.id);
    await f.request(`/api/graphs/${graph.id}/run`, {});
    await waitFor(() => f.runtime.turns.length === 1, "work");
    await f.report(0, "ready");
    f.runtime.turns[0].finish();
    await waitFor(() => graph.status === "done", "delivery");
    const state = structuredClone(f.app.engine!.state),
      task = state.graphs[0].tasks[0],
      unit = task.units[0],
      session = state.sessions.find((s) => s.id === unit.sessionId)!;
    session.status = "running";
    state.executions.push({
      id: "crashed-mail",
      sessionId: session.id,
      graphId: graph.id,
      taskId: task.id,
      unitId: unit.id,
      purpose: "mail",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    await f.app.close();
    const { ProjectStore } = await import("../src/server/store.ts");
    const store = new ProjectStore(f.root);
    store.save(state);
    store.close();
    reopened = await createHttpServer({
      runtime: new ControlledRuntime(),
      git: new GitWorkspaces(),
      projectRoot: f.root,
      catalogPath: join(f.root, "catalog.json"),
    });
    await new Promise<void>((r) => reopened!.server.listen(0, "127.0.0.1", r));
    const address = reopened.server.address();
    assert(address && typeof address !== "string");
    const after = (await (
      await fetch(`http://127.0.0.1:${address.port}/api/state`)
    ).json()) as AppState;
    assert.equal(after.graphs[0].status, "done");
    assert.equal(after.graphs[0].tasks[0].status, "done");
    assert.equal(after.graphs[0].tasks[0].deliverySha, task.deliverySha);
    assert.equal(
      after.sessions.find((s) => s.id === session.id)!.status,
      "interrupted",
    );
  } finally {
    if (reopened) await reopened.close();
    else if (f.app.server.listening) await f.app.close();
  }
});

test("paused controller letters drain on resume and a startup steer reaches the eventual handle", async () => {
  const f = await fixture();
  try {
    const created = await f.request("/api/graphs", {
      name: "Queued delivery",
      tasks: [
        { id: "A", title: "A", goal: "g", deps: [], taskTypeId: "direct" },
      ],
    });
    const graph = f.app.engine!.graph(created.data.id),
      free = (await f.request("/api/sessions", { title: "Controller" })).data;
    let release!: () => void;
    const waiting = new Promise<void>((r) => (release = r)),
      original = f.runtime.start.bind(f.runtime);
    f.runtime.start = async (input, emit) => {
      await waiting;
      return original(input, emit);
    };
    await f.request(`/api/graphs/${graph.id}/run`, {});
    await waitFor(
      () => !!graph.tasks[0].units[0].sessionId,
      "execution intent",
    );
    const file = join(f.root, "question.md");
    await writeFile(file, "startup steer");
    await f.request("/api/letters", {
      graphId: graph.id,
      from: `session/${free.id}`,
      to: [`${graph.id}/A/worker`],
      title: "During startup",
      path: file,
      mode: "steer",
    });
    release();
    await waitFor(
      () => f.runtime.turns[0]?.injected.length === 1,
      "startup injection",
    );
    await f.request(`/api/graphs/${graph.id}/pause`, { mode: "hard" });
    const paused = await f.request("/api/letters", {
      graphId: graph.id,
      from: `${graph.id}/A/worker`,
      to: [`session/${free.id}`],
      title: "Paused message",
      path: file,
    });
    assert.equal(paused.data.deliveries[0].status, "queued");
    const before = f.runtime.turns.length;
    await f.request(`/api/graphs/${graph.id}/resume`, {});
    await waitFor(
      () => f.runtime.turns.length >= before + 1,
      "controller wake",
    );
    assert(
      f.runtime.turns.some((t) => t.input.prompt.includes("Paused message")),
    );
  } finally {
    await f.app.close();
  }
});

test("command units run without model calls, bind their output and complete a real Git graph", async () => {
  const f = await fixture();
  try {
    const type = {
      id: "script",
      name: "Script",
      version: 1,
      units: [
        {
          id: "check",
          name: "check",
          kind: "command",
          skills: [],
          prompt: "",
          readOnly: false,
          command:
            "node -e \"require('fs').writeFileSync('command-result.txt','ok');console.log('verified by command')\"",
        },
      ],
      start: ["check"],
      rules: [{ from: "check", outcome: "ready", action: { type: "finish" } }],
      maxRounds: 1,
      maxReportRetries: 0,
    };
    const saved = await f.request("/api/catalog/task-types", type);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const created = await f.request("/api/graphs", {
      name: "Command",
      tasks: [
        {
          id: "A",
          title: "A",
          goal: "run script",
          deps: [],
          taskTypeId: "script",
        },
      ],
    });
    const graph = f.app.engine!.graph(created.data.id);
    await f.request(`/api/graphs/${graph.id}/run`, {});
    await waitFor(
      () => graph.status === "done" || graph.status === "blocked",
      "command graph",
    );
    assert.equal(graph.status, "done", graph.tasks[0].blockReason);
    assert.equal(f.runtime.turns.length, 0);
    assert.match(graph.tasks[0].submissions[0].content, /verified by command/);
    assert.equal(
      await readFile(join(graph.workspace!.path, "command-result.txt"), "utf8"),
      "ok",
    );
    const file = join(f.root, "command-mail.md");
    await writeFile(file, "do not rerun");
    const sender = (await f.request("/api/sessions", { title: "Control" }))
      .data;
    const rejected = await f.request("/api/letters", {
      graphId: graph.id,
      from: `session/${sender.id}`,
      to: [`${graph.id}/A/check`],
      title: "No rerun",
      path: file,
    });
    assert.equal(rejected.status, 400);
  } finally {
    await f.app.close();
  }
});

test("blocked subscription wakes the controller once without unblocking the task", async () => {
  const f = await fixture();
  try {
    const free = (await f.request("/api/sessions", { title: "Controller" }))
      .data;
    const created = await f.request("/api/graphs", {
      name: "Subscription",
      tasks: [
        { id: "A", title: "A", goal: "g", deps: [], taskTypeId: "direct" },
      ],
    });
    const graph = f.app.engine!.graph(created.data.id);
    await f.request(
      `/api/graphs/${graph.id}`,
      { subscription: "blocked", controllerSessionId: free.id },
      undefined,
      "PATCH",
    );
    await f.request(`/api/graphs/${graph.id}/run`, {});
    await waitFor(() => f.runtime.turns.length === 1, "worker");
    await f.report(0, "blocked");
    f.runtime.turns[0].finish();
    await waitFor(() => f.runtime.turns.length === 2, "controller");
    assert.match(f.runtime.turns[1].input.prompt, /Task A 阻塞/);
    assert.equal(f.runtime.turns[1].input.readOnly, true);
    f.runtime.turns[1].finish();
    await waitFor(() => !f.app.engine!.busy, "settled");
    assert.equal(graph.tasks[0].status, "blocked");
    assert.equal(f.app.engine!.state.letters.length, 1);
    assert.equal(f.runtime.turns.length, 2);
  } finally {
    await f.app.close();
  }
});
