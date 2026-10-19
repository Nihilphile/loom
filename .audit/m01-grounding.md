# M01 grounding

## Overview

HarnessEngine owns ProjectState and ProjectStore serializes it into SQLite. HTTP opens one Engine per registered project and calls its methods. Web renders the same view. Runtime starts Codex app-server sessions; observer-tools is a separate handwritten read-only stdio MCP for observer forks. CLI uses project-scoped HTTP and Unit bearer credentials.

## Key concepts

Session.kind distinguishes free, task, sidechat and interview. Graph.controllerSessionId refers to a free session. Letter deliveries currently distinguish queued/injected/failed, where injected means runtime acceptance. Unit submissions and graph delivery receipts are separate durable records.

## How it works

sendMessage serializes per-session turn operations. Queue draining and ordinary sends call launchTurn, which calls launch. launch prepares inputs and starts Runtime or a command fixture. notify first stores a Letter and then deliverWaiting can start or inject into the free controller. resumeGraph also calls deliverWaiting for matching mail. This explains the reported competing writer without assuming that the Desktop lock is stale.

## Where things live

- src/server/engine.ts: session creation, turn queue, graph scheduler, Unit reporting, Mailbox delivery and notification.
- src/server/http.ts: localhost routing and project selection.
- src/server/store.ts: project lock and transactional state persistence.
- src/server/runtime.ts: Codex native thread start/resume and observer MCP injection.
- src/server/observer-tools.ts: project-only read tools, not the controller contract.
- src/shared/types.ts: persisted state and public domain types.
- src/cli.ts: existing Unit report protocol, unchanged in this task.
- web/main.ts: session lists, composer, queue continuation and observer actions.
- tests/session.test.ts, projects.test.ts, scheduler.test.ts, runtime.test.ts: internal session and Unit behavior.

## Gotchas and rationale constraints

Preserve the Engine as the only state writer, the existing Task scheduler, Unit report and observer restrictions. Change the assumption that every free session is a Loom runtime target. Avoid storing a second inbox or a live transport flag as ownership. Disconnection cannot transfer a native Desktop thread to Loom. A controller read cannot claim runtime injection.

The ownership rationale comes from current code and the explicit incident supplied with M01, not inferred historical author intent. No issue/chat/observability sources are needed to reconstruct that supplied incident; no external production state is read or mutated. Source history is not changed.

## Rubric

Score each from 0 to 5: external session can never launch; Unit path remains unchanged; durable read/explicit idempotent ack; narrow MCP with single Engine/HTTP ownership; true stdio client and full graph fixture verification.
