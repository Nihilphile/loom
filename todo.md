# Prototype 0.3

> Historical prototype work log from 2026-10-08. The checklists below describe browser simulations and the predecessor investigation. They are not this implementation's task list or verification evidence. The final whole-graph merge shown by the prototype has been replaced by the [current Graph integration contract](docs/SPEC.md). Preserve the old claims, including the then-absent Git repository, within their historical scope.

- [x] Scope the decision the prototype exists to make: which layout, which interaction, which density, or for an empirical fork which behavior, timing, or approach. No decision means no prototype. Route to Feature.
  Question: can the user distinguish an accepted report, a finished turn, a paused graph, and a final delivery?
- [x] Gather references when the design space is open. Search for prior art, summarize a moodboard of themes, palettes, and layouts, let the user pick directions before building. Skip when the direction is set.
  skip: retain the existing visual direction and extend the accepted design.
- [x] Build throwaway in an isolated scratch dir, separate from production source. For a visual decision, vanilla HTML/CSS/JS or the lightest stack that renders the idea, CDN deps, a dev server with hot reload. For a behavioral or timing decision, the smallest script that exercises the question. No production framework, no tests, no abstractions.
  Single HTML in prototype/, version 0.2 preserved. No SDK, Git actions, or persistence.
- [x] When comparing alternatives, build them behind one switcher (buttons or a keypress), each variant labeled. This is the **exhaust-the-design-space** principle skill made cheap.
  Seven guided scenarios compare workflow behavior, not alternative visual themes.
- [x] Verify on the matching surface. For a visual decision, screenshot each variant via the driver skill and drive the interaction. For a behavioral or timing decision, observe the thing you are deciding by logging the timing, printing the output, or watching the render. The observation is the test here, not an assertion.
  Browser exercised reports, review, both pauses, editing, cyclic dependency rejection, TaskType creation, append barriers, final merge conflicts, mail after completion and 390px layout. Evidence: output/playwright/drive-v03-*.js and v03-*.png. No test suite.
- [x] Present alternatives, tradeoffs, and a recommendation. The output is the decision plus the throwaway artifact, not shippable code. Hand the chosen direction to **Feature** (or `architect` for the shape) for the real build.

Model the Domain: separate graph scheduling phase, Unit jobs, submission receipts, and Git snapshot records. A submission alone does not finish the turn or the Task.
Throughput: reuse the single-file shell; replace the mock runtime and extend views; validate interactions in the browser without delegating implementation.
No Git repository exists here; preserve named version files instead of creating a throwaway branch. User evaluation remains pending.

# Prototype 0.2

- [x] Scope the decision the prototype exists to make: which layout, which interaction, which density, or for an empirical fork which behavior, timing, or approach. No decision means no prototype. Route to Feature.
  Question: do peer Task members, event rules and automatic mailbox delivery make the proposed workflow understandable?
- [x] Gather references when the design space is open. Search for prior art, summarize a moodboard of themes, palettes, and layouts, let the user pick directions before building. Skip when the direction is set.
  skip: preserve the accepted 0.1 visual direction.
- [x] Build throwaway in an isolated scratch dir, separate from production source. For a visual decision, vanilla HTML/CSS/JS or the lightest stack that renders the idea, CDN deps, a dev server with hot reload. For a behavioral or timing decision, the smallest script that exercises the question. No production framework, no tests, no abstractions.
- [x] When comparing alternatives, build them behind one switcher (buttons or a keypress), each variant labeled. This is the **exhaust-the-design-space** principle skill made cheap.
  Scenarios: direct submission, review revision, merge block; no competing visual redesign.
- [x] Verify on the matching surface. For a visual decision, screenshot each variant via the driver skill and drive the interaction. For a behavioral or timing decision, observe the thing you are deciding by logging the timing, printing the output, or watching the render. The observation is the test here, not an assertion.
- [x] Present alternatives, tradeoffs, and a recommendation. The output is the decision plus the throwaway artifact, not shippable code. Hand the chosen direction to **Feature** (or `architect` for the shape) for the real build.

Data: Graph owns Tasks, Letters and Events. Task owns peer Members, preparation state and candidate revision. Member owns resolved config and a reusable Session. Delivery is per recipient. Runtime advances on explicit events; configuration freezes on Task start.
Throughput: keep the single-file prototype, preserve 0.1, implement shared state once, then drive browser scenarios. No delegation or production SDK integration needed.

Evidence: output/playwright/v02-overview.png, v02-review.png, v02-conflict.png, v02-mailbox.png, v02-templates.png, v02-mobile.png. Browser scenario drivers and observed outputs exercise the actual UI, without a test suite.
No Git repository exists here, so preserve named version files instead of a throwaway branch.

# Predecessor design critique

- [x] Route through the **how** skill. For motivation questions, also route through the **why** skill.
  Scope: inspect the existing design and judge transfer to the new harness; do not infer original authors' motivations beyond documented behavior.
- [x] Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only investigation`.
- [x] Produce the `how`-shaped output (Overview / Key Concepts / How It Works / Where Things Live / Gotchas), or a recommendation with a tradeoffs table if the request is a decision between alternatives.
- [x] Apply the **unslop** skill to the reply.

Read-only predecessor inspection. Record findings in the new-harness workspace; no runtime or prototype changes. Compare core mechanisms, executable workflow policy, and skill guidance. Source observations are not performance measurements or live delivery validation.

Evidence and recommendations: docs/predecessor-design-review.md. Traced lifecycle, claims, review, artifacts, graph references, worktree merge semantics, mutation/build, and watch delivery. Existing agreed workflows remain; proposed core/policy/skill boundaries are not recorded as user approval.
