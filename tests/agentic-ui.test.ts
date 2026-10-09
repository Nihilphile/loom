import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/server/catalog.ts";
import { validateDelegation, validateType } from "../src/server/validation.ts";
import { emptyMetrics, type Execution, type Session } from "../src/shared/types.ts";
import { agenticSession, sessionMetrics, sessionTree } from "../web/agentic.ts";

test("existing catalogs gain Agentic without replacing customized entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-catalog-"));
  try {
    const file = join(dir, "catalog.json");
    const defaults = new Catalog(file);
    defaults.taskTypes.forEach(validateType);
    const custom = { ...defaults.agents.find((a) => a.id === "agentic")!, prompt: "custom", delegation: { enabled: false as const } };
    writeFileSync(file, JSON.stringify({ agents: [custom], taskTypes: [defaults.taskTypes[0]] }));
    const catalog = new Catalog(file);
    assert.deepEqual(catalog.agents.find((a) => a.id === "agentic"), custom);
    const reviewed = catalog.taskTypes.find((t) => t.id === "agentic-reviewed")!;
    assert.equal(reviewed.units[0].delegation?.enabled, true);
    assert.equal(reviewed.units[1].readOnly, true);
    assert.equal(reviewed.units[1].delegation?.enabled ?? false, false);
    assert.deepEqual(reviewed.rules.find((r) => r.from === "worker" && r.outcome === "ready")?.action, { type: "activate", unit: "reviewer" });
    catalog.save();
    assert.equal(new Catalog(file).agents.filter((a) => a.id === "agentic").length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delegation limits reject malformed policies and accept disabled default", () => {
  for (const policy of [null, [], { enabled: "yes" }, { enabled: true }, { enabled: true, maxDepth: 0, maxConcurrent: 1 }, { enabled: true, maxDepth: 1, maxConcurrent: 1.5 }, { enabled: true, maxDepth: 1, maxConcurrent: 2, models: [""] }]) assert.throws(() => validateDelegation(policy));
  for (const policy of [undefined, { enabled: false }, { enabled: true, maxDepth: 2, maxConcurrent: 4, models: ["model"] }]) assert.doesNotThrow(() => validateDelegation(policy));
});

const session = (id: string, parent?: string): Session => ({
  id, title: id, kind: "task", status: "idle", messages: [], metrics: emptyMetrics(), turns: 1,
  ...(parent ? { child: { parentSessionId: parent, depth: 1, state: "finished", access: "read", output: "none", workspace: { path: "work", branch: "branch", baseCommit: "sha" }, resultExecutionId: id + "-run" } } : {}),
});
const execution = (id: string, sessionId: string, start: number, end: number): Execution => ({
  id, sessionId, purpose: "work", status: "completed", startedAt: new Date(start * 1000).toISOString(), endedAt: new Date(end * 1000).toISOString(), usageKnown: true,
  metrics: { ...emptyMetrics(), seconds: end - start, toolCalls: 2, usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 } },
});

test("own and subtree ledger totals deduplicate executions, include continuations, and retain unknown coverage", () => {
  const main = execution("main-run", "main", 0, 10);
  const state = {
    sessions: [session("main"), session("child", "main"), session("grandchild", "child"), session("observer")],
    executions: [main, main, execution("child-run", "child", 5, 15), execution("child-continue", "child", 20, 25), { ...execution("grandchild-run", "grandchild", 8, 12), metrics: undefined, usageKnown: false }, execution("observer-run", "observer", 0, 40)],
  };
  const totals = sessionMetrics(state, "main");
  assert.equal(totals.own.count, 1);
  assert.equal(totals.subtree.count, 4);
  assert.equal(totals.subtree.known, 3);
  assert.equal(totals.subtree.usage.inputTokens, 30);
  assert.equal(totals.subtree.seconds, 25);
  assert.equal(totals.subtree.elapsedSeconds, 20);
  assert.equal(totals.subtree.calls, 6);
  const view = agenticSession(state, state.sessions[1]);
  assert.match(view, /父会话/);
  assert.match(view, /child-run/);
  assert.match(view, /grandchild/);
  assert.match(view, /有效配置/);
  assert.doesNotMatch(view, /observer-run/);
});

test("tree escapes session titles and terminates on corrupt cycles", () => {
  const first = session("first", "second"), second = session("second", "first");
  first.title = '<script>"bad"</script>';
  const html = sessionTree({ sessions: [first, second] }, "first");
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal((html.match(/data-open-session=/g) ?? []).length, 2);
});
