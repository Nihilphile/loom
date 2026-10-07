import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyMetrics,
  type AppState,
  type Execution,
} from "../src/shared/types.ts";
import {
  filterExecutions,
  statistics,
  summarize,
  type StatsFilters,
} from "../web/statistics.ts";

const filters = (changes: Partial<StatsFilters> = {}): StatsFilters => ({
  graph: "",
  task: "",
  unit: "",
  session: "",
  model: "",
  status: "",
  from: "",
  to: "",
  group: "project",
  ...changes,
});
const execution = (changes: Partial<Execution> = {}): Execution => ({
  id: "execution-1",
  sessionId: "session-1",
  graphId: "graph-1",
  taskId: "task-1",
  unitId: "unit-1",
  purpose: "work",
  status: "completed",
  startedAt: "2026-10-08T00:00:00Z",
  model: "model-a",
  usageKnown: true,
  metrics: {
    ...emptyMetrics(),
    seconds: 2,
    toolCalls: 1,
    usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 },
  },
  ...changes,
});

test("cached input remains an input subset and unknown historical executions have explicit coverage", () => {
  const total = summarize([
    execution(),
    execution({ id: "legacy", usageKnown: undefined }),
    execution({ id: "legacy-missing", usageKnown: false, metrics: undefined }),
  ]);
  assert.deepEqual(total.usage, {
    inputTokens: 100,
    cachedInputTokens: 80,
    outputTokens: 20,
  });
  assert.equal(total.usage.inputTokens + total.usage.outputTokens, 120);
  assert.equal(total.known, 1);
  assert.equal(total.count, 3);
  assert.equal(summarize([execution({ usageKnown: undefined })]).known, 0);
});

test("model, status, date and scoped task filters apply before token aggregation", () => {
  const rows = [
    execution(),
    execution({ id: "other-graph", graphId: "graph-2" }),
    execution({ id: "other-model", model: "model-b" }),
    execution({ id: "failed", status: "failed" }),
    execution({ id: "earlier", startedAt: "2026-10-01T00:00:00Z" }),
  ];
  const selected = filterExecutions(
    rows,
    filters({
      task: "graph-1/task-1",
      unit: "graph-1/task-1/unit-1",
      model: "model-a",
      status: "completed",
      from: "2026-10-07T00:00:00Z",
      to: "2026-10-09T00:00:00Z",
    }),
  );
  assert.deepEqual(
    selected.map((row) => row.id),
    ["execution-1"],
  );
  assert.equal(summarize(selected).usage.inputTokens, 100);
  assert.deepEqual(
    filterExecutions(
      [execution({ model: undefined, graphId: undefined })],
      filters({ model: "unknown", graph: "free" }),
    ).map((row) => row.id),
    ["execution-1"],
  );
});

test("execution totals exclude session and unit lifetime totals", () => {
  const lifetime = {
    ...emptyMetrics(),
    usage: { inputTokens: 900, cachedInputTokens: 700, outputTokens: 300 },
  };
  const state: AppState = {
    project: { id: "project-1", name: "Project", path: "/project" },
    sessions: [
      {
        id: "session-1",
        title: "Session",
        kind: "task",
        status: "idle",
        messages: [],
        metrics: lifetime,
        turns: 5,
      },
    ],
    graphs: [
      {
        id: "graph-1",
        name: "Graph",
        status: "done",
        concurrency: 1,
        subscription: "completed",
        createdAt: "2026-10-08T00:00:00Z",
        tasks: [
          {
            id: "task-1",
            title: "Task",
            goal: "Goal",
            deps: [],
            newWorktree: true,
            status: "done",
            snapshots: [],
            submissions: [],
            round: 1,
            configRevision: 1,
            type: {
              id: "type",
              name: "Type",
              version: 1,
              units: [],
              start: [],
              rules: [],
              maxRounds: 1,
              maxReportRetries: 1,
            },
            units: [
              {
                id: "unit-1",
                name: "Unit",
                kind: "agent",
                skills: [],
                prompt: "",
                readOnly: false,
                sessionId: "session-1",
                status: "idle",
                metrics: lifetime,
                reportRetries: 0,
              },
            ],
          },
        ],
      },
    ],
    executions: [execution()],
    letters: [],
    agentTemplates: [],
    taskTypes: [],
    runtime: {
      name: "test",
      capabilities: { inject: true, interrupt: true, readOnly: true },
    },
  };
  const html = statistics(state, filters());
  const filteredSection = html.split(
    '<details class="panel spaced cumulative">',
  )[0];
  assert.match(filteredSection, /<div class="value">100<\/div>/);
  assert.match(filteredSection, /<div class="value">120<\/div>/);
  assert.doesNotMatch(filteredSection, /900/);
  assert.match(html, /<td>900<\/td>/);
  const unknown = statistics(
    { ...state, executions: [execution({ usageKnown: undefined })] },
    filters(),
  );
  assert.match(unknown, /用量已知 0 \/ 1 次执行/);
  assert.match(unknown, /用量未知，未按 0 计入/);
});
