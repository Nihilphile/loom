# Graph integration queue acceptance

Date: 2026-10-20.

This report covers the replacement of dependency-specific workspace merges and the final whole-Graph merge with a persisted delivery queue. The contract is in [SPEC.md](../SPEC.md), and the implementation boundaries are in [architecture.md](../architecture.md).

## Implemented behavior

Task acceptance queues an immutable candidate. Each Graph merges and validates candidates serially in isolated workspaces, then publishes the branch and Git receipt together. A downstream Task starts only after every prerequisite publishes. Its fixed starting commit is the current Graph integration HEAD, which can include unrelated deliveries.

Conflicts and failed validation block the affected delivery. Other independent deliveries can continue. Resolve retries the accepted candidate without rerunning its Agent. Pause, restart reconciliation, safe paused edits, and append barriers include the delivery queue. Graph completion does not merge into the project branch.

The UI shows queued and active integration, validation results, and mirror warnings. Git commit identities are under collapsed Debug details. Graph creation accepts an optional integration validation command.

## Verification record

At implementation commit `9bb5a36`, the full suite reported 99 tests, 96 passed, 3 opt-in real-Codex tests skipped, and no failures. The equivalent owner checkpoint was `37a1fe6`. Typecheck and build passed. Tests used real temporary Git repositories, controlled runtimes, and local command processes. No paid model call was made for this change.

An independent review of `58f7a70` reproduced two defects after that suite passed. A retry could adopt a commit made by a rejected validator. A pending resume could override a later hard pause. Commit `68e3961` fixes both and refuses missing or mismatched published receipts during recovery.

After those fixes, nine focused Git and scheduler cases passed, as did all 27 Agentic and preparation tests. Typecheck passed, and the root checkout rebuilt successfully. The earlier full suite was not repeated. The focused cases cover mutation retries, pause and close during reconciliation, edit exclusion, integration failures, and receipt recovery.

Independent real-Git and lifecycle probes then confirmed the two original fixes, candidate restoration, fresh-base isolation, idempotent receipt reuse, and hard-pause, soft-pause, and shutdown precedence. That review found a further idle-state regression: resuming a paused Graph with only blocked work left the Graph marked `running`.

Commit `0d2e7bb` schedules another check after the control operation settles. Its new HTTP regression failed before the fix with actual `running`, expected `blocked`. After the fix, all 12 focused scheduler cases passed, including pause, close, validation interruption, integration retry, and receipt recovery. Typecheck and the root build passed. These focused runs overlap earlier cases and must not be added together as a distinct-test total.

The final independent reviewer approved `0d2e7bb` after rerunning the idle-state probe and the five-scenario Git and lifecycle probe. The idle Graph settled as `blocked`, with no active work and one original worker turn. Candidate retry, restoration, receipt reuse, fresh-base isolation, and pause and shutdown precedence passed again. No actionable finding remained in that review. The new code added no comments or suppressions. Local review evidence is in `output/integration-queue/closure-review.md`.

Browser acceptance uses four Command Tasks with real Git workspaces. D, B, and C run independently, and A depends on B and C. A remains waiting while prerequisite deliveries are queued. After publication, A reads B, C, and the unrelated D. API and Git checks confirm four publication receipts, fixed running Task bases, agreement between the Graph branch and mirror, and an unchanged project main branch.

The complete browser driver passed after restarting the built server at `68e3961`. The accepted Graph was `740c9595-ee13-477f-ae0c-6431e35698bd`, with integration HEAD `3621a9658f1a2543c149b0da7269e40669d6d5e2`. Both waiting and completed screenshots were visually inspected. An earlier driver checked completion too soon; its polling was corrected before this full rerun.

The preview server was rebuilt and restarted again at `0d2e7bb`. All six API and Git checks still passed against the persisted completed Graph. The complete browser creation flow was not repeated for the final one-line lifecycle change.

Local reproduction and evidence files are retained under `output/integration-queue/`. They include `drive-demo.js`, `verify-demo.mjs`, `browser-evidence.json`, queue screenshots, `full-test.log`, and independent review reports. These generated files are local artifacts, not committed fixtures.

## Scope limits

This slice does not implement reopening an already delivered Task, upstream rework, delivery revert, or automatic downstream invalidation. Their agreed design remains in [DESIGN-NOTES.md](../../DESIGN-NOTES.md). Squash versus merge remains a product choice; the current adapter uses merge commits.

An absent integration command is recorded as `not_configured`, not as a test pass. This acceptance does not replace a real-Codex runtime smoke test or claim that arbitrary project tests pass.
