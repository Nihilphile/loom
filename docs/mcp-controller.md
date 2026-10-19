# Desktop controller MCP

`loom` connects a Desktop controller to one Loom project and one free session. Engine continues to schedule Tasks and Units, accept their existing CLI reports, run independent review, and integrate deliveries. This MCP does not run Units or manage child agents.

## Architecture and ownership

```text
Codex Desktop -> loom stdio MCP -> localhost project HTTP -> HarnessEngine -> ProjectStore
                                                        -> existing Task scheduler / Runtime
```

`src/mcp-controller.ts` uses the official SDK. It sends typed requests to `POST /api/projects/<projectId>/controller/<sessionId>`. It imports no Engine, SQLite, file reader, or process launcher. `src/shared/controller.ts` defines strict input schemas shared by HTTP and MCP. Every tool uses the fixed project and session from process arguments.

Engine is the only state writer. `Session.executionOwner` distinguishes `{kind:"loom"}` from `{kind:"external",client:"desktop"}`. Missing legacy ownership normalizes to Loom. Private `ProjectState.controllerAccess` holds a key hash and mutation receipts and is excluded from `Engine.view()`.

An existing target must be an idle or failed free session. Binding rejects Task, child, observer, interrupted, and active sessions, pending turn validation or delivery, uncertain input acceptance, pending source-thread forks, and a surviving previous Loom process. Binding saves ownership, authentication, and `queuePaused=true` together. Queued user input remains visible and frozen. Historical messages, native thread identity, and execution evidence remain intact.

Native thread identity is checked across the project, not just the target Session UUID. Creating, binding, or reconnecting a controller refuses a thread recorded by another Session or any of its historical Executions. Connect the original idle/failed free Session UUID to transfer an existing Loom conversation safely. Rejected aliases do not create a partial Session or credential record. Loom's launch guard also checks external thread ownership, and Runtime events, acceptance receipts, completion results, and explicit preparation resolution cannot assign a known external thread to a Loom Session.

Successful takeover clears the Session's current error and presents it as idle with external ownership. Historical Execution status and error remain unchanged. The current conversation warning therefore disappears while historical failure evidence remains available.

An observer created before binding must recheck source ownership whenever it still needs a source fork. A native thread ID alone does not establish independence: a rejected first turn can leave that ID without accepted configuration. Binding, the ownership guard, and Runtime dispatch share the same fork condition. An observer with accepted configuration on its own native thread remains independent. Ordinary chat, queue, steer, continue, interrupt, and new observer requests cannot control the external session. Automatic queue and Mailbox paths return without dispatch. A final guard in `launch` refuses external ownership before creating an execution.

Disconnect and restart preserve external ownership. There is no implicit handback, credential rotation, or unbind operation in this version. Reconnect uses the same session UUID and key. Existing native thread identity cannot be changed by reconnect.

The HTTP key is separate from Unit Bearer credentials. Controller routes reject missing, wrong, and mixed credentials. Controller keys cannot be used on ordinary HTTP routes. The local HTTP server remains a same-user trust boundary; this is not a sandbox against processes that already control the Loom host. First binding establishes its controller key.

## Tools and limits

All tools reject unknown fields. IDs are validated. No tool accepts a URL, arbitrary HTTP body, inline TaskType, command, file path, Unit report, or child-agent operation.

| Tool | Input and result |
|---|---|
| `loom_connect` | Optional `create` (default false), `title`, and `threadId`. Bind the configured existing session, or explicitly create the configured UUID. Returns its identity and external owner. |
| `loom_state` | Optional `graphId`. Without it, page through owned graph summaries with `after` and `limit`. With it, read task/Unit statuses, report references, block reasons, and delivery receipts. |
| `loom_task_types` | Page through existing TaskTypes with `after` and `limit`. Shows IDs, versions, roles, rules, and limits. Does not expose executable commands or change the catalog. |
| `loom_graph_create` | `requestId`, `name`, `tasks`, optional `concurrency` and `subscription`. Task fields are `id`, `title`, `goal`, `deps`, and an existing `taskTypeId`. Returns `graphId`. Ownership and retry receipt commit with the graph. |
| `loom_graph_control` | `graphId`, `action` (`run`, `pause`, `resume`, `resolve`). `mode` is only for pause, `taskId` only for resolve. Loom performs its normal scheduling. Returns graph status. |
| `loom_reports` | Required `graphId`. List report references, or provide `reportId` and `offset` for content. A submission is distinct from a published delivery receipt. |
| `loom_inbox` | Optional `graphId`. Lists pending controller Letters. `includeAcknowledged` includes historical acknowledged/injected deliveries. `letterId` and `offset` read content. |
| `loom_ack` | Required `graphId` and `letterId`. Acknowledge precisely one addressed Letter. Returns the original acknowledgement time on retries. |
| `loom_send_feedback` | `requestId`, `graphId`, `taskId`, agent `unitId`, `title`, `content`, optional `mode`. Engine fixes the sender and snapshots an ordinary Mailbox Letter. Default `followup` uses existing Mailbox semantics. |

Pages default to 20 items, with a maximum of 50. Content windows contain at most 16,000 UTF-16 code units and return `totalLength` and `nextOffset`. Graph creation accepts at most 100 Tasks and concurrency 1–8. Goals and feedback are limited to 64,000 characters. Letter titles allow 20 Unicode code points. Existing catalog validation still determines valid TaskTypes.

Graph, report, recipient, and acknowledgement operations verify ownership on every call. An inbox may aggregate this controller's graphs, but each item includes `graphId`. Cross-graph acknowledgement and report IDs are rejected before mutation.

## Notifications and retries

Notifications first persist as existing Letters. Reading does not reserve, inject, or acknowledge them, including while a graph is paused. `loom_ack` changes this controller's delivery to `acknowledged`, records its first timestamp, and commits the event. Retrying produces no duplicate event and does not consume newer Letters. Page cursors resolve against the stable owned-letter sequence before acknowledged deliveries are filtered, so acknowledging a page does not invalidate its continuation, including after restart. Existing Unit deliveries retain `queued` and `injected` semantics.

`graph_create` and `send_feedback` require a `requestId`. Receipts are scoped to controller and operation. Repeating validated arguments returns the original graph or Letter ID; changed arguments with the same ID fail. The receipt commits with its effect before delivery starts. Feedback files have deterministic identities under Engine's reports directory, so a crash before commit can safely retry.

MCP returns tool failures with `isError:true` and a JSON error in `structuredContent` and text. Codes include `FORBIDDEN`, `INVALID_ARGUMENT`, `OWNERSHIP_CONFLICT`, `REQUEST_CONFLICT`, `HTTP_TIMEOUT`, and `HTTP_UNAVAILABLE`. SDK schema validation also returns `isError`. HTTP requests time out after 15 seconds and refuse redirects. A lost response can follow a completed mutation: inspect state or retry the same mutation ID. Graph controls follow existing lifecycle semantics and are not advertised as idempotent.

This version uses active reads and polling. MCP does not wake the Desktop model from the background. A typical flow is connect, query types, create/run, poll state/inbox, read the report, send feedback if needed, and acknowledge the specific notice after handling it.

## Desktop registration

Register the server as exactly `loom`. [OpenAI's MCP configuration documentation](https://developers.openai.com/codex/mcp) describes stdio `command`, `args`, `env`, and `enabled` settings. The example is an operator action after independent acceptance; this task does not change global configuration.

```toml
[mcp_servers.loom]
command = 'C:\Program Files\nodejs\node.exe'
args = ['F:\path-to-reviewed-candidate\dist\mcp-controller.js', '--port', '4318', '--project', '<24-character-project-id>', '--session', '<free-session-uuid>']
enabled = true

[mcp_servers.loom.env]
LOOM_CONTROLLER_KEY = '<private-random-key-of-at-least-32-characters>'
```

Generate and retain a private random key locally. Do not paste it into chat, command arguments, reports, or repository files. The example contains placeholders, not usable credentials. Choose the project deterministically from the existing local `/api/projects` listing by its project path. Choose an existing free session UUID, or generate a UUID and explicitly call `loom_connect({create:true,title:"Desktop controller"})`.

The standalone command is:

```powershell
node <reviewed-candidate>/dist/mcp-controller.js --port 4318 --project <project-id> --session <free-session-uuid>
```

The launcher must supply `LOOM_CONTROLLER_KEY` privately. No `HARNESS_*` identity is used. Startup refuses an inherited Unit `HARNESS_TOKEN` as a second check. The example uses the controller-reported recovery port `4318`; select the actual accepted service port explicitly. The adapter defaults to `4317` only when the port argument is omitted and does not discover a running service.

Runtime explicitly sets `mcp_servers.loom.enabled=false` for every Task, child, and observer, at both app-server startup and thread start/resume/fork. This does not rely on `HARNESS_*`, which child environment filtering removes. Task and child execution retain other MCP configuration, `loom_agent`, and CLI report. Observers retain their existing stricter isolation and `loom_observer`. Other registration names are not aliases for this feature and must not be used.

## SDK and reproducible verification

The [official SDK main documentation](https://github.com/modelcontextprotocol/typescript-sdk) uses the v2 split packages. npm registry checks on 2026-10-20 returned `2.3.1` for both server and client. This candidate fixes `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/client@2.3.1`, and `zod@4.6.7`, with a lockfile. Server imports use `@modelcontextprotocol/server` and `/stdio`; the acceptance test uses `Client` and `StdioClientTransport` from the corresponding client packages. No v1 API or handwritten MCP protocol is added.

Run from this candidate workspace on Node 24 or newer:

```powershell
npm ci
npm run typecheck
npm test
npm run build
node --experimental-transform-types --test --test-isolation=none tests/mcp-controller.test.ts
```

The last command is also an independent way to run the official SDK stdio fixture. It creates temporary Git projects and a fake Runtime; it never calls a real model or uses production graphs. Tests exercise initialize, tools/list, tools/call, structured errors, redirects, timeout, graph creation, command execution, published delivery, report reads, pause/resume/resolve, graph isolation, inbox reconnect, and explicit retryable acknowledgement. `tests/controller.test.ts` additionally covers binding races, frozen queues, restart receipts, and ordinary entry-point refusal. `tests/runtime.test.ts` checks the actual fake app-server startup arguments and native thread configuration for isolation.

### Recorded results in the managed M01 environment

The mandatory full verification gate is **not yet passed**. The controller's Mailbox instruction `487c7faf-1165-40f9-be87-b3faa6b803c4` assigns full tests, build, and native compatibility verification to an independent acceptance worktree after this worker freezes the reviewed candidate. Worker handoff can be ready for that review without claiming those checks passed. Do not deploy on the basis of partial results.

| Check | Actual result |
|---|---|
| `npm run typecheck` | Passed. |
| Direct Node behavior run across controller, session, preparation, Agentic, UI helpers, HTTP foundation, statistics, attachments | Revised candidate: 57 passed, 0 failed. Includes active/idle/historical native aliases, unique identity reconnect, identity updates, and failed takeover public state/current warning/history. Previous candidate: 53 passed. |
| `npm test` | Blocked by Windows `spawn EPERM` while Node creates test-runner pipes. |
| `npm run build` | Server TypeScript emitted; Vite failed with `spawn EPERM`. The same failure occurred before implementation. |
| Official SDK `StdioClientTransport` test | Executed and failed at process pipe creation with `spawn EPERM`, before initialize. |
| Complete Git/HTTP/Engine/MCP fixture | Executed and failed at Git subprocess pipe creation with `spawn EPERM`. |
| Direct shell-to-stdio initialize, tools/list, tools/call | Passed against the source server: protocol `2025-11-25`, server `loom`, exactly 9 tools, JSON-only stdout. A state call to a deliberately closed fixture port returned `isError:true` with `HTTP_UNAVAILABLE`. This is not a substitute for the official SDK client gate. |

Raw logs are in `.newharness/reports/worker/`: `typecheck.log`, `npm-test.log`, `build.log`, `behavior-tests.log`, `final-behavior-tests.log`, `controller-final.log`, `preflight-observer-red.log`, `preflight-regressions.log`, `sdk-stdio.log`, and `shell-stdio.jsonl`. The observer regression failed before its fix with `Missing expected rejection`, then passed after the fix. The worker report records the final check outputs and review status. The operator-supplied pre-change baseline of 100 pass / 3 real-Codex skips is historical evidence, not a claimed candidate result.

The revised candidate's logs use the `reviewer-repair-` prefix in that same directory. Its typecheck passed and its 57 behavior checks passed. Fresh `npm test`, build, and official SDK attempts still failed at `spawn EPERM`; these are not passes. The four new regressions first failed with missing ownership rejection, an incorrectly successful execution, and the retained current writer error. The revision report and separate revision manifest identify the new handoff.

The outer reviewer reported full desktop-environment gates for previous candidate `15152c4094929780239554eff522a1f2bcafcd5a`: install, typecheck, build, and 115 tests with 112 passing, zero failures and three existing real-Codex skips. That evidence includes official SDK stdio and HTTP/Engine/Git delivery. Its native-client probe discovered all nine tools with zero model turns and without touching the current Desktop thread. Those are operator/reviewer evidence for the previous candidate and do not validate the subsequent R1/R2 changes. Repeat full gates on the revised exact candidate before acceptance.

## Deploy this candidate after acceptance

1. Run the mandatory checks in an environment that permits ordinary local Node process pipes. Require the standard SDK stdio test, complete command delivery fixture, full test suite, and build to pass. Have the outer Task reviewer independently check scope, thread ownership, Runtime isolation, and the evidence.
2. Integrate the reviewed Task candidate through Loom's existing workflow. Build the accepted source into a separate candidate installation. Do not copy a task worktree's SQLite database, project lock, catalog, or private key into the running installation.
3. The operator chooses a service maintenance point and updates Loom using the accepted build. This task does not stop, restart, or replace the current service. Inspect active execution and uncertain preparation state before binding an existing free session; do not delete locks or kill Desktop.
4. Register the reviewed `dist/mcp-controller.js` using the `loom` example, with the exact local project and free session identities. The incident session is `ef91c3a6-b472-4cb7-b0bc-d3d65abd4756`, native thread `01a15519-d0d1-7822-85fc-21498b3f41e7`. These are identity references, not an instruction to mutate the production graph during testing.
5. From Desktop, call connect without `create` for an existing session, inspect its external ownership, and read its inbox. Existing graph controller associations and queued notices remain. Acknowledge only notices actually handled. Verify the UI shows external ownership and offers no local send/continue/observer controls.

The key has no recovery/rotation endpoint in this version. Keep it safe. A server update is required for Engine ownership enforcement; registering the adapter against an old server does not provide the new boundary. No deployment or global registration has been performed by this task.

SSE backpressure is explicitly outside M01 and belongs to dependent Task M02. This candidate does not alter stream writes or attempt to repair the running service. The controller's isolated native MCP probe is an outer acceptance action, with zero model turns and no resumption of the current Desktop thread.
