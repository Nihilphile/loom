# Iteration 3 acceptance

Verified on Windows, Node 24.18.0 and local Codex App Server 0.160.0 on 2026-10-08.

## Delivered behavior

- Unit Config and Context show declared settings, accepted settings, input sources and runtime receipts. Preparation stays internal. Continuations reuse accepted settings and inject changed materials; an uncertain receipt requires explicit reconciliation before replay.
- Free and Task sessions can create independent read-only sidechats from their latest completed native turn. Sidechats retain their own conversation, queue, execution records and token totals. The source can keep running.
- Developer interviews default off. Users can configure the prompt, Skills, model, reasoning and completed/blocked triggers, or request a manual interview. The feedback box keeps the original answer, question and source association. Interview failures do not change the source Task.
- Sidechat and interview consumption belongs to project totals and separate overhead categories, without charging it again to the source Unit.
- Report-only Tasks now complete Git snapshots when runtime metadata is ignored. Literal whitespace, brackets and tracked file deletion are covered by real-repository regression tests.

## Automated verification

The integrated suite passed 62 tests, with zero failures and three existing opt-in live tests skipped. Type checking, production build and `git diff --check` passed. After the final source-setting inheritance fix, all 10 preparation tests and the production build passed again.

Coverage includes input acceptance and unknown delivery, incremental reviewer materials, A-to-B-to-A context revisions, pinned Skill content, frozen template references, observer isolation, automatic interview deduplication, failure visibility, interrupted queues, project isolation and statistics. Existing review, repair, pause, mailbox and Git conflict tests remain passing.

## Live Codex verification

`output/iteration3/live-acceptance.mjs` exercised actual models and Git in a disposable project. Evidence is in `output/iteration3/live-1791460405870/evidence.json`.

1. A free source session remembered a marker, then ran a second turn containing a 25-second command. A sidechat forked its preceding completed turn while the source was still running.
2. The sidechat returned the inherited marker and read an on-disk marker through the restricted MCP. It received a different native thread ID. The source finished its second turn without the sidechat prompt entering its messages.
3. A manual interview returned its configured marker to the feedback box. The source retained two turns.
4. A Task wrote a report and submitted ready without modifying code. Its Graph completed; exactly one automatic completion interview finished and saved the configured answer. The Task retained one turn and no interview prompt.
5. Through the actual browser, a Task sidechat read `.newharness/reports/worker/result.md`. A bounded attempt to create `loom-observer-canary.txt` produced a native `patch rejected: writing is blocked by read-only sandbox` error. The file remained absent. The state and native events are saved as `browser-state.json` and `browser-events.json` beside the evidence file.

An independent native capability probe found that `features.multi_agent=false` alone did not disable collaboration. The implementation additionally sets `agents.enabled=false`, disables inherited MCP servers, plugins, shell, network tools and completion callbacks, and permits only Loom's restricted file reader. Paired probe evidence is in `output/iteration3/probe/findings.md`. Native `apply_patch` can remain exposed, but the read-only sandbox rejects writes.

## Browser verification

The real service on port 4319 was checked at desktop and 390-pixel widths. Verified default-disabled interview settings, model/reasoning drafts surviving an SSE update, opening the real acceptance project, feedback and source links, distinct session groups, Task sidechat creation and sending, Unit Config/Context, and statistics. Developer, feedback and statistics pages had no document-level horizontal overflow at mobile width.

Screenshots are under `output/playwright/`: `iteration3-developer.png`, `iteration3-developer-mobile.png`, `iteration3-feedback.png`, `iteration3-feedback-mobile.png`, `iteration3-unit-context.png`, `iteration3-stats.png` and `iteration3-task-sidechat-running.png`.

## Boundaries

- A source needs a completed native turn before it can be forked. The current in-progress turn is not part of the fork.
- Conversation history is fixed at the selected turn; file reads see the current allowed worktree contents, not a historical filesystem snapshot.
- Observer tools provide bounded text-file reads. They do not provide shell, network or write access. They exclude private runtime storage; report paths are explicitly readable. Running observer followups queue in their own session; steer is not exposed.
- Blocked-trigger and unavailable-fork behavior are covered by automated tests. The live end-to-end run exercised the completed trigger.
- Automatic interviews remain disabled in the user's main project. They were enabled only in the disposable acceptance project. No workflow method was implicitly activated.
