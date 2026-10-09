# Agentic configuration and session inspection

The personal library includes the `agentic` Agent template and the `agentic-reviewed` TaskType. The TaskType starts an Agentic worker and activates a separate readonly reviewer after delivery. Child reviews do not replace that reviewer. Missing built-ins are added when loading an existing catalog; saved entries with the same ID keep their customizations.

Enable delegation in an Agent template or in the per-Unit controls below the TaskType JSON editor. Configure maximum depth, concurrent children, and optional model IDs. Delegation is disabled when omitted. The built-in Agentic configuration permits depth 3 and concurrency 4. Saving a template or TaskType does not rewrite existing Task snapshots. The per-Unit controls override the matching Unit's `delegation` in the JSON editor; new Units can declare it directly in JSON.

Task members and the Sessions page show nested children. Open a child to inspect its parent, owning Unit, native thread ID, state, work directory, access, accepted configuration, output state, result execution, conversation, tools, and preparation history. Parent and Unit buttons navigate back to their respective views. Task and child sessions remain scheduler-managed.

The session detail shows separate own and subtree totals from unique execution IDs. Repeated child turns count as separate executions. Input includes cached input. Unknown token usage is excluded from the numeric subtotal and retained in the coverage count. Agent seconds sum measured execution durations. Interval-union seconds merge overlapping execution intervals and include only valid completed intervals, with separate coverage. They describe active execution time, not end-to-end task latency including idle gaps. Statistics grouped by Unit show own and subtree rows when children exist; observer sessions remain independent of their source Unit.

## Agent tool

Task agents with delegation enabled receive the native dynamic tool `loom_agent`. Loom binds each call to its current execution. The caller supplies the work. Loom supplies the parent identity, Unit ownership, inherited skills and settings, restricted access, and isolated Git workspace. Optional model and reasoning overrides must exist in the runtime catalog and obey the Unit's allowed models. Child prompts start with the requested work and inherited skill material; they do not copy the parent's conversation or report credentials.

```json
{"op":"spawn","requestId":"inspect-api","title":"Inspect API","prompt":"Inspect the API contract and report mismatches.","access":"read"}
```

`access` can be `read` or `write`. Omission inherits the parent's access. Readonly children cannot create writers. `model` and `reasoning` are optional overrides. A child may delegate within the same Unit depth and concurrency limits. Active and waiting child jobs share that concurrency budget across the entire Unit.

| Operation | Arguments | Result |
| --- | --- | --- |
| `spawn` | `requestId`, `title`, `prompt`, optional `access`, `model`, `reasoning` | Registered child session and state |
| `send` | `requestId`, `sessionId`, `prompt` | New execution on the same child's native thread |
| `list` or `wait` | Optional `sessionIds` | Direct child snapshots under `children` |
| `integrate` | `requestId`, `sessionId`, `executionId` | Exact completed output merged into the immediate parent workspace |
| `discard` | `requestId`, `sessionId`, `executionId` | Stopped child subtree abandoned, with worktrees retained |
| `cancel` | `sessionId` | Child and registered descendants interrupted |

`wait` returns a snapshot immediately. When children are still running, the parent should end its turn. Loom persists their results and resumes the same parent thread once results arrive. Do not repeatedly poll. Reading completed results through `list` or `wait` consumes their notices and suppresses redundant automatic continuation. Readonly results require no separate acceptance command.

Snapshots include `sessionId`, `threadId`, `parentSessionId`, `state`, `workspace`, `config`, `executionId`, `resultExecutionId`, `result`, `output`, `outputSha`, `metrics`, and `usageKnown`. `executionId` identifies the latest result execution. Use that exact value for `integrate` or `discard`; a stale execution ID is rejected. Credentials are absent. `usageKnown: false` means unmeasured usage, not zero tokens.

Keep each mutation's `requestId` stable when retrying the same request. Reusing it with different arguments fails. A completed retry returns its original receipt. A failed or interrupted request returns its recorded failure; inspect the registered child before issuing a new request ID. Resolve writable output before sending another turn to that child. Integration conflicts remain in the immediate parent's workspace. Resolve and stage the conflict there, then retry integration with a new request ID and the same exact child execution ID. Discard does not undo an integration that already succeeded.

Only direct parents control children. A Unit report is rejected while descendants are active, uncertain, waiting for continuation, or have pending writable output. A successful report seals that execution against further delegation. When all descendants and outputs settle, normal TaskType rules activate the outer reviewer. Internal child reviews cannot bypass it.

## Pause and recovery

Soft pause drains turns already accepted by the runtime. It starts no new child or parent turns, and it retains result notices until resume. Hard pause interrupts registered descendants as well as the Unit's main session. Cancel also interrupts the selected child subtree. Writable output remains pending until explicit integration or discard; cancellation alone does not accept or abandon changes.

After a service restart, Loom retains child IDs, native thread IDs, workspaces, operation receipts, and output identities. Affected graphs pause. It does not recreate children or replay inputs whose acceptance is uncertain. Inspect the session's preparation history and resolve an uncertain receipt before resuming or discarding that work. The parent can then use `send` to continue the same child thread. Generic chat endpoints cannot launch Task child sessions directly.

Task and observer sessions disable Codex's native multi-agent tools so Loom owns their descendants. Free chat keeps its existing native behavior. This tool boundary does not claim to protect a local service from arbitrary hostile shell or network requests. No push, pull request, or full pstack workflow is implicit in Agentic configuration.
