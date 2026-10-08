# Iteration 2 acceptance

Verified on Windows with Node 24 and local Codex App Server 0.160.0 on 2026-10-08.

## Delivered behavior

- Project registry persists canonical folder identities. New folders receive an initial Git repository. Existing-folder registration preserves source files. Switching the browser leaves resident project engines running.
- HTTP, SSE, attachments and all CLI commands carry the originating project. Tests run two projects together and reject a report credential from the other project.
- Free sessions provide real model and reasoning choices, native Skill references, native images, readable file attachments, slash actions, streaming output, tool details, context data, steering and durable queued messages.
- Token displays distinguish input, cached input and output. Cached input is included in input. Statistics filter executions before grouping and keep historical session totals separate. Missing reliable execution usage remains unknown, including some resumed turns after interruption when Codex supplies no safe baseline.
- Interruption pauses the queue. Explicit continuation resumes the same session. A steering acknowledgement remains valid if the execution finishes before its receipt reaches the engine. Steering during initialization waits for that execution's native turn.

## Automated checks

`npm run typecheck`, `npm run build` and `git diff --check` passed. The final `npm test` run passed 45 tests with no failures. Three opt-in live tests remained skipped in that command; the separate live checks below exercised the new native inputs and controls.

The suite covers scoped concurrent projects, CLI ownership, SSE isolation, immutable attachment bytes, upload boundaries, queue order and configuration snapshots, duplicate request IDs, acknowledgement races, interruption and restart recovery, native protocol inputs, historical unknown usage and non-duplicated statistics. Existing graph review, repair, mailbox, Git conflict and snapshot tests still pass.

## Live Codex and browser checks

`output/iteration2/live-rich-session.mjs` ran two projects concurrently. Project A used an uploaded screenshot, a text file and a project-local native Skill. Its answer identified the screenshot heading, returned the file marker and Skill marker, and included the live steering marker. Its queued second turn then completed. Project B completed independently.

The two A executions reported input/cached/output counts of 82,632 / 51,712 / 387 and 29,437 / 28,672 / 8. The latest context was 29,445 of 475,000 tokens. Raw acceptance evidence is saved in `output/iteration2/live-rich-session/evidence.json`.

The browser checks exercised project creation and switching, per-project drafts, file upload, native Skill selection, slash help, model reset and filtered statistics. Delayed transport interception confirmed that one pending send does not block another project's send. This interception tests UI routing only; the independent live check above verifies actual concurrent execution. Historical totals remain expanded through SSE updates. The 390 px viewport has no document-level horizontal overflow; wide tables scroll within their panels.

The final browser check on port 4319 used the real Codex runtime. It submitted a turn, queued a message, steered during startup, interrupted, retained the paused queue, continued explicitly and received `UI_QUEUE_RESUMED` in the original session. Its snapshots are `output/playwright/iteration2-paused-queue.png` and `iteration2-live-controls.png`. Other snapshots include `iteration2-composer.png`, `iteration2-stats.png` and `iteration2-mobile.png`.

## Review and environment notes

Independent backend and UI reviews found and prompted fixes for the steering acknowledgement race, default configuration reset, a global chat submission lock and collapsed historical totals. Browser verification also exposed and fixed the mobile table layout and startup steering boundary. The comments audit found no introduced comments or suppressions requiring removal.

Native Skill inputs in this iteration apply to free sessions. Existing TaskType skill strings retain document injection and now include their source path for relative references.

The installed Skill catalog reports a pre-existing missing-frontmatter error in an unrelated `noname_test_skill`. Discovery exposes that warning and keeps valid skills available. This task does not edit the unrelated file.

The current verified app runs at http://127.0.0.1:4319 with `F:/AI_project/new-harness` open. Its registry is `output/iteration2/active-projects.json`. Older services on ports 4317 and 4318 were retained after execution policy rejected their replacement. No active model execution remains from acceptance checks.
