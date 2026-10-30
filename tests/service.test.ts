import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { createHttpServer } from "../src/server/http.ts";
import { GitWorkspaces } from "../src/server/git.ts";
import { ProjectStore } from "../src/server/store.ts";
import { serviceRecordSchema, type ServiceCommand, type ServiceControl } from "../src/server/service.ts";
import type { Runtime, RuntimeResult } from "../src/shared/types.ts";

const exec = promisify(execFile);
async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20000;
  while (!await check()) {
    assert(Date.now() < deadline, "Service condition completed before timeout");
    await setTimeout(20);
  }
}
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
function heldRuntime() {
  let interrupted = 0, closed = 0;
  const runtime: Runtime = {
    name: "service lifecycle test", capabilities: { inject: false, interrupt: true, readOnly: true },
    async start(input, emit) {
      const threadId = randomUUID();
      let finish = () => {};
      const done = new Promise<RuntimeResult>((resolve) => { finish = () => resolve({ status: "interrupted", text: "saved result", threadId }); });
      emit({ type: "assistant.delta", text: "saved progress" });
      return { accepted: Promise.resolve({ status: "accepted", threadId, turnId: randomUUID() }), done, interrupt: async () => { interrupted++; finish(); }, inject: async () => false };
    },
    async close() { closed++; },
  };
  return { runtime, get interrupted() { return interrupted; }, get closed() { return closed; } };
}
async function request(url: string, route: string, body?: unknown) {
  const response = await fetch(url + route, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  assert(response.ok, JSON.stringify(result));
  return result;
}

test("session resource routes isolate owners and pause the turn queue before closing resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loom-session-resources-"));
  const held = heldRuntime();
  let owner: string | undefined, closed: string | undefined, stopped: string | undefined;
  const start = held.runtime.start.bind(held.runtime);
  held.runtime.start = (input, emit) => { owner = input.ownerId; return start(input, emit); };
  held.runtime.resources = async id => ({ state: closed === id ? "closed" : "active", processes: closed === id ? [] : [{ id: "owned-process", pid: 123, name: "server", role: "descendant", memoryBytes: 200 }] });
  held.runtime.stopResource = async (id, resourceId) => { assert.equal(id, owner); stopped = resourceId; };
  held.runtime.closeSession = async id => { closed = id; };
  const app = await createHttpServer({ runtime: held.runtime, git: new GitWorkspaces(), projectRoot: directory, catalogPath: join(directory, "catalog.json") });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const session = await request(url, "/api/sessions", { title: "resources" });
    await request(url, `/api/sessions/${session.id}/turn`, { text: "go", requestId: "start" });
    await waitFor(() => !!owner);
    const resources = await request(url, `/api/sessions/${session.id}/resources`);
    assert.equal(resources.sessionId, session.id);
    assert.equal(resources.processes[0].id, "owned-process");
    assert(owner!.includes(session.id));
    await request(url, `/api/sessions/${session.id}/resources/stop`, { resourceId: "owned-process" });
    assert.equal(stopped, "owned-process");
    const cleaned = await request(url, `/api/sessions/${session.id}/resources/close`, {});
    assert.equal(cleaned.state, "closed");
    assert.equal(closed, owner);
    assert.equal(held.interrupted, 1);
    assert.equal(app.engine!.session(session.id).queuePaused, true);
    assert.notEqual(app.engine!.session(session.id).status, "running");
  } finally { await app.close(); }
});

test("service controls reject execution credentials and drain active turns exactly once before releasing the project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loom-service-drain-"));
  const held = heldRuntime();
  const instanceId = randomUUID(), token = randomBytes(32).toString("hex");
  let operation: ServiceCommand | undefined, calls = 0;
  let finished: Promise<void> | undefined;
  const service: ServiceControl = {
    token, info: () => ({ product: "loom", pid: process.pid, instanceId, state: operation === "restart" ? "restarting" : operation === "stop" ? "stopping" : "ready" }),
    accept(command) { if (operation) return { started: false, operation }; operation = command; return { started: true, operation }; },
    async run() { calls++; finished = app.close(); await finished; },
  };
  const app = await createHttpServer({ runtime: held.runtime, git: new GitWorkspaces(), projectRoot: directory, catalogPath: join(directory, "catalog.json"), service });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { "x-loom-service-key": token, "x-loom-service-instance": instanceId };
  try {
    const s = await request(url, "/api/sessions", { title: "Preserve this conversation" });
    await request(url, `/api/sessions/${s.id}/turn`, { text: "Keep my input", requestId: "start" });
    await waitFor(() => app.engine!.session(s.id).status === "running");
    for (const rejected of [
      { ...headers, authorization: "Bearer execution-secret" },
      { ...headers, "x-loom-service-instance": randomUUID() },
      { ...headers, "x-loom-service-key": "wrong" },
    ]) assert.equal((await fetch(url + "/api/service/stop", { method: "POST", headers: rejected })).status, 403);
    assert.equal((await fetch(url + "/api/projects/nonexistent/service/stop", { method: "POST", headers })).status, 403);
    assert.equal(app.engines.size, 1);
    assert.equal(calls, 0);
    assert.equal((await fetch(url + "/api/service/stop", { method: "POST", headers })).status, 202);
    await waitFor(() => !!finished);
    await Promise.all([finished, app.close(), app.close()]);
    assert.equal(calls, 1);
    assert.equal(held.interrupted, 1);
    assert.equal(held.closed, 1);
    const store = new ProjectStore(directory);
    try {
      const saved = store.load().sessions.find((saved) => saved.id === s.id);
      assert(saved);
      assert.notEqual(saved.status, "running");
      assert(saved.messages.some((m) => m.text === "Keep my input"));
      assert(saved.messages.some((m) => m.text.includes("saved progress")));
    } finally { store.close(); }
  } finally { await app.close(); }
});

test("real CLI restart replaces the process, preserves launch configuration and history, rejects malformed targets, and stops idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loom-service-cli-"));
  const project = join(directory, "project"), services = join(directory, "services");
  await mkdir(project);
  const number = await port(), url = `http://127.0.0.1:${number}`;
  const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_URL: url, HARNESS_SERVICE_DIR: services, HARNESS_CATALOG: join(directory, "catalog.json"), HARNESS_REGISTRY: join(directory, "registry.json"), HARNESS_PROJECT_ID: "deliberately-not-a-project" };
  delete env.HARNESS_TOKEN;
  const cwd = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const main = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", main, "--port", String(number), "--project", project], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const record = async () => serviceRecordSchema.parse(JSON.parse(await readFile(join(services, `${number}.json`), "utf8")));
  const run = (...args: string[]) => exec(process.execPath, ["--import", "tsx", cli, ...args], { cwd, env, windowsHide: true, timeout: 30000 });
  try {
    await waitFor(async () => { try { return (await record()).state === "ready"; } catch { assert(child.exitCode === null, output); return false; } });
    const before = await record();
    const s = await request(url, "/api/sessions", { title: "Across a real restart" });
    const state = await request(url, "/api/state");
    for (const args of [["stop", "--port"], ["restart", "--port", "--timeout", "5"], ["stop", "--pot", "4317"], ["stop", "--port", "0"]])
      await assert.rejects(run(...args));
    await assert.rejects(exec(process.execPath, ["--import", "tsx", cli, "stop"], { cwd, env: { ...env, HARNESS_TOKEN: "unit-token" }, windowsHide: true }));
    assert.equal((await record()).instanceId, before.instanceId);
    await rename(services, services + ".saved");
    await writeFile(services, "block service record writes");
    const controlHeaders = { "x-loom-service-key": before.controlToken, "x-loom-service-instance": before.instanceId };
    try {
      assert.equal((await fetch(url + "/api/service/restart", { method: "POST", headers: controlHeaders })).status, 400);
      const info = await (await fetch(url + "/api/service", { headers: controlHeaders })).json();
      assert.equal(info.state, "ready");
    } finally { await unlink(services); await rename(services + ".saved", services); }
    const restarted = await Promise.all([run("restart", "--timeout", "20000"), run("restart", "--timeout", "20000")]);
    assert(restarted.every((result) => result.stdout.includes("已就绪")));
    const after = await record();
    assert.notEqual(after.instanceId, before.instanceId);
    assert.notEqual(after.pid, before.pid);
    await waitFor(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0, output);
    const restored = await request(url, "/api/state");
    assert.equal(restored.project.path, state.project.path);
    assert(restored.sessions.some((saved: { id: string }) => saved.id === s.id));
    assert.deepEqual(restored.workspaces.map((w: { id: string }) => w.id), state.workspaces.map((w: { id: string }) => w.id));
    const stopped = await run("stop", "--timeout", "20000");
    assert(stopped.stdout.includes("已停止"));
    assert((await run("stop")).stdout.includes("已停止"));
    await assert.rejects(readFile(join(services, `${number}.json`)));
  } finally {
    try { await run("stop", "--timeout", "10000"); } catch { child.kill(); }
  }
});

test("cold restart reconciles dead pending receipts while foreign listeners are never controlled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loom-service-cold-"));
  const services = join(directory, "services");
  await mkdir(services);
  const number = await port(), url = `http://127.0.0.1:${number}`;
  const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_URL: url, HARNESS_SERVICE_DIR: services, HARNESS_CATALOG: join(directory, "catalog.json"), HARNESS_REGISTRY: join(directory, "registry.json") };
  delete env.HARNESS_TOKEN;
  const cwd = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const run = (...args: string[]) => exec(process.execPath, ["--import", "tsx", cli, ...args], { cwd, env, windowsHide: true, timeout: 30000 });
  const deadPid = Number((await exec(process.execPath, ["-p", "process.pid"], { windowsHide: true })).stdout.trim());
  await writeFile(join(services, `${number}.launch`), JSON.stringify({ ownerPid: process.pid, id: randomUUID() }));
  await assert.rejects(run("stop"), /服务正在启动/);
  await writeFile(join(services, `${number}.launch`), JSON.stringify({ ownerPid: deadPid, successorPid: process.pid, id: randomUUID() }));
  await assert.rejects(run("stop"), /服务正在启动/);
  await unlink(join(services, `${number}.launch`));
  await writeFile(join(services, `${number}.json`), JSON.stringify({
    version: 1, instanceId: randomUUID(), pid: deadPid, successorPid: deadPid, url,
    controlToken: randomBytes(32).toString("hex"), startedAt: new Date().toISOString(),
    logFile: join(services, `${number}.log`), state: "restarting",
  }));
  try {
    const results = await Promise.all([run("restart", "--timeout", "20000"), run("restart", "--timeout", "20000")]);
    assert(results.every((result) => result.stdout.includes("已就绪")));
    const record = serviceRecordSchema.parse(JSON.parse(await readFile(join(services, `${number}.json`), "utf8")));
    assert.notEqual(record.pid, deadPid);
    assert.equal(record.state, "ready");
  } finally { await run("stop", "--timeout", "10000"); }
  let postRequests = 0;
  const foreign = createServer((req, res) => { if (req.method === "POST") postRequests++; res.writeHead(200, { "content-type": "application/json" }); res.end('{"product":"another-server"}'); });
  await new Promise<void>((resolve) => foreign.listen(number, "127.0.0.1", resolve));
  try {
    await assert.rejects(run("stop"), /Ctrl\+C/);
    await assert.rejects(run("restart"), /Ctrl\+C/);
    assert.equal(postRequests, 0);
    assert(foreign.listening);
  } finally { await new Promise<void>((resolve, reject) => foreign.close((error) => error ? reject(error) : resolve())); }
});

test("stop reports an instance change rather than success when another restart replaces its target", async () => {
  for (const boundary of ["probe", "command"]) {
    const directory = await mkdtemp(join(tmpdir(), "loom-service-replaced-"));
    const services = join(directory, "services");
    await mkdir(services);
    const number = await port(), url = `http://127.0.0.1:${number}`;
    const deadPid = Number((await exec(process.execPath, ["-p", "process.pid"], { windowsHide: true })).stdout.trim());
    const old = { version: 1, instanceId: randomUUID(), pid: deadPid, url, controlToken: randomBytes(32).toString("hex"), startedAt: new Date().toISOString(), logFile: join(services, `${number}.log`), state: "ready" };
    const replacement = { ...old, instanceId: randomUUID(), pid: process.pid, controlToken: randomBytes(32).toString("hex") };
    const receipt = join(services, `${number}.json`);
    await writeFile(receipt, JSON.stringify(old));
    let commands = 0;
    let serverError: unknown;
    const server = createServer(async (req, res) => {
      try {
        if (boundary === "probe") {
          await writeFile(receipt, JSON.stringify(replacement));
          res.writeHead(403).end();
        } else if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ product: "loom", instanceId: old.instanceId, pid: old.pid, state: "ready" }));
        } else {
          commands++;
          await writeFile(receipt, JSON.stringify(replacement));
          res.destroy();
        }
      } catch (error) { serverError = error; res.writeHead(500).end(); }
    });
    await new Promise<void>((resolve) => server.listen(number, "127.0.0.1", resolve));
    const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_URL: url, HARNESS_SERVICE_DIR: services };
    delete env.HARNESS_TOKEN;
    try {
      await assert.rejects(exec(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "stop", "--timeout", "2000"], { cwd: resolve(fileURLToPath(new URL("..", import.meta.url))), env, windowsHide: true, timeout: 10000 }), /服务实例已经变化/);
      assert.equal(serverError, undefined);
      assert.equal(commands, boundary === "probe" ? 0 : 1);
      assert.equal(serviceRecordSchema.parse(JSON.parse(await readFile(receipt, "utf8"))).instanceId, replacement.instanceId);
      assert(server.listening);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  }
});
