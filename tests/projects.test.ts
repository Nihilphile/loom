import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHttpServer } from "../src/server/http.ts";
import { GitWorkspaces } from "../src/server/git.ts";
import type {
  AppState,
  Runtime,
  RuntimeInput,
  RuntimeResult,
  RuntimeEvent,
  Session,
  ProjectEntry,
  Attachment,
} from "../src/shared/types.ts";

const exec = promisify(execFile);
class HeldRuntime implements Runtime {
  name = "project test";
  capabilities = { inject: true, interrupt: true, readOnly: true };
  turns: {
    input: RuntimeInput;
    finish: (result?: Partial<RuntimeResult>) => void;
    emit: (event: RuntimeEvent) => void;
  }[] = [];
  async start(input: RuntimeInput, emit: (event: RuntimeEvent) => void) {
    let finish!: (result?: Partial<RuntimeResult>) => void;
    const done = new Promise<RuntimeResult>((resolve) => {
      finish = (result) =>
        resolve({ status: "completed", text: "done", ...result });
    });
    this.turns.push({ input, finish, emit });
    return {
      accepted: Promise.resolve({
        status: "accepted" as const,
        threadId: input.threadId || "thread",
        turnId: "turn",
      }),
      done,
      inject: async () => true,
      interrupt: async () => {
        finish({ status: "interrupted" });
      },
    };
  }
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for project execution");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-projects-"));
  const runtime = new HeldRuntime();
  const app = await createHttpServer({
    runtime,
    git: new GitWorkspaces(),
    catalogPath: join(root, "catalog.json"),
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  async function request<T>(
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<T> {
    const response = await fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert(response.ok, JSON.stringify(result));
    return result as T;
  }
  return { root, runtime, app, url, request };
}

test("two projects keep active sessions, scoped streams, attachments and CLI ownership across switches", async () => {
  const f = await fixture();
  const streamAbort = new AbortController();
  try {
    const a = await f.request<ProjectEntry>("/api/projects", {
      path: join(f.root, "A"),
    });
    const b = await f.request<ProjectEntry>("/api/projects", {
      path: join(f.root, "B"),
    });
    const pa = `/api/projects/${a.id}`,
      pb = `/api/projects/${b.id}`;
    const duplicate = await f.request<ProjectEntry>("/api/projects", {
      path: join(f.root, "A", "."),
    });
    assert.equal(duplicate.id, a.id);
    const sa = await f.request<Session>(pa + "/sessions", { title: "Only A" });
    const sb = await f.request<Session>(pb + "/sessions", { title: "Only B" });
    await f.request(pa + `/sessions/${sa.id}/turn`, {
      text: "A runs",
      requestId: "A-1",
    });
    await f.request(pb + `/sessions/${sb.id}/turn`, {
      text: "B runs",
      requestId: "B-1",
    });
    await waitFor(() => f.runtime.turns.length === 2);
    assert.equal(f.runtime.turns[0].input.env?.HARNESS_PROJECT_ID, a.id);
    assert.equal(f.runtime.turns[1].input.env?.HARNESS_PROJECT_ID, b.id);
    const aState = await f.request<AppState>(pa + "/state");
    const bState = await f.request<AppState>(pb + "/state");
    assert.deepEqual(
      aState.sessions.map((s) => s.title),
      ["Only A"],
    );
    assert.deepEqual(
      bState.sessions.map((s) => s.title),
      ["Only B"],
    );
    assert.equal(aState.sessions[0].status, "running");
    assert.equal(bState.sessions[0].status, "running");
    const stream = await fetch(f.url + pa + "/stream", {
      signal: streamAbort.signal,
    });
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert(first.includes(a.id));
    assert(!first.includes("Only B"));
    f.runtime.turns[1].emit({ type: "assistant.delta", text: "B private" });
    f.runtime.turns[0].emit({ type: "assistant.delta", text: "A visible" });
    const next = new TextDecoder().decode((await reader.read()).value);
    assert(!next.includes("B private"));
    streamAbort.abort();
    const attachment = await f.request<Attachment>(pa + "/attachments", {
      name: "notes.txt",
      mediaType: "text/plain",
      base64: Buffer.from("Only A attachment").toString("base64"),
    });
    assert.equal(
      await (await fetch(f.url + pa + "/attachments/" + attachment.id)).text(),
      "Only A attachment",
    );
    assert.equal(
      (await fetch(f.url + pb + "/attachments/" + attachment.id)).status,
      400,
    );
    const cli = await exec(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), "state"],
      {
        env: {
          ...process.env,
          HARNESS_URL: f.url,
          HARNESS_PROJECT_ID: b.id,
          HARNESS_TOKEN: "",
        },
        windowsHide: true,
      },
    );
    const cliState = JSON.parse(cli.stdout) as AppState;
    assert.equal(cliState.project?.id, b.id);
    assert.equal(cliState.sessions[0].id, sb.id);
    f.runtime.turns[0].finish();
    f.runtime.turns[1].finish();
    await waitFor(() => [...f.app.engines.values()].every((e) => !e.busy));
    assert.equal(
      (await f.request<{ projects: ProjectEntry[] }>("/api/projects")).projects
        .length,
      2,
    );
  } finally {
    streamAbort.abort();
    await f.app.close();
  }
});

test("registration preserves existing source, persists IDs and initializes only new directories", async () => {
  const f = await fixture();
  const existing = join(f.root, "existing");
  await mkdir(existing);
  await writeFile(join(existing, "keep.txt"), "unchanged");
  const a = await f.request<ProjectEntry>("/api/projects", { path: existing });
  const b = await f.request<ProjectEntry>("/api/projects", {
    path: join(f.root, "new"),
  });
  assert.deepEqual(await readdir(existing), ["keep.txt"]);
  assert.equal(await readFile(join(existing, "keep.txt"), "utf8"), "unchanged");
  assert(
    (await exec("git", ["rev-parse", "HEAD"], { cwd: b.path })).stdout.trim(),
  );
  await f.app.close();
  const reopened = await createHttpServer({
    runtime: new HeldRuntime(),
    git: new GitWorkspaces(),
    catalogPath: join(f.root, "catalog.json"),
  });
  await new Promise<void>((resolve) =>
    reopened.server.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = reopened.server.address();
    assert(address && typeof address !== "string");
    const listed = (await (
      await fetch(`http://127.0.0.1:${address.port}/api/projects`)
    ).json()) as { projects: ProjectEntry[] };
    assert.deepEqual(
      listed.projects.map((p) => p.id),
      [a.id, b.id],
    );
  } finally {
    await reopened.close();
  }
});

test("unit CLI reports are bound to their project while another graph runs", async () => {
  const f = await fixture();
  try {
    const a = await f.request<ProjectEntry>("/api/projects", {
      path: join(f.root, "A"),
    });
    const b = await f.request<ProjectEntry>("/api/projects", {
      path: join(f.root, "B"),
    });
    for (const p of [a, b]) {
      const graph = await f.request<{ id: string }>(
        `/api/projects/${p.id}/graphs`,
        {
          name: p.name,
          tasks: [
            {
              id: "A",
              title: "A",
              goal: "work",
              deps: [],
              taskTypeId: "direct",
            },
          ],
        },
      );
      await f.request(`/api/projects/${p.id}/graphs/${graph.id}/run`, {});
    }
    await waitFor(() => f.runtime.turns.length === 2);
    const turn = f.runtime.turns.find(
      (t) => t.input.env?.HARNESS_PROJECT_ID === a.id,
    )!;
    assert(turn);
    const report = join(turn.input.cwd, ".newharness", "reports", "ready.md");
    await mkdir(join(turn.input.cwd, ".newharness", "reports"), {
      recursive: true,
    });
    await writeFile(report, "ready evidence");
    const token = turn.input.env!.HARNESS_TOKEN;
    const mismatch = await fetch(`${f.url}/api/projects/${b.id}/unit/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ outcome: "ready", report }),
    });
    assert.equal(mismatch.status, 403);
    const cli = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/cli.ts"),
        "unit",
        "report",
        "--outcome",
        "ready",
        "--report",
        report,
      ],
      { env: { ...process.env, ...turn.input.env }, windowsHide: true },
    );
    assert.equal(JSON.parse(cli.stdout).outcome, "ready");
    assert.equal(
      f.app.engines.get(a.id)!.state.graphs[0].tasks[0].submissions.length,
      1,
    );
    assert.equal(
      f.app.engines.get(b.id)!.state.graphs[0].tasks[0].submissions.length,
      0,
    );
    const legacy = await f.request<{ id: string }>(
      "/api/unit/report",
      { outcome: "ready", report },
      token,
    );
    assert.equal(legacy.id, JSON.parse(cli.stdout).id);
  } finally {
    await f.app.close();
  }
});
