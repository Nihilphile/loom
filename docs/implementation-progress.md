# Implementation progress

User authorized implementation on 2026-10-08. Matt Task owns specification and task registration; Matt Task Take owns implementation and delivery. The predecessor is development tracking only.

## Architecture / arena

- [x] Ground: greenfield application; inspect agreed design, prototype and runtime research.
- [x] Frame: compare a single authoritative local coordinator with event-log projection architecture. Rubric: submission/turn correctness, durable restart behavior, isolated Git results, runtime capability fit, and smallest comprehensible public API.
- [ ] Fan out / Sketch: independent candidate packages in output/architecture/.
- [ ] Cross-judge / Pick / Graft: choose and record one architecture.
- [ ] Agree: proceed under implementation authorization; no extra approval gate.
- [ ] Implement: replace the sketch with working vertical slices and verify.
- [ ] Verify: public API/CLI behavior, real temporary Git repositories, actual runtime smoke and browser interaction.
- [ ] Scrap: only if repeated implementation friction invalidates the sketch.

Throughput: parallelize bounded runtime, Git and UI work after freezing shared interfaces. One coordinator owns the durable project state and scheduling. Each worker writes an isolated worktree, integration stays with the controller.

Validation seams: local HTTP/CLI commands and observable state/events, runtime adapter lifecycle, Git workspace public operations and resulting repository files. Use disposable repositories and a controlled runtime for repeatable failure/race coverage; supplement with a real Codex smoke. These follow the authorized implementation workflow and test externally observable behavior.
