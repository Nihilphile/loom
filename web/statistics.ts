import type { AppState, Execution, Usage, Session } from "../src/shared/types.ts";

export interface StatsFilters {
  graph: string;
  task: string;
  unit: string;
  session: string;
  model: string;
  status: string;
  from: string;
  to: string;
  group: string;
  purpose: string;
}
type Row = Omit<Execution, "tokenHash">;
const observer = (row: Row) =>
  row.purpose === "sidechat" || row.purpose === "interview";
const scope = (row: Row) =>
  observer(row) ? row.purpose : (row.graphId ?? "free");
const purposeNames: Record<Row["purpose"], string> = {
  chat: "自由会话",
  work: "任务执行",
  report: "汇报",
  mail: "信件",
  sidechat: "只读侧聊",
  interview: "开发者访谈",
};
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const fmt = (value: number) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
export function filterExecutions(rows: Row[], filter: StatsFilters) {
  const from = filter.from ? new Date(filter.from).getTime() : -Infinity;
  const to = filter.to ? new Date(filter.to).getTime() : Infinity;
  return rows.filter(
    (row) =>
      (!filter.graph || scope(row) === filter.graph) &&
      (!filter.task ||
        (!observer(row) && `${row.graphId}/${row.taskId}` === filter.task)) &&
      (!filter.unit ||
        (!observer(row) &&
          `${row.graphId}/${row.taskId}/${row.unitId}` === filter.unit)) &&
      (!filter.purpose || row.purpose === filter.purpose) &&
      (!filter.session || row.sessionId === filter.session) &&
      (!filter.model || (row.model ?? "unknown") === filter.model) &&
      (!filter.status || row.status === filter.status) &&
      new Date(row.startedAt).getTime() >= from &&
      new Date(row.startedAt).getTime() <= to,
  );
}
export function summarize(rows: Row[]) {
  rows = [...new Map(rows.map((row) => [row.id, row])).values()];
  const intervals = rows.flatMap((row) => {
    const start = Date.parse(row.startedAt), end = Date.parse(row.endedAt ?? "");
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [[start, end]] : [];
  }).sort((a, b) => a[0] - b[0]);
  let elapsedMs = 0, through = -Infinity;
  for (const [start, end] of intervals) {
    elapsedMs += Math.max(0, end - Math.max(start, through));
    through = Math.max(through, end);
  }
  const known = rows.filter((row) => row.usageKnown === true && row.metrics);
  const usage = known.reduce<Usage>(
    (sum, row) => ({
      inputTokens: sum.inputTokens + row.metrics!.usage.inputTokens,
      cachedInputTokens:
        sum.cachedInputTokens + row.metrics!.usage.cachedInputTokens,
      outputTokens: sum.outputTokens + row.metrics!.usage.outputTokens,
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  );
  return {
    usage,
    elapsedSeconds: elapsedMs / 1000,
    intervalsKnown: intervals.length,
    known: known.length,
    count: rows.length,
    seconds: rows.reduce((sum, row) => sum + (row.metrics?.seconds ?? 0), 0),
    calls: rows.reduce((sum, row) => sum + (row.metrics?.toolCalls ?? 0), 0),
    measured: rows.filter((row) => row.metrics).length,
  };
}
export function statistics(state: AppState, filter: StatsFilters) {
  const all = [...new Map((state.executions ?? []).map((row) => [row.id, row])).values()];
  const rows = filterExecutions(all, filter);
  const total = summarize(rows);
  const observerTotal = summarize(rows.filter(observer));
  const select = (
    key: keyof StatsFilters,
    label: string,
    values: { id: string; name: string }[],
  ) =>
    `<label class="field"><span>${label}</span><select data-stat-filter="${key}" id="stats-${key}"><option value="">全部</option>${values.map((v) => `<option value="${esc(v.id)}" ${filter[key] === v.id ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label>`;
  const groups = new Map<string, { label: string; rows: Row[] }>();
  for (const row of rows) {
    const g = state.graphs.find((g) => g.id === row.graphId);
    const t = g?.tasks.find((t) => t.id === row.taskId);
    const s = state.sessions.find((s) => s.id === row.sessionId);
    const u = t?.units.find((u) => u.id === row.unitId);
    const keys: Record<string, [string, string]> = {
      project: [
        state.project?.id ?? "project",
        state.project?.name ?? "当前项目",
      ],
      graph: [
        scope(row),
        observer(row)
          ? purposeNames[row.purpose]
          : (g?.name ?? row.graphId ?? "自由会话"),
      ],
      task: [
        `${row.graphId}/${row.taskId}`,
        t ? `${g?.name ?? g?.id} / ${t.title}` : (row.taskId ?? "自由会话"),
      ],
      unit: [
        `${row.graphId}/${row.taskId}/${row.unitId ?? row.sessionId}`,
        u
          ? `${t?.title} / ${u.name}`
          : (s?.title ?? row.unitId ?? row.sessionId),
      ],
      session: [row.sessionId, s?.title ?? row.sessionId],
    };
    if (observer(row)) {
      const label = `${purposeNames[row.purpose]} / ${s?.title ?? row.sessionId}`;
      keys.task = [row.sessionId, label];
      keys.unit = [row.sessionId, label];
    }
    const [key, label] = keys[filter.group] ?? keys.project;
    const group = groups.get(key) ?? { label, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  if (filter.group === "unit") {
    for (const [key, group] of [...groups]) {
      if (group.rows.some((row) => state.sessions.some((session) => session.id === row.sessionId && session.child))) {
        groups.set(key + "/own", { label: group.label + " · 自身", rows: group.rows.filter((row) => !state.sessions.some((session) => session.id === row.sessionId && session.child)) });
        group.label += " · 自身与后代";
      }
    }
  }
  const summaryCells = (data: ReturnType<typeof summarize>) =>
    `<td>${data.known ? fmt(data.usage.inputTokens) : "未知"}</td><td>${data.known ? fmt(data.usage.cachedInputTokens) : "未知"}</td><td>${data.known ? fmt(data.usage.outputTokens) : "未知"}</td><td>${data.known ? fmt(data.usage.inputTokens + data.usage.outputTokens) : "未知"}</td><td>${data.known} / ${data.count}</td><td>${data.measured ? fmt(data.seconds) + "s" : "未知"}</td><td>${data.intervalsKnown ? fmt(data.elapsedSeconds) : "未知"} (${data.intervalsKnown}/${data.count})</td><td>${data.measured ? fmt(data.calls) : "未知"}</td>`;
  const tokenHeaders =
    "<th>输入</th><th>缓存输入</th><th>输出</th><th>总 tokens</th><th>已知 / 执行数</th><th>累计 Agent 秒</th><th>区间并集秒（覆盖）</th><th>工具调用</th>";
  const modelValues = [
    ...new Set(all.map((row) => row.model ?? "unknown")),
  ].map((id) => ({ id, name: id === "unknown" ? "未知模型" : id }));
  const taskValues = state.graphs
    .filter((g) => !filter.graph || g.id === filter.graph)
    .flatMap((g) =>
      g.tasks.map((t) => ({
        id: `${g.id}/${t.id}`,
        name: `${g.name} / ${t.title}`,
      })),
    );
  const unitValues = state.graphs
    .filter((g) => !filter.graph || g.id === filter.graph)
    .flatMap((g) =>
      g.tasks
        .filter((t) => !filter.task || `${g.id}/${t.id}` === filter.task)
        .flatMap((t) =>
          t.units.map((u) => ({
            id: `${g.id}/${t.id}/${u.id}`,
            name: `${t.title} / ${u.name}`,
          })),
        ),
    );
  return `<div class="intro"><div><div class="eyebrow">${esc(state.project?.name)} / TOKENS</div><h1>执行统计</h1><p class="subtitle">筛选执行记录，再按层级汇总。缓存输入已包含在输入中。</p></div></div>
    <section class="panel stats-filters">
      ${select("graph", "Graph / 独立会话", [{ id: "free", name: "自由会话" }, { id: "sidechat", name: "只读侧聊" }, { id: "interview", name: "开发者访谈" }, ...state.graphs.map((g) => ({ id: g.id, name: g.name }))])}
      ${select("task", "Task", taskValues)}
      ${select("unit", "Unit", unitValues)}
      ${select(
        "session",
        "Session / Unit",
        state.sessions.map((s) => ({ id: s.id, name: s.title })),
      )}
      ${select("model", "模型", modelValues)}
      ${select(
        "purpose",
        "执行用途",
        Object.entries(purposeNames).map(([id, name]) => ({ id, name })),
      )}
      ${select(
        "status",
        "执行状态",
        [...new Set(all.map((row) => row.status))].map((id) => ({
          id,
          name: {
            starting: "启动中",
            running: "运行中",
            completed: "已完成",
            failed: "失败",
            interrupted: "已中断",
          }[id],
        })),
      )}
      <label class="field"><span>开始时间从</span><input type="datetime-local" id="stats-from" data-stat-filter="from" value="${esc(filter.from)}"></label>
      <label class="field"><span>开始时间至</span><input type="datetime-local" id="stats-to" data-stat-filter="to" value="${esc(filter.to)}"></label>
      <label class="field"><span>汇总层级</span><select id="stats-group" data-stat-filter="group">${Object.entries(
        {
          project: "项目",
          graph: "Graph",
          task: "Task",
          unit: "Unit",
          session: "Session",
        },
      )
        .map(
          ([id, label]) =>
            `<option value="${id}" ${filter.group === id ? "selected" : ""}>${label}</option>`,
        )
        .join("")}</select></label>
      <button class="btn small" data-action="reset-stats">清除筛选</button>
    </section>
    <div class="metrics">${[
      ["输入 TOKENS", total.usage.inputTokens],
      ["缓存输入 TOKENS", total.usage.cachedInputTokens],
      ["输出 TOKENS", total.usage.outputTokens],
      [
        "总 TOKENS · 输入 + 输出",
        total.usage.inputTokens + total.usage.outputTokens,
      ],
    ]
      .map(
        ([label, value]) =>
          `<div class="metric"><label>${label}</label><div class="value">${total.known ? fmt(Number(value)) : "未知"}</div></div>`,
      )
      .join("")}</div>
    <p class="notice spaced">用量已知 ${total.known} / ${total.count} 次执行。${total.count - total.known ? `${total.count - total.known} 次执行的用量未知，未按 0 计入。显示的总量仅含已知记录。` : "全部筛选记录均有用量数据。"} 时间和工具调用覆盖 ${total.measured} / ${total.count} 次执行。并行执行时间相加，不等于经过时间。</p>
    <p class="notice spaced">侧聊与访谈开销已包含在项目总量中，不计入来源 Unit。当前筛选内 ${observerTotal.count} 次独立执行，${observerTotal.known ? `${fmt(observerTotal.usage.inputTokens + observerTotal.usage.outputTokens)} 个已知 tokens` : "token 用量未知"}，${observerTotal.known} / ${observerTotal.count} 次有用量记录。</p>
    <section class="panel scroller spaced"><div class="panelhead"><strong>分组汇总</strong></div><table class="table"><thead><tr><th>分组</th>${tokenHeaders}</tr></thead><tbody>${[...groups.values()].map((group) => `<tr><td>${esc(group.label)}</td>${summaryCells(summarize(group.rows))}</tr>`).join("") || '<tr><td colspan="8">没有符合筛选条件的执行记录。</td></tr>'}</tbody></table></section>
    <section class="panel scroller spaced"><div class="panelhead"><strong>每次执行 · ${rows.length}</strong></div><table class="table"><thead><tr><th>执行 / Session</th><th>Graph / Task / Unit</th><th>模型 / 推理</th><th>状态 / 用途</th><th>开始 / 结束</th>${tokenHeaders}</tr></thead><tbody>${
      rows
        .slice()
        .reverse()
        .map(
          (row) =>
            `<tr><td><details data-detail="execution-${esc(row.id)}"><summary><code>${esc(row.id)}</code></summary><pre>${esc(JSON.stringify(row, null, 2))}</pre></details><button data-session="${esc(row.sessionId)}">${esc(state.sessions.find((s) => s.id === row.sessionId)?.title ?? row.sessionId)}</button></td><td>${esc(observer(row) ? purposeNames[row.purpose] : [row.graphId, row.taskId, row.unitId].filter(Boolean).join(" / ") || "自由会话")}</td><td>${esc(row.model ?? "未知")} / ${esc(row.reasoning ?? "未知")}</td><td>${esc(row.status)} / ${esc(purposeNames[row.purpose])}</td><td>${esc(new Date(row.startedAt).toLocaleString())}<br>${row.endedAt ? esc(new Date(row.endedAt).toLocaleString()) : "尚未结束"}</td>${summaryCells(summarize([row]))}</tr>`,
        )
        .join("") || '<tr><td colspan="12">暂无执行记录。</td></tr>'
    }</tbody></table></section>
    <details class="panel spaced cumulative" data-detail="cumulative-totals"><summary>会话历史累计 · 不受上方筛选影响</summary><p class="tiny muted">历史累计值单独展示，不与执行记录相加。旧记录可能没有逐次执行或模型归属。</p><div class="scroller"><table class="table"><thead><tr><th>Session</th><th>轮次</th><th>输入</th><th>缓存输入</th><th>输出</th><th>时间</th><th>工具调用</th></tr></thead><tbody>${state.sessions.map((s) => `<tr><td><button data-session="${esc(s.id)}">${esc(s.title)}</button></td><td>${s.turns}</td><td>${fmt(s.metrics.usage.inputTokens)}</td><td>${fmt(s.metrics.usage.cachedInputTokens)}</td><td>${fmt(s.metrics.usage.outputTokens)}</td><td>${fmt(s.metrics.seconds)}s</td><td>${s.metrics.toolCalls}</td></tr>`).join("")}</tbody></table></div></details>`;
}
