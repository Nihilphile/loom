import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessEngine } from "../src/server/engine.ts";
import { Catalog } from "../src/server/catalog.ts";
import { GitWorkspaces } from "../src/server/git.ts";
import { saveAttachment } from "../src/server/attachments.ts";
import type {
  Runtime,
  RuntimeInput,
  RuntimeEvent,
  RuntimeResult,
} from "../src/shared/types.ts";
class Controlled implements Runtime {
  name = "controlled";
  capabilities = { inject: true, interrupt: true, readOnly: true };
  turns: {
    input: RuntimeInput;
    emit: (event: RuntimeEvent) => void;
    finish: (result?: Partial<RuntimeResult>) => void;
  }[] = [];
  confirmInjection = true;
  beforeInjectionReply?: () => Promise<void>;
  injections: {
    text: string;
    input?: Pick<RuntimeInput, "attachments" | "skills">;
  }[] = [];
  skills = [
    {
      name: "example",
      path: "/skills/example/SKILL.md",
      description: "example",
    },
  ];
  discoverOptions = async () => ({
    models: [],
    skills: this.skills,
    warnings: [],
  });
  async start(input: RuntimeInput, emit: (event: RuntimeEvent) => void) {
    let finish!: (result?: Partial<RuntimeResult>) => void;
    const done = new Promise<RuntimeResult>((resolve) => {
      finish = (result) =>
        resolve({
          status: "completed",
          text: "done",
          threadId: "thread",
          ...result,
        });
    });
    this.turns.push({ input, emit, finish });
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
      inject: async (
        text: string,
        input?: Pick<RuntimeInput, "attachments" | "skills">,
      ) => {
        this.injections.push({ text, input });
        await this.beforeInjectionReply?.();
        return this.confirmInjection;
      },
    };
  }
}
async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}
function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "harness-session-"));
  const runtime = new Controlled();
  const catalog = new Catalog(join(root, "catalog.json"));
  let engine = new HarnessEngine(root, runtime, new GitWorkspaces(), catalog);
  engine.state.project.id = "origin-project";
  t.after(async () => {
    await engine.shutdown();
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    runtime,
    get engine() {
      return engine;
    },
    restart() {
      engine.close();
      engine = new HarnessEngine(root, runtime, new GitWorkspaces(), catalog);
      return engine;
    },
  };
}
test("durable FIFO snapshots settings, deduplicates request IDs and measures each execution", async (t) => {
  const f = fixture(t),
    s = f.engine.createSession({ title: "chat", model: "initial" });
  await f.engine.sendMessage(s.id, { text: "one", requestId: "one" });
  await Promise.all([
    f.engine.sendMessage(s.id, {
      text: "two",
      mode: "queue",
      requestId: "two",
      model: "second",
      reasoning: "max",
    }),
    f.engine.sendMessage(s.id, {
      text: "three",
      mode: "queue",
      requestId: "three",
    }),
  ]);
  await f.engine.sendMessage(s.id, {
    text: "two",
    mode: "queue",
    requestId: "two",
    model: "second",
    reasoning: "max",
  });
  assert.equal(s.queue?.length, 2);
  assert.equal(f.runtime.turns.length, 1);
  await assert.rejects(
    f.engine.sendMessage(s.id, { text: "changed", requestId: "one" }),
    /different turn/,
  );
  f.runtime.turns[0].emit({ type: "tool.started" });
  f.runtime.turns[0].emit({
    type: "context.usage",
    contextUsage: { tokens: 31, window: 100 },
    model: "resolved",
  });
  f.runtime.turns[0].finish({
    usage: { inputTokens: 15, cachedInputTokens: 3, outputTokens: 2 },
  });
  await tick();
  assert.equal(f.runtime.turns.length, 2);
  assert.equal(f.runtime.turns[1].input.model, "second");
  assert.equal(f.runtime.turns[1].input.reasoning, "max");
  assert.equal(
    f.runtime.turns[1].input.env?.HARNESS_PROJECT_ID,
    "origin-project",
  );
  f.runtime.turns[1].finish();
  await tick();
  assert.equal(f.runtime.turns[2].input.model, "initial");
  f.runtime.turns[2].finish();
  await tick();
  assert.deepEqual(
    s.messages.filter((m) => m.role === "user").map((m) => m.text),
    ["one", "two", "three"],
  );
  assert.equal(f.engine.state.executions[0].metrics?.toolCalls, 1);
  assert.equal(f.engine.state.executions[0].usageKnown, true);
  assert.equal(f.engine.state.executions[1].usageKnown, false);
  assert.equal(f.engine.state.executions[0].model, "resolved");
  assert.deepEqual(s.contextUsage, { tokens: 31, window: 100 });
  assert.equal("tokenHash" in f.engine.view().executions![0], false);
});
test("interruption and failure pause FIFO until explicit continuation; cancellation stays deduplicated", async (t) => {
  const f = fixture(t),
    s = f.engine.createSession({ title: "chat" });
  await f.engine.sendMessage(s.id, "one");
  await f.engine.sendMessage(s.id, {
    text: "two",
    mode: "queue",
    requestId: "two",
  });
  await f.engine.sendMessage(s.id, {
    text: "three",
    mode: "queue",
    requestId: "three",
  });
  await assert.rejects(f.engine.interrupt(s.id, "stale"), /Target/);
  assert.equal(s.queuePaused, undefined);
  await f.engine.interrupt(s.id, f.engine.state.executions[0].id);
  assert.equal(f.runtime.turns.length, 1);
  assert.equal(s.queuePaused, true);
  f.engine.cancelQueued(s.id, s.queue![1].id);
  await f.engine.sendMessage(s.id, {
    text: "three",
    mode: "queue",
    requestId: "three",
  });
  assert.equal(s.queue?.length, 1);
  f.engine.continueQueue(s.id);
  assert.equal(f.runtime.turns.length, 2);
  await f.engine.sendMessage(s.id, { text: "four", mode: "queue" });
  f.runtime.turns[1].finish({ status: "failed", error: "failed" });
  await tick();
  assert.equal(s.queuePaused, true);
  assert.equal(s.queue?.length, 1);
  const restored = f.restart().session(s.id);
  assert.equal(restored.queuePaused, true);
  assert.equal(restored.queue?.[0].input.text, "four");
  f.engine.continueQueue(s.id);
  assert.equal(f.runtime.turns.length, 3);
});
test("native descriptors survive start, queued turns and steering; unknown skills are refused", async (t) => {
  const f = fixture(t),
    s = f.engine.createSession({ title: "chat" });
  const attachment = saveAttachment(f.root, {
    name: "note.txt",
    mediaType: "text/plain",
    base64: Buffer.from("hello").toString("base64"),
  });
  const skills = [{ name: "example", path: "/skills/example/SKILL.md" }];
  await f.engine.sendMessage(s.id, {
    text: "read",
    attachmentIds: [attachment.id],
    skills,
  });
  assert.equal(f.runtime.turns[0].input.attachments?.[0].id, attachment.id);
  assert.deepEqual(f.runtime.turns[0].input.skills, skills);
  const id = f.engine.state.executions[0].id;
  await f.engine.sendMessage(s.id, {
    text: "steer",
    mode: "steer",
    expectedExecutionId: id,
    requestId: "steer",
    attachmentIds: [attachment.id],
    skills,
  });
  assert.equal(
    f.runtime.injections[0].input?.attachments?.[0].id,
    attachment.id,
  );
  assert.deepEqual(s.messages.at(-1)?.attachments, [attachment]);
  await assert.rejects(
    f.engine.sendMessage(s.id, {
      text: "bad",
      mode: "steer",
      skills: [{ name: "missing", path: "bad" }],
    }),
    /unavailable/,
  );
  f.runtime.turns[0].finish();
  await tick();
  await assert.rejects(
    f.engine.sendMessage(s.id, {
      text: "late",
      mode: "steer",
      expectedExecutionId: id,
    }),
    /Target/,
  );
  assert.equal(s.queue?.length ?? 0, 0);
});
test("steering captures its execution before asynchronous skill validation and never queues after a race", async (t) => {
  const f = fixture(t),
    s = f.engine.createSession({ title: "chat" });
  await f.engine.sendMessage(s.id, "one");
  let release!: () => void;
  f.runtime.discoverOptions = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { models: [], skills: f.runtime.skills, warnings: [] };
  };
  const steering = f.engine.sendMessage(s.id, {
    text: "raced",
    mode: "steer",
    skills: [{ name: "example", path: "/skills/example/SKILL.md" }],
  });
  await tick();
  f.runtime.turns[0].finish();
  await tick();
  release();
  await assert.rejects(steering, /Target/);
  assert.equal(f.runtime.injections.length, 0);
  assert.equal(f.runtime.turns.length, 1);
  assert.equal(s.queue?.length ?? 0, 0);
});

test("unconfirmed steering keeps a durable failure receipt and never injects twice", async (t) => {
  const f = fixture(t),
    s = f.engine.createSession({ title: "chat" });
  await f.engine.sendMessage(s.id, "one");
  f.runtime.confirmInjection = false;
  const input = {
    text: "steer",
    mode: "steer" as const,
    requestId: "uncertain",
  };
  await assert.rejects(f.engine.sendMessage(s.id, input), /did not confirm/);
  await assert.rejects(f.engine.sendMessage(s.id, input), /did not confirm/);
  assert.equal(f.runtime.injections.length, 1);
  f.runtime.turns[0].finish();
  await tick();
  f.restart();
  await assert.rejects(f.engine.sendMessage(s.id, input), /did not confirm/);
  assert.equal(f.runtime.injections.length, 1);
});

test("confirmed steering remains delivered when the target completes before acknowledgement reaches the engine", async (t) => {
  const f = fixture(t);
  const session = f.engine.createSession({ title: "ack race" });
  await f.engine.sendMessage(session.id, "start");
  f.runtime.beforeInjectionReply = async () => {
    f.runtime.turns[0].finish();
    await tick();
  };
  const input = {
    text: "accepted correction",
    mode: "steer" as const,
    requestId: "ack-race",
    expectedExecutionId: f.engine.state.executions[0].id,
  };
  await f.engine.sendMessage(session.id, input);
  assert.equal(session.status, "idle");
  assert.equal(
    session.messages.filter((m) => m.delivery === "steer").length,
    1,
  );
  await f.engine.sendMessage(session.id, input);
  assert.equal(f.runtime.injections.length, 1);
  assert.equal(
    session.turnRequests?.find((r) => r.requestId === "ack-race")?.error,
    undefined,
  );
});
test("restart pauses an otherwise runnable persisted queue and retains idempotency", async (t) => {
  const f = fixture(t),
    s = f.engine.createSession({ title: "chat" });
  s.queuePaused = true;
  await f.engine.sendMessage(s.id, {
    text: "saved",
    mode: "queue",
    requestId: "saved",
  });
  s.queuePaused = false;
  f.engine.record("test.persist", "Persist runnable queue");
  const restored = f.restart().session(s.id);
  assert.equal(restored.queuePaused, true);
  assert.equal(f.runtime.turns.length, 0);
  await f.engine.sendMessage(s.id, {
    text: "saved",
    mode: "queue",
    requestId: "saved",
  });
  assert.equal(restored.queue?.length, 1);
  f.engine.continueQueue(s.id);
  assert.equal(f.runtime.turns.length, 1);
});
