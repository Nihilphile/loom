# Implementation progress

User authorized implementation on 2026-10-08. Matt Task owns specification and task registration; Matt Task Take owns implementation and delivery. The predecessor is development tracking only.

## Architecture / arena

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
