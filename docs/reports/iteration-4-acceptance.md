# Iteration 4 acceptance

Verified on Windows, Node 24.18.0 and Codex App Server 0.162.0-alpha.17.2 on 2026-10-10.

## Delivered behavior

Agentic is a delegation configuration on an Agent Unit. The built-in `agentic-reviewed` TaskType combines it with a separate reviewer. Templates can disable delegation or bound child depth, concurrency and models. Existing personal catalog entries keep their customizations.

The execution-bound `loom_agent` tool creates independent child sessions, continues their native threads, reads results, cancels subtrees, and integrates or discards exact execution outputs. Children inherit accepted skills and settings, can narrow access, and receive no Unit report credential. Registered child workspaces use bounded paths on Windows. Only the main Unit can submit its result to the Task scheduler.

Turn completion and Unit delivery remain distinct. Children can finish after their parent turn. Their results resume the same direct parent thread. A valid Unit report requires all descendants and writable outputs to be settled. Soft pause drains accepted turns; hard pause interrupts the tree. Both wait for outstanding workspace operations. Restart preserves identities and requires reconciliation of uncertain inputs.

Session views show the child tree, native thread IDs, configuration, workspaces, outputs, preparation and execution history. Tokens are input, cached input and output. Own, subtree and Graph summaries use unique execution rows. Cached input is an input subset. Unknown measurements retain coverage counts. Accumulated Agent seconds and execution-interval union seconds are separate measures.

## Verification

The full suite at the Windows path fix passed 87 tests, with zero failures and three existing opt-in native tests skipped. After the final result-observation changes, all 17 lifecycle tests passed independently. Runtime and UI/accounting checks passed. The final Graph header fix passed typecheck, build and four statistics tests, then matched the real browser's numbers against the execution ledger.

Local logs and independent reports are under `output/agentic/`: `owner-full-test.log`, `owner-final-lifecycle-test.log`, `runtime-review.md`, `lifecycle-review.md` and `comment-audit.md`. The independent reviews found and resolved workspace fallback, snapshot failure, model allowlist, pause/shutdown drain and interrupted-result delivery defects.

## Actual Codex and Git

`output/agentic/live-acceptance.mjs` drove a disposable project. The final evidence is `output/agentic/live-1791570979623/evidence.json`.

- The main Unit created writable Writer and readonly Reader sessions. Writer created a readonly Nested reader.
- All three children received distinct native thread IDs. Writer resumed after its nested result. Reader completed two turns on the same native thread and reported that `HARNESS_TOKEN` was absent.
- Writer created `agentic-proof.txt` in its own worktree. Its exact completed output was integrated into the parent workspace. The external reviewer started only after every child execution ended.
- The Graph finished after ready and approved reports. Five child executions each have recorded input, cached input and output usage.
- A transient GET connection reset in the test driver interrupted the first reviewer turn. The server was reopened and the existing reviewer thread resumed, without recreating children. Final assertions passed after recovery. The driver now retries transient read requests only.

The first live attempt failed because nested Git branch names exceeded Windows path limits. It remains recorded in `output/agentic/live-1791570584687`. Child workspace paths, branch names and operation refs were bounded, and the unchanged project path passed on the next attempt.

`output/agentic/pause-acceptance.mjs` separately waited for confirmed native input acceptance before pausing. `output/agentic/pause-1791571224910/hard.json` shows the child interrupted and no later launches. That child retains `no active turn to interrupt` and unknown token usage; this verifies a settled stop, not a clean native interruption acknowledgement or complete usage for that attempt. `soft.json` shows both accepted turns completed, with no parent continuation or outer review launched while paused. Resuming after soft pause is covered by the lifecycle tests, not that live pause driver. The final pause checks ran on the result-observation fix.

## Browser

Playwright drove the actual service. It checked Agentic defaults, the separate reviewer's disabled delegation, child-to-parent navigation, native IDs, Writer's own and subtree tokens, statistics grouping, and Graph totals. Browser verification found an old Graph header summing only main Unit metrics; it now includes all child executions.

Screenshots are in `output/playwright/`: `agentic-template.png`, `agentic-tasktype-editor.png`, `agentic-writer-session.png`, `agentic-statistics.png` and `agentic-graph-completed.png`. Graph totals matched 1,210,282 input tokens, 1,029,504 cached input tokens and 5,847 output tokens across 11 executions, including the interrupted and resumed reviewer.

The updated demonstration runs at `http://127.0.0.1:4320/` with the completed acceptance project. Automatic approval rejected stopping the earlier service on port 4319 without a more specific reason. That service was retained; termination was not retried through another mechanism.

## Boundaries

- No workflow is automatically selected. A complete `loom-pstack` workflow pack is not part of this change.
- Task and observer native delegation is disabled so managed descendants remain attributable. Free chat keeps its existing native behavior.
- `wait` returns a snapshot. A waiting parent ends its turn and receives a continuation when results arrive.
- This is a local tool-authority boundary, not protection against arbitrary hostile shell or network requests to the local service.
- No push, PR, deployment or merge into the project's main branch was performed. The Graph result stays on its Graph baseline.

The design applied Model the Domain to child ownership and lifecycle, Separate Before Serializing Shared State to writable worktrees, Sequence Work into Verifiable Units to the commits, and Prove It Works to native and browser acceptance. Redesign from First Principles kept Unit delivery distinct from a model turn; Laziness Protocol kept the existing Engine and execution ledger as the single state owner.
