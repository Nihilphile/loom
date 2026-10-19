import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/server/http.ts";
import type { Runtime, GitAdapter } from "../src/shared/types.ts";

const runtime: Runtime = {
  name: "not-started",
  capabilities: { inject: false, interrupt: false, readOnly: false },
  async start() {
    throw new Error("Unexpected runtime call");
  },
};
const git: GitAdapter = {
  async createGraph() {
    throw new Error("Unexpected Git call");
  },
  async createTask() {
    throw new Error("Unexpected Git call");
  },
  async snapshot() {
    throw new Error("Unexpected Git call");
  },
  async integrationHead() { throw new Error("Unexpected Git call"); },
  async integrationReceipt() { throw new Error("Unexpected Git call"); },
  async integrateTask() {
    throw new Error("Unexpected Git call");
  },
};
test("用户通过 HTTP 创建自由会话，关闭服务后同一项目可读回历史与创建事件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-foundation-"));
  const open = async () => {
    const app = await createHttpServer({
      runtime,
      git,
      catalogPath: join(dir, "catalog.json"),
      projectRoot: dir,
    });
    await new Promise<void>((resolve) =>
      app.server.listen(0, "127.0.0.1", resolve),
    );
    return {
      app,
      url: "http://127.0.0.1:" + (app.server.address() as AddressInfo).port,
    };
  };
  let live = await open();
  try {
    const response = await fetch(live.url + "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "独立调查" }),
    });
    assert.equal(response.status, 201);
    const session = await response.json();
    const blocked = await fetch(live.url + "/api/sessions", {
      method: "POST",
      headers: {
        origin: "https://example.com",
        "content-type": "application/json",
      },
      body: '{"title":"不应写入"}',
    });
    assert.equal(blocked.status, 403);
    await live.app.close();
    live = await open();
    const state = await (await fetch(live.url + "/api/state")).json();
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].id, session.id);
    assert.equal(state.sessions[0].title, "独立调查");
    assert.equal(state.sessions[0].kind, "free");
    const events = await (
      await fetch(live.url + "/api/events?sessionId=" + session.id)
    ).json();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "session.created");
  } finally {
    await live.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
