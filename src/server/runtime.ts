import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type {
  Runtime,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeInput,
  RuntimeResult,
  RuntimeOptions,
  Reasoning,
  Usage,
} from "../shared/types.ts";

interface CodexRuntimeOptions {
  executable?: string;
  args?: string[];
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  windowsSandbox?: "elevated" | "unelevated";
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function nativeInput(
  text: string,
  input: Pick<RuntimeInput, "attachments" | "skills"> = {},
): JsonObject[] {
  const files = (input.attachments ?? []).filter(
    (attachment) => attachment.kind === "file",
  );
  const prompt = [
    text.trim() ? text : "",
    ...files.map(
      (file) =>
        `Read the attached file ${JSON.stringify(file.name)} at ${JSON.stringify(file.path)}.`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    ...(prompt ? [{ type: "text", text: prompt, text_elements: [] }] : []),
    ...(input.attachments ?? [])
      .filter((attachment) => attachment.kind === "image")
      .map((image) => ({ type: "localImage", path: image.path })),
    ...(input.skills ?? []).map((skill) => ({
      type: "skill",
      name: skill.name,
      path: skill.path,
    })),
  ];
}

const reasoningValues: Reasoning[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const reasoning = (value: unknown): value is Reasoning =>
  reasoningValues.includes(value as Reasoning);

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string")
    return secrets.reduce(
      (text, secret) => text.replaceAll(secret, "[redacted]"),
      value,
    );
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]),
    );
  return value;
}

function executable(): string {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  if (process.platform === "win32") {
    const desktop = join(
      process.env.LOCALAPPDATA ?? "",
      "OpenAI",
      "Codex",
      "bin",
    );
    if (existsSync(desktop)) {
      for (const version of readdirSync(desktop).sort(
        (a, b) =>
          statSync(join(desktop, b)).mtimeMs -
          statSync(join(desktop, a)).mtimeMs,
      )) {
        const candidate = join(desktop, version, "codex.exe");
        if (existsSync(candidate)) return candidate;
      }
    }
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      const candidate = join(directory, "codex.exe");
      if (existsSync(candidate)) return candidate;
    }
    const npm = join(
      process.env.APPDATA ?? "",
      "npm",
      "node_modules",
      "@openai",
    );
    const candidate = join(
      npm,
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    if (existsSync(candidate)) return candidate;
  }
  return "codex";
}

export class CodexRuntime implements Runtime {
  readonly name = "Codex App Server";
  readonly capabilities = { inject: true, interrupt: true, readOnly: true };
  private readonly active = new Set<RuntimeHandle>();
  private closed = false;

  constructor(private readonly options: CodexRuntimeOptions = {}) {}

  async discoverOptions(cwd: string): Promise<RuntimeOptions> {
    if (this.closed) throw new Error("Runtime is closed");
    cwd = realpathSync.native(cwd);
    const child = spawn(
      this.options.executable ?? executable(),
      this.options.args ?? ["app-server", "--listen", "stdio://"],
      {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let sequence = 0;
    const pending = new Map<
      number,
      {
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: NodeJS.Timeout;
      }
    >();
    const fail = (error: Error) => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
    };
    const exited = new Promise<void>((resolve) =>
      child.on("close", () => {
        fail(new Error("Codex metadata process exited"));
        resolve();
      }),
    );
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stderr.resume();
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const packet = object(JSON.parse(line));
        const request = pending.get(Number(packet.id));
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(Number(packet.id));
        if (packet.error)
          request.reject(
            new Error(
              string(object(packet.error).message) ||
                "Codex metadata request failed",
            ),
          );
        else request.resolve(packet.result);
      } catch {
        fail(new Error("Codex emitted invalid metadata JSON"));
      }
    });
    const request = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex ${method} timed out`));
        }, this.options.requestTimeoutMs ?? 30_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    try {
      await request("initialize", {
        clientInfo: { name: "new_harness", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const result: RuntimeOptions = { models: [], skills: [], warnings: [] };
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = object(
          await request("model/list", {
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        );
        if (!Array.isArray(page.data))
          throw new Error("Codex returned an invalid model catalog");
        for (const value of page.data) {
          const model = object(value);
          if (model.hidden === true || !string(model.model)) continue;
          result.models.push({
            id: string(model.model),
            name: string(model.displayName) || string(model.model),
            reasoning: (Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts
              : []
            )
              .map((entry) => object(entry).reasoningEffort)
              .filter(reasoning),
            ...(reasoning(model.defaultReasoningEffort)
              ? { defaultReasoning: model.defaultReasoningEffort }
              : {}),
            isDefault: model.isDefault === true,
            ...(Array.isArray(model.inputModalities)
              ? {
                  inputModalities: model.inputModalities.filter(
                    (value): value is string => typeof value === "string",
                  ),
                }
              : {}),
          });
        }
        cursor = string(page.nextCursor) || undefined;
        if (cursor && cursors.has(cursor))
          throw new Error("Codex repeated its model catalog cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const skills = object(
        await request("skills/list", { cwds: [cwd], forceReload: true }),
      );
      if (!Array.isArray(skills.data))
        throw new Error("Codex returned an invalid skill catalog");
      for (const value of skills.data) {
        const group = object(value);
        for (const value of Array.isArray(group.skills) ? group.skills : []) {
          const skill = object(value);
          if (
            skill.enabled === false ||
            !string(skill.name) ||
            !string(skill.path)
          )
            continue;
          result.skills.push({
            name: string(skill.name),
            path: string(skill.path),
            description: string(skill.description),
          });
        }
        for (const value of Array.isArray(group.errors) ? group.errors : []) {
          const error = object(value);
          result.warnings.push(
            `${string(error.path)}: ${string(error.message) || "Skill discovery failed"}`,
          );
        }
      }
      return result;
    } finally {
      child.stdin.end();
      const timer = setTimeout(
        () => child.kill(),
        this.options.shutdownTimeoutMs ?? 5000,
      );
      await exited;
      clearTimeout(timer);
    }
  }

  async start(
    input: RuntimeInput,
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<RuntimeHandle> {
    if (this.closed) throw new Error("Runtime is closed");
    input = {
      ...input,
      cwd: realpathSync.native(input.cwd),
      writableRoots: input.writableRoots?.map((root) =>
        realpathSync.native(root),
      ),
    };
    if (input.readOnly)
      for (const root of input.writableRoots ?? []) {
        const path = relative(root, input.cwd);
        if (
          path === "" ||
          (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
        ) {
          throw new Error(
            "Read-only writable roots cannot include the project directory",
          );
        }
      }
    const reportCwd =
      process.platform === "win32" && input.readOnly
        ? input.writableRoots?.[0]
        : undefined;
    if (reportCwd)
      input = {
        ...input,
        cwd: reportCwd,
        readOnly: false,
        prompt: `The project to review is ${input.cwd}. The execution directory is ${reportCwd}. Only the report directories are writable. Inspect the project using its absolute path.\n\n${input.prompt}`,
      };
    const args = ["app-server", "--listen", "stdio://"];
    if (process.platform === "win32")
      args.push(
        "-c",
        `windows.sandbox=${JSON.stringify(this.options.windowsSandbox ?? process.env.CODEX_WINDOWS_SANDBOX ?? "unelevated")}`,
      );
    const child = spawn(
      this.options.executable ?? executable(),
      this.options.args ?? args,
      {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const execution = new CodexExecution(child, input, onEvent, this.options);
    const handle = execution.handle;
    this.active.add(handle);
    void handle.done.then(() => this.active.delete(handle));
    execution.start();
    return handle;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active].map((handle) => handle.interrupt()));
  }
}

class CodexExecution {
  readonly handle: RuntimeHandle;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly messages = new Map<string, string>();
  private sequence = 0;
  private threadId?: string;
  private turnId?: string;
  private usage?: Usage;
  private baseline?: Usage;
  private turnRequested = false;
  private readonly previousTurns = new Set<string>();
  private lastPreviousTurn?: string;
  private phase: "starting" | "running" | "stopping" | "closed" = "starting";
  private interrupted = false;
  private result?: RuntimeResult;
  private shutdownTimer?: NodeJS.Timeout;
  private stderr = "";
  private readonly secrets: string[];
  private resolveDone!: (result: RuntimeResult) => void;
  private initialization?: Promise<void>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly input: RuntimeInput,
    private readonly onEvent: (event: RuntimeEvent) => void,
    private readonly options: CodexRuntimeOptions,
  ) {
    this.threadId = input.threadId;
    this.secrets = Object.entries(input.env ?? {})
      .filter(
        ([key, value]) =>
          /token|secret|password|key/i.test(key) && value.length > 0,
      )
      .map(([, value]) => value);
    const done = new Promise<RuntimeResult>((resolve) => {
      this.resolveDone = resolve;
    });
    this.handle = {
      done,
      pid: child.pid,
      interrupt: () => this.interrupt(),
      inject: (text, input) => this.inject(text, input),
    };
    createInterface({ input: child.stdout }).on("line", (line) =>
      this.receive(line),
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
      this.emit({ type: "log", text: chunk, detail: { source: "stderr" } });
    });
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => {
      this.phase = "closed";
      clearTimeout(this.shutdownTimer);
      this.rejectPending(new Error("Codex process exited"));
      if (this.result?.status === "completed" && code !== 0)
        this.result = this.snapshot(
          "failed",
          `Codex exited abnormally after turn completion (${code ?? signal})`,
        );
      this.resolveDone(
        this.result ??
          this.snapshot(
            this.interrupted ? "interrupted" : "failed",
            this.interrupted
              ? undefined
              : `Codex exited before turn completion (${code ?? signal}). ${this.stderr}`,
          ),
      );
    });
  }

  start(): void {
    this.initialization = this.initialize().catch((error) => this.fail(error));
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "new_harness", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized" });
    if (this.phase !== "starting") return;
    const reportProfile =
      this.input.readOnly && this.input.writableRoots?.length
        ? "new_harness_reports"
        : undefined;
    const config: JsonObject = {
      "shell_environment_policy.inherit": "all",
      "shell_environment_policy.set": this.input.env ?? {},
    };
    if (reportProfile)
      config[`permissions.${reportProfile}`] = {
        filesystem: {
          ":root": "read",
          ...Object.fromEntries(
            this.input.writableRoots!.map((root) => [resolve(root), "write"]),
          ),
        },
        network: { enabled: true },
      };
    const response = object(
      await this.request(this.threadId ? "thread/resume" : "thread/start", {
        ...(this.threadId ? { threadId: this.threadId } : {}),
        cwd: resolve(this.input.cwd),
        model: this.input.model,
        approvalPolicy: "never",
        ...(reportProfile
          ? { permissions: reportProfile }
          : { sandbox: this.input.readOnly ? "read-only" : "workspace-write" }),
        config,
      }),
    );
    this.threadId = string(object(response.thread).id);
    const turns = object(response.thread).turns;
    if (Array.isArray(turns)) {
      for (const turn of turns) this.previousTurns.add(string(object(turn).id));
      this.lastPreviousTurn = string(object(turns.at(-1)).id) || undefined;
    }
    if (!this.threadId) throw new Error("Codex did not return a thread ID");
    this.emit({
      type: "thread.started",
      threadId: this.threadId,
      ...(string(response.model) ? { model: string(response.model) } : {}),
    });
    if (this.phase !== "starting") return;
    const sandboxPolicy = this.input.readOnly
      ? { type: "readOnly", networkAccess: true }
      : {
          type: "workspaceWrite",
          writableRoots: (this.input.writableRoots ?? []).map((root) =>
            resolve(root),
          ),
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        };
    this.turnRequested = true;
    const turn = object(
      await this.request("turn/start", {
        threadId: this.threadId,
        cwd: resolve(this.input.cwd),
        input: nativeInput(this.input.prompt, this.input),
        model: this.input.model,
        effort: this.input.reasoning,
        approvalPolicy: "never",
        ...(reportProfile ? { permissions: reportProfile } : { sandboxPolicy }),
      }),
    );
    if (this.phase !== "starting") return;
    this.turnId = string(object(turn.turn).id);
    if (!this.turnId) throw new Error("Codex did not return a turn ID");
    this.phase = "running";
    this.emit({ type: "turn.started", detail: { turnId: this.turnId } });
  }

  private emit(event: RuntimeEvent): void {
    try {
      this.onEvent({
        threadId: this.threadId,
        ...event,
        ...(event.text !== undefined
          ? { text: string(redact(event.text, this.secrets)) }
          : {}),
        ...(event.detail !== undefined
          ? { detail: redact(event.detail, this.secrets) }
          : {}),
      });
    } catch (error) {
      this.fail(new Error(`Runtime event consumer failed: ${message(error)}`));
    }
  }

  private write(value: unknown): void {
    if (this.phase === "closed" || this.child.stdin.destroyed)
      throw new Error("Codex transport is closed");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private receive(line: string): void {
    if (this.phase === "closed") return;
    let packet: JsonObject;
    try {
      packet = object(JSON.parse(line));
    } catch {
      this.fail(new Error("Codex emitted invalid JSON"));
      return;
    }
    if (packet.id !== undefined && typeof packet.method !== "string") {
      const pending = this.pending.get(Number(packet.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(packet.id));
      if (packet.error)
        pending.reject(
          new Error(
            string(object(packet.error).message) || "Codex request failed",
          ),
        );
      else pending.resolve(packet.result);
      return;
    }
    const method = string(packet.method);
    const params = object(packet.params);
    if (packet.id !== undefined) {
      this.emit({
        type: "log",
        text: `Declined unsupported server request: ${method}`,
        detail: { method, params },
      });
      try {
        if (
          method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval"
        ) {
          this.write({ id: packet.id, result: { decision: "decline" } });
        } else if (method === "item/permissions/requestApproval") {
          this.write({
            id: packet.id,
            result: { permissions: {}, scope: "turn" },
          });
        } else
          this.write({
            id: packet.id,
            error: {
              code: -32601,
              message: "This harness does not support interactive requests",
            },
          });
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    if (params.threadId && this.threadId && params.threadId !== this.threadId)
      return;
    this.emit({ type: "log", detail: { method, params } });
    if (method === "model/rerouted" && string(params.toModel))
      this.emit({ type: "model.resolved", model: string(params.toModel) });
    const item = object(params.item);
    if (method === "turn/started")
      this.turnId = string(object(params.turn).id) || this.turnId;
    if (method === "item/agentMessage/delta") {
      const id = string(params.itemId);
      const delta = string(params.delta);
      this.messages.set(id, (this.messages.get(id) ?? "") + delta);
      this.emit({ type: "assistant.delta", itemId: id, text: delta });
    }
    if (method === "item/completed" && item.type === "agentMessage") {
      const id = string(item.id);
      const text = string(item.text);
      if (!this.messages.has(id))
        this.emit({ type: "assistant.delta", itemId: id, text });
      this.messages.set(id, text);
    }
    if (
      (method === "item/started" || method === "item/completed") &&
      /^(commandExecution|fileChange|mcpToolCall|dynamicToolCall|webSearch|imageGeneration|collabAgentToolCall|computerUse)$/.test(
        string(item.type),
      )
    ) {
      this.emit({
        type: method === "item/started" ? "tool.started" : "tool.completed",
        itemId: string(item.id),
        detail: item,
      });
    }
    if (method === "thread/tokenUsage/updated") {
      const tokenUsage = object(params.tokenUsage);
      const total = object(tokenUsage.total);
      const previous = this.previousTurns.has(string(params.turnId));
      const lastTokens = object(tokenUsage.last).totalTokens;
      const window = tokenUsage.modelContextWindow;
      if (
        !previous &&
        typeof lastTokens === "number" &&
        Number.isFinite(lastTokens) &&
        lastTokens >= 0
      ) {
        this.emit({
          type: "context.usage",
          contextUsage: {
            tokens: lastTokens,
            window:
              typeof window === "number" &&
              Number.isFinite(window) &&
              window > 0
                ? window
                : null,
          },
        });
      }
      const values = [
        total.inputTokens,
        total.cachedInputTokens,
        total.outputTokens,
      ];
      if (
        values.every(
          (value) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0,
        )
      ) {
        const current = {
          inputTokens: Number(values[0]),
          cachedInputTokens: Number(values[1]),
          outputTokens: Number(values[2]),
        };
        if (
          !this.turnRequested ||
          (previous && params.turnId === this.lastPreviousTurn && !this.usage)
        )
          this.baseline = current;
        else if (!previous && (!this.input.threadId || this.baseline)) {
          this.usage = {
            inputTokens:
              current.inputTokens - (this.baseline?.inputTokens ?? 0),
            cachedInputTokens:
              current.cachedInputTokens -
              (this.baseline?.cachedInputTokens ?? 0),
            outputTokens:
              current.outputTokens - (this.baseline?.outputTokens ?? 0),
          };
          if (Object.values(this.usage).some((value) => value < 0))
            this.usage = undefined;
          else this.emit({ type: "usage", usage: this.usage });
        }
      }
    }
    if (method === "turn/completed") {
      const turn = object(params.turn);
      const status = turn.status;
      if (
        status === "completed" ||
        status === "interrupted" ||
        status === "failed"
      ) {
        this.stop(
          this.snapshot(
            status,
            string(object(turn.error).message) || undefined,
          ),
        );
      } else this.fail(new Error("Codex returned an unknown turn status"));
    }
  }

  private snapshot(
    status: RuntimeResult["status"],
    error?: string,
  ): RuntimeResult {
    return {
      status,
      threadId: this.threadId,
      text: string(
        redact([...this.messages.values()].join("\n"), this.secrets),
      ),
      usage: this.usage,
      ...(error ? { error: string(redact(error, this.secrets)) } : {}),
    };
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: unknown): void {
    if (this.phase === "stopping" || this.phase === "closed") return;
    this.stop(
      this.snapshot(
        this.interrupted ? "interrupted" : "failed",
        message(error),
      ),
    );
  }

  private stop(result: RuntimeResult): void {
    if (this.phase === "stopping" || this.phase === "closed") return;
    this.phase = "stopping";
    this.result = result;
    clearTimeout(this.shutdownTimer);
    this.rejectPending(new Error("Codex execution stopped"));
    this.child.stdin.end();
    this.shutdownTimer = setTimeout(
      () => this.kill(),
      this.options.shutdownTimeoutMs ?? 5000,
    );
  }

  private kill(): void {
    if (this.phase === "closed" || !this.child.pid) return;
    if (this.result?.status === "completed")
      this.result = this.snapshot(
        "failed",
        "Codex process did not exit after turn completion",
      );
    if (process.platform === "win32") {
      const killer = spawn(
        "taskkill",
        ["/pid", String(this.child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.on("error", () => this.child.kill("SIGKILL"));
      killer.on("exit", (code) => {
        if (code !== 0) this.child.kill("SIGKILL");
      });
    } else {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {
        this.child.kill("SIGKILL");
      }
    }
  }

  private async interrupt(): Promise<void> {
    if (this.phase === "closed") return;
    if (this.phase === "stopping") {
      await this.handle.done;
      return;
    }
    this.interrupted = true;
    if (this.threadId && this.turnId) {
      this.shutdownTimer ??= setTimeout(() => {
        this.stop(this.snapshot("interrupted"));
        this.kill();
      }, this.options.shutdownTimeoutMs ?? 5000);
      try {
        await this.request("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.turnId,
        });
      } catch (error) {
        this.fail(error);
      }
    } else this.stop(this.snapshot("interrupted"));
    await this.handle.done;
  }

  private async inject(
    text: string,
    input?: Pick<RuntimeInput, "attachments" | "skills">,
  ): Promise<boolean> {
    const items = nativeInput(text, input);
    if (this.phase === "starting") await this.initialization;
    if (
      this.phase !== "running" ||
      !this.threadId ||
      !this.turnId ||
      !items.length
    )
      return false;
    try {
      const response = object(
        await this.request("turn/steer", {
          threadId: this.threadId,
          expectedTurnId: this.turnId,
          input: items,
        }),
      );
      return response.turnId === this.turnId;
    } catch {
      return false;
    }
  }
}
