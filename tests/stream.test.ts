import { test } from "node:test";
import assert from "node:assert/strict";
import { get, type ClientRequest, type ServerResponse } from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import { createHttpServer } from "../src/server/http.ts";
import { GitWorkspaces } from "../src/server/git.ts";
import type { ProjectEntry, Runtime } from "../src/shared/types.ts";

async function waitFor(check: () => boolean, description: string) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert(Date.now() < deadline, `Timed out waiting for ${description}`);
    await setTimeout(10);
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-stream-"));
  const runtime: Runtime = {
    name: "no-model",
    capabilities: { inject: false, interrupt: false, readOnly: true },
    async start() { throw new Error("Unexpected model call"); },
  };
  const app = await createHttpServer({
    runtime,
    git: new GitWorkspaces(),
    projectRoot: root,
    catalogPath: join(root, "catalog.json"),
  });
  const responses: {
    response: ServerResponse;
    writes: number;
    writesWhileNeedingDrain: number;
    peakBufferedBytes: number;
    maxFrameBytes: number;
    backpressuredWrites: number;
    drains: number;
  }[] = [];
  app.server.prependListener("request", (request, response) => {
    if (!request.url?.endsWith("/stream")) return;
    const stats = {
      response, writes: 0, writesWhileNeedingDrain: 0,
      peakBufferedBytes: 0, maxFrameBytes: 0, backpressuredWrites: 0, drains: 0,
    };
    responses.push(stats);
    const write = response.write;
    response.write = function (...args: [unknown, ...unknown[]]) {
      const wasBackpressured = response.writableNeedDrain;
      const accepted: boolean = Reflect.apply(write, response, args);
      stats.writes++;
      if (wasBackpressured) stats.writesWhileNeedingDrain++;
      if (!accepted) stats.backpressuredWrites++;
      stats.peakBufferedBytes = Math.max(stats.peakBufferedBytes, response.writableLength);
      assert(typeof args[0] === "string");
      stats.maxFrameBytes = Math.max(stats.maxFrameBytes, Buffer.byteLength(args[0]));
      return accepted;
    };
    response.on("drain", () => stats.drains++);
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const clients: ClientRequest[] = [];
  async function connect(path = "/api/stream", paused = false) {
    const request = get(url + path);
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "text/event-stream");
    const client = { request, response, latest: "", frames: 0 };
    let buffer = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        assert(frame.startsWith("event: state\ndata: "));
        client.latest = frame.slice("event: state\ndata: ".length);
        client.frames++;
        buffer = buffer.slice(end + 2);
      }
    });
    if (paused) response.pause();
    clients.push(request);
    return client;
  }
  let closed = false;
  async function closeServer() {
    if (closed) return;
    closed = true;
    await app.close();
  }
  async function close() {
    for (const client of clients) client.destroy();
    await closeServer();
  }
  assert(app.engine);
  return { root, app, engine: app.engine, responses, connect, close, closeServer, url };
}

test("SSE bounds a paused real HTTP client, delivers latest state after drain and isolates fast clients and projects", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const session = f.engine.createSession({ title: "before" });
    session.messages.push({ id: "large", role: "assistant", text: "x".repeat(160000), at: new Date().toISOString() });
    const slow = await f.connect("/api/stream", true);
    const fast = await f.connect();
    const otherRoot = join(f.root, "other");
    await mkdir(otherRoot);
    const registration = await fetch(f.url + "/api/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: otherRoot }),
    });
    assert.equal(registration.status, 201);
    const entry: ProjectEntry = await registration.json();
    const isolated = await f.connect(`/api/projects/${entry.id}/stream`);
    const otherEngine = f.app.engines.get(entry.id);
    assert(otherEngine);
    otherEngine.createSession({ title: "other project only" });
    await waitFor(() => fast.frames > 0 && isolated.latest === JSON.stringify(otherEngine.view()), "initial fast snapshots");
    const isolatedFrames = isolated.frames;
    const stats = f.responses[0];
    for (let index = 0; index < 60; index++) {
      session.title = `revision-${index}`;
      f.engine.record("stream.tick", session.title);
      await waitFor(() => fast.latest === JSON.stringify(f.engine.view()), "fast client update while slow client is paused");
    }
    assert(stats.response.writableNeedDrain, "paused HTTP socket must actually exert backpressure");
    assert(stats.backpressuredWrites > 0);
    assert.equal(stats.writesWhileNeedingDrain, 0, "no further writes before real drain");
    assert(stats.peakBufferedBytes <= stats.maxFrameBytes + 1024, "one state frame plus HTTP framing bounds the queue");
    assert.equal(isolated.frames, isolatedFrames, "other project receives no cross-project broadcasts");
    const writesBeforeDrain = stats.writes;
    const drainsBeforeResume = stats.drains;
    const expected = JSON.stringify(f.engine.view());
    slow.response.resume();
    await waitFor(() => slow.latest === expected && !stats.response.writableNeedDrain, "latest snapshot after real drain with no additional broadcast");
    assert(stats.drains > drainsBeforeResume);
    assert.equal(stats.writes, writesBeforeDrain + 1, "all pending state changes coalesce to one latest snapshot");
    await setTimeout(30);
    assert.equal(stats.writes, writesBeforeDrain + 1, "drain without pending changes does not replay state");
    const persisted = f.engine.store.events({}).filter((event) => event.type === "stream.tick");
    assert.equal(persisted.length, 60, "UI coalescing preserves every durable event");
    assert.equal(stats.response.listenerCount("drain"), 2, "only one application drain listener plus test observer");
    slow.request.destroy();
    await waitFor(() => stats.response.destroyed && stats.response.listenerCount("drain") === 1, "disconnect removes application drain listener");
    const writesAfterClose = stats.writes;
    f.engine.record("stream.after-close", "still live");
    await waitFor(() => fast.latest === JSON.stringify(f.engine.view()), "fast client continues after slow disconnect");
    assert.equal(stats.writes, writesAfterClose);
  } finally {
    await f.close();
  }
});

test("SSE cleans up a backpressured connection on disconnect and on server shutdown", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const session = f.engine.createSession({ title: "blocked close" });
    session.messages.push({ id: "large", role: "assistant", text: "x".repeat(160000), at: new Date().toISOString() });
    const client = await f.connect("/api/stream", true);
    const stats = f.responses[0];
    for (let index = 0; index < 60; index++) {
      f.engine.record("stream.tick", `pending-${index}`);
      await setImmediate();
    }
    assert(stats.response.writableNeedDrain);
    assert.equal(stats.response.listenerCount("drain"), 2);
    client.request.destroy();
    await waitFor(() => stats.response.destroyed && stats.response.listenerCount("drain") === 1, "backpressured disconnect cleanup");
    const writes = stats.writes;
    f.engine.record("stream.after-close", "no closed-client write");
    assert.equal(stats.writes, writes);
    const live = await f.connect();
    await waitFor(() => live.frames > 0, "reconnected initial snapshot");
    const liveStats = f.responses[1];
    live.response.pause();
    for (let index = 0; index < 60; index++) {
      session.title = `shutdown-pending-${index}`;
      f.engine.record("stream.tick", session.title);
      await setImmediate();
    }
    assert(liveStats.response.writableNeedDrain, "shutdown starts with a genuinely blocked connection");
    assert.equal(liveStats.response.listenerCount("drain"), 2);
    const writesBeforeShutdown = liveStats.writes;
    const shutdown = f.closeServer();
    await waitFor(() => liveStats.response.writableEnded, "shutdown ends the backpressured response");
    assert.equal(liveStats.response.listenerCount("drain"), 1);
    live.request.destroy();
    await shutdown;
    assert.equal(liveStats.writes, writesBeforeShutdown, "shutdown does not flush a pending state snapshot");
    assert.equal(liveStats.response.listenerCount("drain"), 1, "server shutdown removes application drain listener");
    const finalWrites = liveStats.writes;
    f.engine.listeners.forEach((listener) => listener());
    assert.equal(liveStats.writes, finalWrites, "shutdown removes subscription");
  } finally {
    await f.close();
  }
});
