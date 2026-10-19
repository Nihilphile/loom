# Implementation progress

User authorized implementation on 2026-10-08. Matt Task owns specification and task registration; Matt Task Take owns implementation and delivery. The predecessor is development tracking only.

## Graph integration queue, 2026-10-20

The current contract uses a Graph integration branch and a persisted per-Graph delivery queue. Every Task starts from a fixed current integration commit after all prerequisites publish. Accepted candidates merge and validate in isolation before publication. A failed delivery leaves downstream Tasks waiting while independent candidates can continue. Graph completion has no final whole-graph merge.

The synchronized specification is in [SPEC.md](SPEC.md), with data and Git operation ownership in [architecture.md](architecture.md). [DESIGN-NOTES.md](../DESIGN-NOTES.md) replaces the obsolete dependency-only workspace proposal and records future rework and revert decisions separately. Full reopening, inverse delivery and downstream reassessment remain outside this implementation slice. The product choice between squash and merge commits remains open.

Current verification is recorded in [Graph integration queue acceptance](reports/integration-queue-acceptance.md), including the full-suite checkpoint, review fixes, focused regressions, and browser execution with real Git. Reports below retain their original date, commit and scope. The original Git, scheduler and first acceptance reports describe the replaced workspace preparation and final merge behavior. Their banners link to the current contract.

## Historical first implementation

The following checklist records the first implementation on 2026-10-08. Its completed checks are historical evidence, not completion claims for the integration queue.

### Architecture / arena

- [x] Ground: greenfield application; inspect agreed design, prototype and runtime research.
- [x] Frame: compare a single authoritative local coordinator with event-log projection architecture. Rubric: submission/turn correctness, durable restart behavior, isolated Git results, runtime capability fit, and smallest comprehensible public API.
- [x] Fan out / Sketch: independent candidate packages in output/architecture/.
- [x] Cross-judge / Pick / Graft: coordinator selected; SQLite transactions adopted.
- [x] Agree: proceeded under implementation authorization.
- [x] Implement: runtime, Git, UI, CLI, scheduling and control integrated.
- [x] Verify: public API/CLI, real Git repositories, actual Codex smoke and browser interaction. See docs/reports/acceptance.md.
- [x] Scrap: skip; the chosen coordinator survived integration. Windows reviewer execution directory was adjusted after real permission probes.

Throughput: parallelize bounded runtime, Git and UI work after freezing shared interfaces. One coordinator owns the durable project state and scheduling. Each worker writes an isolated worktree, integration stays with the controller.

Validation seams: local HTTP/CLI commands and observable state/events, runtime adapter lifecycle, Git workspace public operations and resulting repository files. Use disposable repositories and a controlled runtime for repeatable failure/race coverage; supplement with a real Codex smoke. These follow the authorized implementation workflow and test externally observable behavior.

Independent lifecycle audit findings were fixed: completed-task mailbox loop, interrupted mail reopening task work, command mailbox rerunning scripts, startup steering race, paused-mail draining, stable graph retry identity and snapshot recovery. Two redundant or overstated Git comments were removed. No claimed constraint needed a separate approval flow.

Remaining product limits are explicit in README.md: shared-worktree mode, reviewer-added tests, graph references, completed-task reopening and cancellation. Command members are trusted local scripts; Agent code permissions are enforced by the runtime sandbox.
