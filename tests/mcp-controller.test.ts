import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod/v4";
import { createHttpServer } from "../src/server/http.ts";
import { GitWorkspaces } from "../src/server/git.ts";
import { controllerDescriptions } from "../src/shared/controller.ts";
import type { Runtime, TaskType } from "../src/shared/types.ts";

const exec = promisify(execFile);
const key = "stdio-controller-fixture-key-01234567890123456789";
const object = z.record(z.string(), z.unknown());
const graphIdResult = z.object({ graphId: z.uuid() });
const inboxResult = z.object({ items: z.array(z.object({ id: z.uuid(), graphId: z.uuid() })) });
const runtime: Runtime & { starts: number } = {
  name: "MCP command fixture", capabilities: { inject: true, interrupt: true, readOnly: true }, starts: 0,
  async start() { this.starts++; throw new Error("Command fixture must not start a model"); },
};
async function fixture(t: TestContext, git = false) {
  const root = await mkdtemp(join(tmpdir(), "loom-stdio-"));
  const clients: Client[] = [];
  let appToClose: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  t.after(async () => {
    for (const client of clients) await client.close();
    await appToClose?.close();
    await rm(root, { recursive: true, force: true });
  });
  if (git) {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-m", "fixture"], { cwd: root });
  }
  const app = await createHttpServer({ runtime, git: new GitWorkspaces(), projectRoot: root, catalogPath: join(root, ".newharness", "catalog.json") });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  appToClose = app;
  const address = app.server.address(); assert(address && typeof address !== "string");
  const port = address.port;
  const sessionId = randomUUID();
  async function connect(localPort = port) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-transform-types", resolve("src/mcp-controller.ts"), "--port", String(localPort), "--project", app.engine!.state.project.id!, "--session", sessionId],
      env: { LOOM_CONTROLLER_KEY: key }, stderr: "pipe", cwd: process.cwd(),
    });
    let stderr = "";
    transport.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    const client = new Client({ name: "loom-controller-acceptance", version: "1" });
    clients.push(client);
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "loom");
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name: `loom_${name}`, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return object.parse(result.structuredContent);
    };
    return { client, call, get stderr() { return stderr; } };
  }
  return { root, app, connect, sessionId };
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("official SDK stdio initialize, tools/list and tools/call expose only the desktop controller contract", async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  const listed = await c.client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), Object.keys(controllerDescriptions).map((op) => `loom_${op}`).sort());
  await c.call("connect", { create: true, title: "SDK desktop" });
  await c.call("state"); await c.call("task_types");
  const error = await c.client.callTool({ name: "loom_reports", arguments: { graphId: randomUUID() } });
  assert.equal(error.isError, true);
  assert.equal(z.object({ error: z.object({ code: z.string() }) }).parse(error.structuredContent).error.code, "FORBIDDEN");
  const invalid = await c.client.callTool({ name: "loom_state", arguments: { url: "http://remote" } });
  assert.equal(invalid.isError, true);
  assert.doesNotMatch(JSON.stringify(error), new RegExp(key));
  assert.doesNotMatch(c.stderr, new RegExp(key));
});

test("stdio maps HTTP errors and timeouts and never follows a redirect with controller credentials", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  let mode = "error", leakedRequests = 0;
  const target = createServer((_req, res) => { leakedRequests++; res.end("unexpected"); });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address(); assert(targetAddress && typeof targetAddress !== "string");
  const redirect = `http://127.0.0.1:${targetAddress.port}/must-not-follow`;
  const http = createServer((_req, res) => {
    if (mode === "timeout") return;
    if (mode === "redirect") { res.writeHead(307, { Location: redirect }); res.end(); return; }
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "FIXTURE_ERROR", message: `redact ${key}` } }));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    http.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => http.close(() => resolve())), new Promise<void>((resolve) => target.close(() => resolve()))]);
  });
  const address = http.address(); assert(address && typeof address !== "string");
  const c = await f.connect(address.port);
  async function code() {
    const result = await c.client.callTool({ name: "loom_state", arguments: {} });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
    return z.object({ error: z.object({ code: z.string() }) }).parse(result.structuredContent).error.code;
  }
  assert.equal(await code(), "FIXTURE_ERROR");
  mode = "redirect"; assert.equal(await code(), "HTTP_UNAVAILABLE"); assert.equal(leakedRequests, 0);
  mode = "timeout"; assert.equal(await code(), "HTTP_TIMEOUT");
});

test("stdio + HTTP + Engine complete command graph delivery, reports, graph controls and durable inbox reconnect/ack", async (t) => {
  const f = await fixture(t, true);
  const starts = runtime.starts;
  const type: TaskType = {
    id: "controller-command", name: "Controller command", version: 1,
    units: [{ id: "check", name: "check", kind: "command", skills: [], prompt: "", readOnly: false,
      command: "node -e \"setTimeout(()=>{require('fs').writeFileSync('command-result.txt','ok');console.log('stdio command verified')},200)\"" }],
    start: ["check"], rules: [{ from: "check", outcome: "ready", action: { type: "finish" } }], maxRounds: 2, maxReportRetries: 0,
  };
  f.app.engine!.saveType(type);
  const c = await f.connect(); await c.call("connect", { create: true });
  const input = { requestId: "command-graph", name: "SDK command delivery", tasks: [{ id: "A", title: "A", goal: "run command", deps: [], taskTypeId: type.id }] };
  const created = graphIdResult.parse(await c.call("graph_create", input));
  assert.deepEqual(await c.call("graph_create", input), created);
  const graphId = created.graphId;
  await c.call("graph_control", { graphId, action: "run" });
  await until(async () => ["done", "blocked"].includes(String((await c.call("state", { graphId })).status)), "command delivery");
  assert.equal((await c.call("state", { graphId })).status, "done");
  const graph = f.app.engine!.graph(graphId);
  assert.equal(graph.integration?.deliveries[0].state.status, "published");
  assert.equal(await readFile(join(graph.workspace!.path, "command-result.txt"), "utf8"), "ok");
  const reports = z.object({ items: z.array(z.object({ id: z.uuid() })) }).parse(await c.call("reports", { graphId }));
  const report = await c.call("reports", { graphId, reportId: reports.items[0].id });
  assert.match(String(report.content), /stdio command verified/);
  const inbox = inboxResult.parse(await c.call("inbox", { graphId }));
  assert.equal(inbox.items.length, 1);
  const letterId = inbox.items[0].id;
  assert.equal(f.app.engine!.state.letters.find((l) => l.id === letterId)!.deliveries[0].status, "queued");
  await c.client.close();
  const reconnected = await f.connect(); await reconnected.call("connect");
  assert.deepEqual(inboxResult.parse(await reconnected.call("inbox", { graphId })), inbox);
  const other = graphIdResult.parse(await reconnected.call("graph_create", { ...input, requestId: "second-graph" }));
  const wrong = await reconnected.client.callTool({ name: "loom_ack", arguments: { graphId: other.graphId, letterId } });
  assert.equal(wrong.isError, true);
  const ack = await reconnected.call("ack", { graphId, letterId });
  assert.deepEqual(await reconnected.call("ack", { graphId, letterId }), ack);
  assert.equal(inboxResult.parse(await reconnected.call("inbox", { graphId })).items.length, 0);
  await reconnected.call("graph_control", { graphId: other.graphId, action: "run" });
  await reconnected.call("graph_control", { graphId: other.graphId, action: "pause", mode: "soft" });
  await until(async () => (await reconnected.call("state", { graphId: other.graphId })).status === "paused", "soft pause");
  await reconnected.call("graph_control", { graphId: other.graphId, action: "resume" });
  await until(async () => (await reconnected.call("state", { graphId: other.graphId })).status === "done", "resume");
  const remaining = inboxResult.parse(await reconnected.call("inbox"));
  assert.equal(remaining.items.length, 1); assert.equal(remaining.items[0].graphId, other.graphId);
  const retryType: TaskType = { ...type, id: "controller-retry", units: [{ ...type.units[0],
    command: "node -e \"const f=require('fs');if(!f.existsSync('.retry')){f.writeFileSync('.retry','first');process.exit(3)}f.writeFileSync('repaired.txt','ok');console.log('repaired')\"" }] };
  f.app.engine!.saveType(retryType);
  const retry = graphIdResult.parse(await reconnected.call("graph_create", { ...input, requestId: "retry-graph", tasks: [{ ...input.tasks[0], taskTypeId: retryType.id }] }));
  await reconnected.call("graph_control", { graphId: retry.graphId, action: "run" });
  await until(async () => (await reconnected.call("state", { graphId: retry.graphId })).status === "blocked", "blocked command");
  await until(async () => !f.app.engine!.busy, "blocked settlement");
  await reconnected.call("graph_control", { graphId: retry.graphId, action: "resolve", taskId: "A" });
  await until(async () => (await reconnected.call("state", { graphId: retry.graphId })).status === "done", "resolved command");
  assert.equal(runtime.starts, starts);
  assert.equal(f.app.engine!.state.executions.filter((e) => e.sessionId === f.sessionId).length, 0);
});
