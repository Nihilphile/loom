# Runtime delivery

`CodexRuntime` implements the frozen Runtime interface in `src/server/runtime.ts`. Each execution owns one JSONL App Server process. Start and resume preserve thread identity. The handle exposes verified steering and interruption. `done` waits for process close. A completed turn whose process cannot exit is failed rather than delivered.

Events are `thread.started`, `assistant.delta`, `tool.started`, `tool.completed`, `usage`, and `log`. Log details retain incoming protocol method and params. Tool details contain the App Server item. Usage is the current execution's increment over resumed thread totals. Exact credential values supplied through token, secret, password, or key environment variables are redacted from event values and final text. Approval requests are declined. Unsupported interactive requests receive a JSON-RPC error.

The executable preference is `CODEX_CLI_PATH`, the latest installed Desktop executable on Windows, a native PATH executable, then the npm native binary. This machine's real tests used Desktop Codex 0.160.0. Generated 0.157.1 and 0.160.0 protocols were inspected. The 0.157.1 executable was not used for model smoke tests.

## Windows permissions

The runtime selects the unelevated Windows sandbox per child process. `CODEX_WINDOWS_SANDBOX=elevated` or the constructor option can select elevated mode. No global configuration is changed. The installed elevated sandbox failed all direct command probes with `helper_unknown_error: apply deny-read ACLs`. Unelevated mode successfully enforced the tested filesystem boundaries. No network isolation is claimed. Network access is enabled so the report CLI can reach the loopback server.

For `readOnly` with report `writableRoots`, Windows uses the first report root as the execution cwd, with only the report roots writable. The prompt names the original project by absolute path. The coordinator retains its original project cwd. Roots are canonicalized, must exist, and cannot include the whole reviewed project. Both absolute writes and relative traversal writes into the code directory were denied in the live test. Report writes and an authenticated loopback HTTP request succeeded from the sandboxed shell with credentials inherited from RuntimeInput.env.

Other platforms use an explicit named permission profile with filesystem-wide read access and exact writable report roots. This profile was accepted by the 0.160.0 protocol, but its filesystem enforcement was not tested on Linux or macOS. Windows unelevated mode explicitly rejects this split profile, which is why Windows relocates the execution cwd. There is no full-access fallback.

## Verification

`npm run typecheck` passes. The default test suite includes subprocess coverage for event normalization, resumed usage, steering, interruption, RPC errors, unexpected exit, stalled shutdown, initialization cancellation, approval denial, credential redaction, and rejection of unsafe report roots.

The following opt-in tests passed on 2026-10-08 with real Codex 0.160.0:

- `HARNESS_CODEX_SMOKE=1` starts a read-only thread and resumes it in a new process, recovering the original marker and real usage.
- `HARNESS_CODEX_PERMISSIONS_SMOKE=1` proves report writes, denied absolute and relative code writes, and an authenticated HTTP 200 from loopback.
- `HARNESS_CODEX_CONTROL_SMOKE=1` observes a real shell child PID, accepts `turn/steer`, interrupts the turn, and verifies both the App Server PID and shell command PID no longer exist when `done` resolves.

Run them with the environment variables set to `1`, then `npx tsx --test tests/runtime.test.ts`. Each live test is bounded and closes its runtime and temporary directory. The default suite skips live model calls.

The Model the Domain principle shaped the explicit starting/running/stopping/closed execution states. Standards and spec checks covered only the owned runtime, test, and report files. There are no added source comments or suppressions. Independent review remains with the coordinator.

Protocol references are the [official App Server guide](https://learn.chatgpt.com/docs/app-server) and [permission profile documentation](https://learn.chatgpt.com/docs/permissions).
