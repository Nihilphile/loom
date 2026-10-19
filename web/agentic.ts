import type { AppState, DelegationPolicy, Session } from "../src/shared/types.ts";
import { summarize } from "./statistics.ts";

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function sessionError(session: Session) {
  return session.error ? `<div class="notice amber">${esc(session.error)}</div>` : "";
}

export function sessionSubtree(sessions: Session[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (session.child && ids.has(session.child.parentSessionId) && !ids.has(session.id)) {
        ids.add(session.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function sessionMetrics(state: Pick<AppState, "sessions" | "executions">, sessionId: string) {
  const ids = sessionSubtree(state.sessions, sessionId);
  const rows = state.executions ?? [];
  return {
    own: summarize(rows.filter((row) => row.sessionId === sessionId)),
    subtree: summarize(rows.filter((row) => ids.has(row.sessionId))),
  };
}

export function delegationLabel(policy?: DelegationPolicy) {
  return policy?.enabled ? `允许派工 · 深度 ${policy.maxDepth} · 并发 ${policy.maxConcurrent}${policy.models ? ` · 模型 ${policy.models.join(", ") || "无"}` : ""}` : "派工已禁用";
}

export function delegationFields(policy?: DelegationPolicy, prefix = "") {
  return `<fieldset class="delegation-fields"><legend>Agent 派工</legend><label class="checkrow"><input type="checkbox" name="${prefix}delegation" ${policy?.enabled ? "checked" : ""}>允许创建子会话</label><div class="grid2"><label class="field"><span>最大层级深度</span><input type="number" name="${prefix}depth" min="1" step="1" value="${policy?.enabled ? policy.maxDepth : 3}"></label><label class="field"><span>最大并发子会话</span><input type="number" name="${prefix}concurrent" min="1" step="1" value="${policy?.enabled ? policy.maxConcurrent : 4}"></label></div><label class="field"><span>允许的模型 ID（逗号分隔，留空使用运行时可用模型）</span><input name="${prefix}models" value="${esc(policy?.enabled ? policy.models?.join(", ") : "")}"></label><p class="hint">子会话继承配置，只能收窄权限。可写输出需要整合后才能交卷。</p></fieldset>`;
}

export function readDelegation(form: Element, prefix = ""): DelegationPolicy {
  if (!form.querySelector<HTMLInputElement>(`[name="${prefix}delegation"]`)?.checked) return { enabled: false };
  const number = (key: string) => Number(form.querySelector<HTMLInputElement>(`[name="${prefix}${key}"]`)?.value);
  const maxDepth = number("depth"), maxConcurrent = number("concurrent");
  if (![maxDepth, maxConcurrent].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("派工深度和并发必须是正整数");
  const models = form.querySelector<HTMLInputElement>(`[name="${prefix}models"]`)?.value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
  return { enabled: true, maxDepth, maxConcurrent, ...(models?.length ? { models } : {}) };
}

export function sessionTree(state: Pick<AppState, "sessions">, rootId: string) {
  const visited = new Set<string>();
  const render = (id: string): string => {
    if (visited.has(id)) return "";
    visited.add(id);
    const session = state.sessions.find((s) => s.id === id);
    if (!session) return "";
    const children = state.sessions.filter((s) => s.child?.parentSessionId === id);
    return `<li><button class="btn small" data-open-session="${esc(id)}">${esc(session.title)}</button> <span class="badge">${esc(session.child?.state ?? session.status)}</span>${session.child ? ` <span class="tiny">${session.child.access === "write" ? "可写" : "只读"} · 输出 ${esc(session.child.output)}</span>` : ""}${children.length ? `<ul>${children.map((child) => render(child.id)).join("")}</ul>` : ""}</li>`;
  };
  return `<ul class="agentic-tree">${render(rootId)}</ul>`;
}

export function agenticSession(state: Pick<AppState, "sessions" | "executions">, session: Session) {
  const metrics = sessionMetrics(state, session.id);
  const child = session.child;
  const rows = (state.executions ?? []).filter((row) => row.sessionId === session.id);
  const format = (data: ReturnType<typeof summarize>) => `<td>${data.known ? data.usage.inputTokens : "未知"}</td><td>${data.known ? data.usage.cachedInputTokens : "未知"}</td><td>${data.known ? data.usage.outputTokens : "未知"}</td><td>${data.known}/${data.count}</td><td>${data.measured ? data.seconds.toFixed(1) : "未知"}</td><td>${data.measured ? data.calls : "未知"} (${data.measured}/${data.count})</td><td>${data.intervalsKnown ? data.elapsedSeconds.toFixed(1) : "未知"} (${data.intervalsKnown}/${data.count})</td>`;
  return `<details class="session-context" data-detail="agentic-${esc(session.id)}" open><summary>会话归属与执行记录</summary><div class="rule">原生 Thread <code>${esc(session.threadId ?? "尚未创建")}</code></div>${child ? `<div class="rule">父会话 <button class="btn small" data-open-session="${esc(child.parentSessionId)}">${esc(child.parentSessionId)}</button> · 深度 ${child.depth} · ${esc(child.state)}</div><div class="rule">权限 ${child.access === "write" ? "可写" : "只读"} · 工作目录 ${esc(child.workspace.path)}</div><div class="rule">输出 ${esc(child.output)} · ${esc(child.outputSha ?? "")} · 结果执行 ${esc(child.resultExecutionId ?? "尚无结果")}</div>${child.error ? `<p class="notice amber">${esc(child.error)}</p>` : ""}` : ""}${session.graphId && session.taskId && session.unitId ? `<button class="btn small" data-session-unit="${esc(session.id)}">Unit ${esc(`${session.graphId}/${session.taskId}/${session.unitId}`)}</button>` : ""}<details><summary>有效配置</summary><pre class="jsondetail">${esc(JSON.stringify(session.acceptedConfig ?? { model: session.model, reasoning: session.reasoning, status: "等待运行时接收配置" }, null, 2))}</pre></details>${sessionTree(state, session.id)}<div class="scroller"><table class="table"><thead><tr><th>范围</th><th>输入</th><th>缓存输入</th><th>输出</th><th>用量覆盖</th><th>累计 Agent 秒</th><th>工具调用（覆盖）</th><th>区间并集秒（覆盖）</th></tr></thead><tbody><tr><td>自身</td>${format(metrics.own)}</tr><tr><td>自身与后代</td>${format(metrics.subtree)}</tr></tbody></table></div><p class="hint">仅累计唯一执行记录。未知用量不按零计算。区间并集只计算已结束且时间有效的执行；并行 Agent 秒相加。</p><details><summary>每次执行与结果 · ${rows.length}</summary>${rows.map((row) => `<details ${child?.resultExecutionId === row.id ? "open" : ""}><summary>${esc(row.id)} · ${esc(row.status)}${child?.resultExecutionId === row.id ? " · 子任务结果" : ""}</summary><pre class="jsondetail">${esc(JSON.stringify(row, null, 2))}</pre></details>`).join("") || '<p class="hint">尚无执行记录</p>'}</details></details>`;
}
