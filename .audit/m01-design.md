# M01 design synthesis

## Problem and caller usage

Desktop owns its native conversation. Loom must persist that fact and continue scheduling Tasks without ever opening the external native thread.

The desktop config fixes port, project ID, and one free session UUID. `loom_connect` binds an existing idle/failed free session or explicitly creates that UUID. The controller then queries TaskTypes, creates a graph from existing types, controls the graph, reads reports/inbox, explicitly acknowledges letters, and sends bounded Mailbox feedback. No Unit tools or file/shell tools exist.

## Candidates read in full

A, session 762902ff-e265-4665-9c28-959a75219f41, execution 5094d354-84ff-4847-b52d-92947116efcb: discriminated Session execution ownership, session-scoped Engine controller facade, existing Graph.controllerSessionId and Letter deliveries, private controller authentication, explicit acknowledged delivery, fixed stdio HTTP adapter. Reject active/pending execution or uncertain preparations. Central launch refusal plus entry-point checks. Durable mutation receipts. Candidate returned a complete design but runtime marked its execution failed because its process did not exit after turn completion. Read-only output none, no writable integration needed.

B, session 91934463-d0b6-4ecf-bd20-146098969d79, execution 78c396f5-9077-4def-8db9-0212c2f58c66: distinct persistent ControllerBinding with binding ID, generation, key hash and receipts; session separately carries execution mode. Same Engine ownership, graph relation and Mailbox. Stronger credential isolation, but extra binding lifecycle and identities. Completed read-only, output none.

Both require explicit `mcp_servers.loom.enabled=false` on Task/child/observer startup and thread configuration, independent of stripped HARNESS variables.

## Shape

Data first, per Model the Domain: `Session.executionOwner` is `{kind:'loom'}` or `{kind:'external',client:'desktop'}`. Old records normalize to Loom. A private ProjectState controller-access collection stores session ID, credential hash and mutation receipts. Engine.view never exposes it. No connected/disconnected execution policy exists.

Controller credentials use a dedicated HTTP header, never a Unit Bearer token. MCP reads a configured private environment key and sends no HARNESS credentials. HTTP rejects Unit credentials on controller routes and controller credentials on ordinary routes. The adapter accepts only a local port, a 24-character project ID and session UUID, never an arbitrary URL.

Shared strict schemas define each tool's bounded inputs and the matching HTTP operation. Engine verifies external ownership, principal and graph association on every operation. MCP imports neither Engine nor SQLite. Its only effects are typed localhost HTTP calls.

`connectController(sessionId, key, input)` is synchronous. It rejects running/interrupted/Task/observer/child sessions, jobs/handles/pending turns/delivery/uncertain preparations and surviving old execution. Existing queued messages are preserved and frozen rather than silently discarded; they cannot start and are visible as historical pending input. Reconnect with the same key is idempotent. No disconnect or implicit unbind operation exists.

`controllerCommand(sessionId, key, command)` handles fixed operations. Graph creation and inline feedback use durable requestId receipts. Graph creation assigns its controller before one persisted record. Graph projections omit raw state/config/credentials and executable commands. Reports and letter content have bounded windows and scoped lookup. TaskTypes can only be selected from the existing catalog.

Notifications remain Letters with queued deliveries until an explicit ack sets `acknowledged`, preserving its original timestamp on retries. Reads have no delivery side effects. Ack checks graph and recipient before mutation. Unit delivery remains queued/injected. Feedback snapshots bounded inline text into an ordinary Mailbox file through Engine, forces its sender and validates an agent Unit in the owned graph.

Ordinary send/queue/steer/continue/interrupt/observer entry points reject external ownership. drainQueue, deliverWaiting and child continuation return without dispatch. launch refuses before making an execution. Binding refuses in-flight asynchronous operations so ownership cannot change during their awaits.

## Scores and synthesis decision

Scores are 0..5 for external never starts / Unit unchanged / durable explicit ack / narrow single owner / stdio and graph testability. Initial parent estimates were A 5/5/5/5/5; B 5/5/5/4/5. The independent cross-judge corrected both to 21/25; the initial estimates did not establish verification and were too generous. A is the base on simplicity. Graft B's private credential storage to avoid publishing authentication metadata with session history. Reject generation and a second binding identity because disconnect never transfers ownership. Reduced diversity: both allowed inherited gpt-6.1-sol, high/xhigh reasoning.

## Tradeoffs and implementation reconciliation

Local HTTP is still the existing same-user trust boundary. A dedicated secret separates controller tools from Unit identity; it does not sandbox users who already control the Loom host. No background Desktop wake capability is claimed. Fixed session UUID makes creating/reconnecting deterministic without a second resource identity.

Queued input preservation is an intentional deviation from candidate A's strict rejection. The real incident has queuePaused=true and durable notifications must survive takeover. The final launch guard and frozen queue preserve ownership without deleting prior input. The parent accepts this under the user's safe idle/failed binding requirement; verify explicitly.

The current Windows sandbox denies Node pipe creation even before edits. Baseline typecheck passed; baseline build failed at Vite's pipe-backed subprocess with EPERM. Mandatory SDK stdio/full-suite execution remains a delivery gate, never a claimed pass.

Cross-judge e68e9fbd-9361-46e1-b6e6-e88ad3fa03b6 conditionally approved A with private credentials. Its rubric scored both candidates 21/25 and correctly rejected the parent's perfect verification scores as premature. It selected A on simplicity, not a single-owner deficit in B. The parent accepts that correction.

The implementation added the cross-judge's requested safeguards: observer-source checks, atomic queue freeze and receipts, deterministic feedback files, separated HTTP credentials, refused redirects, and Runtime disabling at both boundaries. The subsequent implementation preflight found that the observer check was incomplete: it tested absence of a thread ID while dispatch tested absence of accepted configuration. A rejected first turn can leave these states different. The parent accepts that finding and replaces all three decisions with one `forkSource` helper based on accepted configuration. A regression failed with `Missing expected rejection` before the fix and passed afterward, covering rejected-first-turn retries and pending forks during binding. No second controller identity or connection lifecycle was added.

The preflight also found an acknowledgement cursor failure in its earlier snapshot. Cursors now resolve against stable owned Letters before filtering acknowledged deliveries. A three-Letter, two-item page test acknowledges the entire page, restarts Engine, and verifies the continuation returns the last unread Letter. Both preflight fixes passed the 25-test controller/session/preparation run and typecheck; full pipe-backed acceptance remains separate.

The independent implementation preflight is read-only session 18606cc4-150d-4ad9-b125-ce13f8ec6f10, execution e34173fa-2103-4288-9668-7270928ea21d. The same session's bounded recheck, execution eaf63cc5-aa09-4904-aeb0-a98ed092bb0b, confirmed both findings closed against the parent source and tests, without rerunning checks. All children have ended with output none. Outer Task reviewer still independently accepts the final candidate after mandatory verification is unblocked.
