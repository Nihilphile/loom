import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessEngine } from "../src/server/engine.ts";
import { Catalog } from "../src/server/catalog.ts";
import { SessionInputs, contextItem } from "../src/server/session-inputs.ts";
import type {
  GitAdapter,
  Runtime,
  RuntimeAcceptance,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeInput,
  RuntimeResult,
} from "../src/shared/types.ts";

class ManualRuntime implements Runtime {
  name = "manual";
  discoverOptions?: Runtime["discoverOptions"];
  capabilities = { inject: true, interrupt: true, readOnly: true, fork: true };
  turns: {
    input: RuntimeInput;
    accept: (value: RuntimeAcceptance) => void;
    finish: (value?: Partial<RuntimeResult>) => void;
    emit: (event: RuntimeEvent) => void;
  }[] = [];
  async start(
    input: RuntimeInput,
    emit: (event: RuntimeEvent) => void,
  ): Promise<RuntimeHandle> {
    let accept!: (value: RuntimeAcceptance) => void;
    let finish!: (value?: Partial<RuntimeResult>) => void;
    const index = this.turns.length;
    const accepted = new Promise<RuntimeAcceptance>((resolve) => {
      accept = resolve;
    });
    const done = new Promise<RuntimeResult>((resolve) => {
      finish = (value) =>
        resolve({
          status: "completed",
          text: "answer",
          threadId: `thread-${index}`,
          completedTurnId: `turn-${index}`,
          ...value,
        });
    });
    this.turns.push({ input, accept, finish, emit });
    return {
      accepted,
      done,
      inject: async () => true,
      interrupt: async () => {
        accept({ status: "rejected", reason: "interrupted before acceptance" });
        finish({ status: "interrupted", completedTurnId: undefined });
      },
    };
  }
  confirm(index: number) {
    this.turns[index].accept({
      status: "accepted",
      threadId: this.turns[index].input.threadId ?? `thread-${index}`,
      turnId: `turn-${index}`,
    });
  }
}
async function flush() {
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setImmediate(resolve));
}
function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "loom-preparation-"));
  const runtime = new ManualRuntime();
  const git: GitAdapter = {
    createGraph: async () => ({
      path: root,
      branch: "graph",
      baseCommit: "base",
    }),
    createTask: async (_, id) => {
      const path = join(root, id);
      mkdirSync(path, { recursive: true });
      return { path, branch: id, baseCommit: "base" };
    },
    snapshot: async () => "snapshot",
    mergeFinal: async () => "final",
  };
  const catalog = new Catalog(join(root, "catalog.json"));
  const engine = new HarnessEngine(root, runtime, git, catalog);
  t.after(async () => {
    await engine.shutdown();
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, runtime, engine, catalog };
}
function submit(
  f: ReturnType<typeof fixture>,
  index: number,
  outcome: "ready" | "approved" | "changes_requested",
  content: string,
) {
  const input = f.runtime.turns[index].input;
  const path = join(input.cwd, `report-${index}.md`);
  writeFileSync(path, content);
  f.engine.submit(input.env!.HARNESS_TOKEN, { outcome, report: path });
}

test("initialization requires acceptance and reviewer return injects only incremental materials", async (t) => {
  const f = fixture(t);
  const graph = f.engine.createGraph({
    name: "review",
    tasks: [
      { title: "task", goal: "UNIQUE_GOAL", deps: [], taskTypeId: "reviewed" },
    ],
  });
  await f.engine.runGraph(graph.id);
  await flush();
  const worker = f.engine.session(graph.tasks[0].units[0].sessionId!);
  assert.equal(worker.acceptedConfig, undefined);
  f.runtime.turns[0].emit({ type: "thread.started", threadId: "provisional" });
  assert.equal(worker.acceptedConfig, undefined);
  assert.match(f.runtime.turns[0].input.prompt, /UNIQUE_GOAL/);
  f.runtime.confirm(0);
  await flush();
  assert.equal(f.engine.session(worker.id).acceptedConfig?.readOnly, false);
  submit(f, 0, "ready", "IMPLEMENTATION_REPORT");
  f.runtime.turns[0].finish();
  await flush();
  assert.equal(f.runtime.turns.length, 2);
  assert.match(f.runtime.turns[1].input.prompt, /IMPLEMENTATION_REPORT/);
  f.runtime.confirm(1);
  await flush();
  submit(f, 1, "changes_requested", "REVIEW_RETURN");
  f.runtime.turns[1].finish();
  await flush();
  assert.equal(f.runtime.turns.length, 3);
  assert.equal(f.runtime.turns[2].input.threadId, worker.threadId);
  assert.match(f.runtime.turns[2].input.prompt, /REVIEW_RETURN/);
  assert.doesNotMatch(
    f.runtime.turns[2].input.prompt,
    /UNIQUE_GOAL|你是 Task|完成后先写报告/,
  );
  assert.equal(f.engine.state.preparations.at(-1)?.mode, "continue");
  assert.equal(f.runtime.turns[2].input.readOnly, false);
  assert(f.runtime.turns[2].input.env?.HARNESS_TOKEN);
});

test("queued letters are reserved before acceptance and accepted failures never replay them", async (t) => {
  const f = fixture(t);
  const graph = f.engine.createGraph({
    name: "letters",
    tasks: [{ title: "task", goal: "goal", deps: [], taskTypeId: "direct" }],
  });
  const path = join(f.root, "letter.md");
  writeFileSync(path, "LETTER_BODY");
  const letter = f.engine.sendLetter({
    graphId: graph.id,
    from: `session/${f.engine.createSession({ title: "controller" }).id}`,
    to: [`${graph.id}/${graph.tasks[0].id}/worker`],
    title: "letter",
    path,
  });
  await f.engine.runGraph(graph.id);
  await flush();
  assert.equal(letter.deliveries[0].status, "queued");
  assert.match(f.runtime.turns[0].input.prompt, /LETTER_BODY/);
  f.runtime.confirm(0);
  await flush();
  assert.equal(letter.deliveries[0].status, "injected");
  f.runtime.turns[0].finish({
    status: "failed",
    error: "after accept",
    completedTurnId: undefined,
  });
  await flush();
  assert.equal(letter.deliveries[0].status, "injected");
  assert.equal(f.engine.state.preparations[0].receipt.status, "accepted");
});

test("uncertain initialization blocks automatic replay and explicit reconciliation preserves source receipts", async (t) => {
  const f = fixture(t),
    session = f.engine.createSession({ title: "uncertain" });
  await f.engine.sendMessage(session.id, "first");
  await flush();
  f.runtime.turns[0].accept({ status: "uncertain", reason: "transport lost" });
  f.runtime.turns[0].finish({ status: "failed", completedTurnId: undefined });
  await flush();
  assert.equal(session.acceptedConfig, undefined);
  await f.engine.sendMessage(session.id, "second");
  await flush();
  assert.equal(f.runtime.turns.length, 1);
  const uncertain = f.engine.state.preparations[0];
  assert.match(session.error!, /未知/);
  f.engine.resolvePreparation(session.id, uncertain.id, { accepted: false });
  await f.engine.sendMessage(session.id, "third");
  await flush();
  assert.equal(f.runtime.turns.length, 2);
  assert.equal(f.engine.state.preparations.at(-1)?.mode, "initialize");
});

test("sidechat forks the completed boundary while source runs, with independent context, permissions and usage", async (t) => {
  const f = fixture(t),
    source = f.engine.createSession({ title: "source" });
  assert.throws(() => f.engine.createSidechat(source.id), /已完成/);
  await f.engine.sendMessage(source.id, "source first");
  f.runtime.confirm(0);
  f.runtime.turns[0].finish();
  await flush();
  await f.engine.sendMessage(source.id, "source active");
  f.runtime.confirm(1);
  await flush();
  const messages = structuredClone(source.messages),
    metrics = structuredClone(source.metrics);
  const side = f.engine.createSidechat(source.id);
  await f.engine.sendMessage(side.id, "explain code");
  await flush();
  assert.deepEqual(f.runtime.turns[2].input.fork, {
    threadId: "thread-0",
    turnId: "turn-0",
  });
  assert.equal(f.runtime.turns[2].input.observer, true);
  assert.equal(f.runtime.turns[2].input.readOnly, true);
  assert.deepEqual(f.runtime.turns[2].input.env, {});
  assert.equal(f.engine.state.executions.at(-1)?.graphId, undefined);
  f.runtime.confirm(2);
  f.runtime.turns[2].finish({
    usage: { inputTokens: 20, cachedInputTokens: 10, outputTokens: 2 },
  });
  await flush();
  assert.deepEqual(source.messages, messages);
  assert.deepEqual(source.metrics, metrics);
  assert.equal(source.status, "running");
  assert.equal(side.metrics.usage.inputTokens, 20);
  await f.engine.sendMessage(side.id, "followup");
  await flush();
  assert.equal(f.runtime.turns[3].input.fork, undefined);
  assert.equal(f.runtime.turns[3].input.threadId, side.threadId);
  assert.equal(f.runtime.turns[3].input.observer, true);
  assert.throws(() => f.engine.createSidechat(side.id), /递归/);
  await f.engine.sendMessage(side.id, {
    text: "queued followup",
    mode: "queue",
  });
  await f.engine.interrupt(side.id);
  assert.equal(side.queuePaused, true);
  f.engine.continueQueue(side.id);
  await flush();
  assert.equal(f.runtime.turns.length, 5);
  assert.match(f.runtime.turns[4].input.prompt, /queued followup/);
  assert.equal(f.runtime.turns[4].input.observer, true);
});

test("developer interviews default off, trigger once, and save independent raw feedback", async (t) => {
  const f = fixture(t);
  assert.equal(f.engine.state.interviews.enabled, false);
  f.engine.updateInterviews({
    ...f.engine.state.interviews,
    enabled: true,
    prompt: "INTERVIEW_ONLY",
  });
  const graph = f.engine.createGraph({
    name: "interview",
    tasks: [{ title: "task", goal: "goal", deps: [], taskTypeId: "direct" }],
  });
  await f.engine.runGraph(graph.id);
  await flush();
  f.runtime.confirm(0);
  await flush();
  const source = f.engine.session(graph.tasks[0].units[0].sessionId!);
  submit(f, 0, "ready", "delivered");
  f.runtime.turns[0].finish();
  await flush();
  assert.equal(graph.tasks[0].status, "done");
  assert.equal(f.engine.state.feedback.length, 1);
  const feedback = f.engine.state.feedback[0];
  assert.equal(feedback.trigger, "completed");
  assert.match(f.runtime.turns[1].input.prompt, /INTERVIEW_ONLY/);
  assert.equal(f.runtime.turns[1].input.observer, true);
  assert(!source.messages.some((m) => m.text.includes("INTERVIEW_ONLY")));
  f.runtime.confirm(1);
  f.runtime.turns[1].finish({ text: "RAW_FRICTION" });
  await flush();
  assert.equal(feedback.content, "RAW_FRICTION");
  assert.equal(feedback.status, "completed");
  assert.equal(f.engine.state.feedback.length, 1);
  assert.equal(graph.tasks[0].status, "done");
  const key = feedback.eventKey.slice(0, -source.id.length - 1);
  assert.equal(
    (await f.engine.interview(source.id, "completed", key)).id,
    feedback.id,
  );
  assert.equal(f.runtime.turns.length, 2);
});

test("soft pause cancels unaccepted initialization and a paused goal edit reaches the resumed unit", async (t) => {
  const f = fixture(t);
  const graph = f.engine.createGraph({
    name: "pause",
    tasks: [
      { title: "task", goal: "OLD_GOAL", deps: [], taskTypeId: "direct" },
    ],
  });
  await f.engine.runGraph(graph.id);
  await flush();
  await f.engine.pauseGraph(graph.id, "soft");
  assert.equal(graph.status, "paused");
  assert.equal(f.engine.state.preparations[0].receipt.status, "rejected");
  f.engine.editTask(graph.id, graph.tasks[0].id, { goal: "NEW_GOAL" });
  f.engine.resumeGraph(graph.id);
  await flush();
  assert.equal(f.engine.state.preparations.at(-1)?.mode, "initialize");
  assert.match(f.runtime.turns[1].input.prompt, /NEW_GOAL/);
  assert.doesNotMatch(f.runtime.turns[1].input.prompt, /OLD_GOAL/);
  f.runtime.confirm(1);
  await flush();
  submit(f, 1, "ready", "done");
  f.runtime.turns[1].finish();
  await flush();
  assert.equal(f.engine.state.feedback.length, 0);
});

test("blocked interview without a completed source is visible and cannot resume the task", async (t) => {
  const f = fixture(t);
  f.engine.updateInterviews({ ...f.engine.state.interviews, enabled: true });
  const graph = f.engine.createGraph({
    name: "failed",
    tasks: [{ title: "task", goal: "goal", deps: [], taskTypeId: "direct" }],
  });
  await f.engine.runGraph(graph.id);
  await flush();
  f.runtime.turns[0].accept({ status: "rejected", reason: "native rejection" });
  f.runtime.turns[0].finish({
    status: "failed",
    error: "native rejection",
    completedTurnId: undefined,
  });
  await flush();
  assert.equal(graph.tasks[0].status, "blocked");
  assert.equal(f.engine.state.feedback.length, 1);
  assert.equal(f.engine.state.feedback[0].status, "failed");
  assert.match(f.engine.state.feedback[0].error!, /已完成/);
  assert.equal(f.runtime.turns.length, 1);
});

test("context returning to an earlier value is injected after the latest accepted version", async (t) => {
  const f = fixture(t),
    session = f.engine.createSession({ title: "versions" });
  const inputs = new SessionInputs(f.engine.state);
  const config = { revision: 1, readOnly: false, cwd: f.root, skills: [] };
  for (const [index, content] of ["A", "B", "A"].entries()) {
    const preparation = inputs.prepare(
      session,
      `execution-${index}`,
      config,
      [contextItem("file/context", "file", content)],
      "continue",
    );
    assert.equal(preparation.inputs[0]?.content, content);
    inputs.accept(session, preparation, {
      status: "accepted",
      threadId: "same",
      turnId: `turn-${index}`,
    });
  }
  assert.equal(
    inputs.prepare(
      session,
      "fourth",
      config,
      [contextItem("file/context", "file", "A")],
      "continue",
    ).inputs.length,
    0,
  );
});

test("explicit interview model uses its own default effort and never inherits incompatible source effort", async (t) => {
  const f = fixture(t),
    source = f.engine.createSession({
      title: "source",
      model: "model-a",
      reasoning: "high",
    });
  await f.engine.sendMessage(source.id, "first");
  f.runtime.confirm(0);
  f.runtime.turns[0].finish();
  await flush();
  f.runtime.discoverOptions = async () => ({
    models: [
      { id: "model-b", name: "B", reasoning: ["low"], defaultReasoning: "low" },
    ],
    skills: [],
    warnings: [],
  });
  f.engine.updateInterviews({ ...f.engine.state.interviews, model: "model-b" });
  await f.engine.interview(source.id);
  await flush();
  assert.equal(f.runtime.turns[1].input.model, "model-b");
  assert.equal(f.runtime.turns[1].input.reasoning, "low");
});

test("accepted runtime model is reapplied on continuation and template references are frozen", async (t) => {
  const f = fixture(t),
    source = f.engine.createSession({ title: "default model" });
  await f.engine.sendMessage(source.id, "first");
  f.runtime.turns[0].emit({
    type: "thread.started",
    threadId: "thread-0",
    model: "resolved-default",
  });
  f.runtime.confirm(0);
  f.runtime.turns[0].finish();
  await flush();
  assert.equal(source.acceptedConfig?.model, "resolved-default");
  await f.engine.sendMessage(source.id, "second");
  await flush();
  assert.equal(f.runtime.turns[1].input.model, "resolved-default");
  source.acceptedConfig!.reasoning = "low";
  const sidechat = f.engine.createSidechat(source.id);
  await f.engine.sendMessage(sidechat.id, "independent question");
  await f.engine.interview(source.id);
  await flush();
  assert.equal(f.runtime.turns[2].input.model, "resolved-default");
  assert.equal(f.runtime.turns[2].input.reasoning, "low");
  assert.equal(f.runtime.turns[3].input.model, "resolved-default");
  assert.equal(f.runtime.turns[3].input.reasoning, "low");
  const template = f.catalog.agents.find((a) => a.id === "worker")!;
  template.skills = ["original-skill"];
  const graph = f.engine.createGraph({
    name: "frozen",
    tasks: [{ title: "task", goal: "goal", deps: [], taskTypeId: "direct" }],
  });
  template.skills.push("later-skill");
  assert.deepEqual(graph.tasks[0].units[0].skills, ["original-skill"]);
});
