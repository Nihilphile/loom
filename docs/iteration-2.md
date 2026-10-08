# Iteration 2

User confirmed on 2026-10-08 that switching projects leaves their sessions and graphs running. Free chat should include slash commands, skill mentions, model/reasoning controls, images/files, context usage, steering and queued messages.

Replace displayed cost with input/cached input/output token usage. Input is the runtime total input; cached input is a subset, so totals must not add cached input again. Statistics should include project, graph, task, unit/session and individual executions, with model/time/status filtering where data exists. Historical unknown fields remain unknown.

Add a persistent project registry. Selecting a project changes the browser view, not execution ownership. New missing directories are created with an initial Git repository; existing folders are registered without modifying their files. Every request, upload, stream and CLI report must retain its originating project, even across selection changes and multiple browser tabs.

Runtime integrations must use verified local App Server protocol. Native skill references and images must reach the actual model input; slash commands need real actions. Unsupported context data must not be estimated from cumulative token usage. Preserve existing graph execution/report invariants.

Throughput: freeze shared interfaces, then isolate project HTTP/registry, session/runtime, and frontend implementation. Coordinator owns integration, token/statistics data and verification.

Design rubric: project isolation under concurrent switching, same-session ordering/interruption correctness, actual native input/context support, maintainable API and visible behavior, compatibility with persisted history and existing CLI.

Verification: public API tests with two active projects and report routing; queued/steered turn races; attachment and skill input fixtures; real Codex bounded smoke; browser project creation/switching, composer menus/attachments, detailed token views and cross-project SSE behavior.

Architecture selected after two independent candidates and a cross-judge: resident registry (22/25 versus 20/25). Both candidates converged on project-scoped URLs. Graft fixed request ownership and interruption targeting; reject silent steer-to-queue conversion. Canonical path registration is idempotent. Engines stay resident until shutdown. Model the Domain shaped this choice: a registry owns projects and each session owns its durable queue.

Frozen implementation API:

- GET /api/projects returns { projects: ProjectEntry[] }. POST /api/projects accepts { path, name? } and returns ProjectEntry. Existing paths reuse their canonical ID.
- All project APIs use /api/projects/:pid as prefix replacing /api. State and SSE payload remain AppState, with project.id. The original unscoped routes use the fixed startup project, never browser selection.
- GET .../runtime/options returns RuntimeOptions via runtime.discoverOptions(cwd). Native discovery failure is visible.
- POST .../attachments accepts { name, mediaType, base64 }, maximum 10 MB, returns Attachment. GET .../attachments/:id serves validated project-owned bytes. Engine uses resolveAttachments(root, ids) from attachments.ts.
- POST .../sessions/:sid/turn accepts TurnInput and returns Session. Engine sendMessage(id, string | TurnInput) may be asynchronous. Mode send starts if idle, queue persists FIFO, steer targets expectedExecutionId and refuses if it ended. No silent fallback.
- DELETE .../sessions/:sid/queue/:qid calls engine.cancelQueued(id,qid). POST .../sessions/:sid/continue calls engine.continueQueue(id). Both return Session. Interruption/failure/restart pause queues until explicit continuation. Idempotency is scoped to session and requestId.
- RuntimeInput carries resolved attachments and native skill references, including steer. Chat messages retain attachment/skill descriptors. Runtime events may carry contextUsage and resolved model. Execution metrics and usageKnown distinguish unknown historical usage from zero.
- AppState.executions omits tokenHash. Statistics are derived in the UI from execution rows with filter-before-aggregate, coverage and separate cumulative session totals. Cached input is never added twice.
- CLI prefixes every route using HARNESS_PROJECT_ID. Engine sets it for free and task executions, alongside origin-only HARNESS_URL.
- Supported slash actions are /new, /model, /skills, /status, /help, /stop. They invoke local UI/API actions. Unknown slash commands show feedback. No decorative /compact.

Ownership: coordinator owns shared types, project registry/path, attachments, store, HTTP/CLI, integration tests/docs. Runtime worker owns engine/runtime/validation and session/native tests. UI worker owns web files and UI verification. All workers use isolated worktrees from the frozen contract commit.

Review decisions: confirmed native steering is recorded as delivered even if the execution settles before the acknowledgement reaches the engine. A regression test covers this boundary. Native Skill mentions in this iteration belong to the free-session composer; existing TaskType skill strings keep their document-injection behavior, now including the source path for relative resources. Migrating graph skill configuration to catalog references is outside this iteration.
