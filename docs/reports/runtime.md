# Runtime delivery

`CodexRuntime` implements the Runtime interface in `src/server/runtime.ts`. Each Loom session owns one reusable JSONL App Server backend. The owner combines project identity and session identity. Each execution has its own acceptance receipt, turn identity, messages, usage, tool callbacks and cancellation. `done` resolves on the native terminal turn event; it does not wait for backend exit or pipe closure. A subsequent backend failure is a resource failure and cannot rewrite a completed turn. Backend exit allows a bounded 250 ms drain for final stdout delivered over a separate OS pipe; it never waits for inherited pipe EOF.

Free-session resources survive a completed turn and expire after five minutes idle. Running turns never expire. Failed backends also have bounded idle cleanup. Launch configuration, permissions or environment changes retire the previous backend before starting a replacement, so execution credentials cannot leak across resumes. Turn interruption is bounded even when Codex never acknowledges it. Explicit resource cleanup pauses the session queue first. Task and writable-child publication have a separate cleanup gate before snapshots; cleanup failure blocks publication while preserving the turn outcome.

`GET /api/sessions/:id/resources` lists owned process identities, PID, name, role and memory. `POST .../resources/stop` accepts an opaque `resourceId`; `POST .../resources/close` interrupts the turn and closes all owned resources. Windows ownership uses a Job Object, including descendants after their original parent exits. Resource listing failures retain the last confirmed list with an error. Command Units and runtimes without resource support report `unavailable`.

Windows 10 or later uses a separate supervisor and atomically assigns the backend to its Job when creating the process. Successful cleanup requires confirmation that the Job has no members. Supervisor exit triggers OS cleanup but does not itself prove that every process has stopped writing. The build copies the supervisor sources; Windows PowerShell compiles them with installed .NET facilities, without a separate SDK.

Ownership covers local descendants that inherit the Job. Native subagent processes belong to their root Loom session; individual tool-call attribution is not available. WSL, remote processes and processes started by an external service are outside this guarantee. Linux process-group tracking is a fallback with sampling limits; other POSIX platforms list only the backend. These fallbacks have not received the Windows integration coverage.

Events are `thread.started`, `assistant.delta`, `tool.started`, `tool.completed`, `usage`, and `log`. Log details retain incoming protocol method and params. Tool details contain the App Server item. Usage is the current execution's increment over resumed thread totals. Exact credential values supplied through token, secret, password, or key environment variables are redacted from event values and final text. Approval requests are declined. Unsupported interactive requests receive a JSON-RPC error.

The executable preference is `CODEX_CLI_PATH`, the latest installed Desktop executable on Windows, a native PATH executable, then the npm native binary. The earlier 2026-10-08 tests used Desktop Codex 0.160.0. Generated 0.157.1 and 0.160.0 protocols were inspected. The 0.157.1 executable was not used for model smoke tests.

## Windows permissions

The runtime selects the unelevated Windows sandbox per child process. `CODEX_WINDOWS_SANDBOX=elevated` or the constructor option can select elevated mode. No global configuration is changed. The installed elevated sandbox failed all direct command probes with `helper_unknown_error: apply deny-read ACLs`. Unelevated mode successfully enforced the tested filesystem boundaries. No network isolation is claimed. Network access is enabled so the report CLI can reach the loopback server.

For `readOnly` with report `writableRoots`, Windows uses the first report root as the execution cwd, with only the report roots writable. The prompt names the original project by absolute path. The coordinator retains its original project cwd. Roots are canonicalized, must exist, and cannot include the whole reviewed project. Both absolute writes and relative traversal writes into the code directory were denied in the live test. Report writes and an authenticated loopback HTTP request succeeded from the sandboxed shell with credentials inherited from RuntimeInput.env.

Other platforms use an explicit named permission profile with filesystem-wide read access and exact writable report roots. This profile was accepted by the 0.160.0 protocol, but its filesystem enforcement was not tested on Linux or macOS. Windows unelevated mode explicitly rejects this split profile, which is why Windows relocates the execution cwd. There is no full-access fallback.

## Verification

`npm run typecheck` passes. The default test suite includes subprocess coverage for event normalization, resumed usage, steering, interruption, RPC errors, unexpected exit, stalled shutdown, initialization cancellation, approval denial, credential redaction, and rejection of unsafe report roots.

The following opt-in tests passed on 2026-10-08 with real Codex 0.160.0:

- `HARNESS_CODEX_SMOKE=1` starts a read-only thread and resumes it in a new process, recovering the original marker and real usage.
- `HARNESS_CODEX_PERMISSIONS_SMOKE=1` proves report writes, denied absolute and relative code writes, and an authenticated HTTP 200 from loopback.
- `HARNESS_CODEX_CONTROL_SMOKE=1` observes a real shell child PID, accepts `turn/steer`, interrupts the turn, then explicitly closes resources and verifies both the App Server PID and shell command PID no longer exist.

Run them with the environment variables set to `1`, then `npx tsx --test tests/runtime.test.ts`. Each live test is bounded and closes its runtime and temporary directory. The default suite skips live model calls.

The default suite also covers backend reuse, session isolation, per-turn output and usage, credential rotation, unresponsive interruption, idle release, late backend failure, HTTP resource controls and the publication cleanup gate. Model-backed smoke tests remain opt-in.

On 2026-10-30, the isolated session-resource implementation passed type checking, the production build, four Windows process-ownership tests, HTTP lifecycle probes and browser resource controls. A real free session using its existing inherited permissions successfully ran `node --version`, reused one backend across two turns, and closed all owned resources. The full suite reported 146 passes, two failures and three opt-in skips; both failures reproduced on the unchanged baseline and passed after canonicalizing only the test process's TEMP/TMP paths. The existing Git directory check confuses Windows short and long paths.

The separate live workspace-sandbox probe returned `CreateProcessAsUserW failed: 5`. The unchanged raw-spawn baseline reproduced the same failure. That sandbox check remains unverified; the implementation does not change global permissions to bypass it. See [the isolated verification record](../../.audit/session-resources-verification.md) for scope and evidence.

Protocol references are the [official App Server guide](https://learn.chatgpt.com/docs/app-server) and [permission profile documentation](https://learn.chatgpt.com/docs/permissions).
