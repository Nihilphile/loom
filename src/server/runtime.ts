import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { startManagedProcess, type ManagedProcess } from "./managed-process.ts";
import type {
  AgentCommand,
  Runtime,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeInput,
  RuntimeResult,
  RuntimeOptions,
  Reasoning,
  Usage,
  RuntimeAcceptance,
  RuntimeResources,
} from "../shared/types.ts";

interface CodexRuntimeOptions {
  executable?: string;
  args?: string[];
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  idleTimeoutMs?: number;
  windowsSandbox?: "elevated" | "unelevated";
}

type JsonObject = Record<string, unknown>;
type ExecutionPermissionMode = NonNullable<RuntimeInput["permissionMode"]>;
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

class RpcRejection extends Error {}

const observerConfig: JsonObject = {
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.apps": false,
  "features.plugins": false,
  "features.hooks": false,
  "features.multi_agent": false,
  "agents.enabled": false,
  "features.browser_use": false,
  "features.computer_use": false,
  "features.image_generation": false,
  web_search: "disabled",
  notify: [],
  "shell_environment_policy.inherit": "none",
};

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

const agentFields = {
  requestId: { type: "string", minLength: 1 },
  title: { type: "string", minLength: 1 },
  prompt: { type: "string", minLength: 1 },
  access: { type: "string", enum: ["read", "write"] },
  model: { type: "string", minLength: 1 },
  reasoning: { type: "string", enum: reasoningValues },
  sessionId: { type: "string", minLength: 1 },
  executionId: { type: "string", minLength: 1 },
  sessionIds: { type: "array", items: { type: "string", minLength: 1 } },
};
type AgentField = keyof typeof agentFields;
const agentOperations: Record<
  AgentCommand["op"],
  { required: AgentField[]; optional: AgentField[] }
> = {
  spawn: {
    required: ["requestId", "title", "prompt"],
    optional: ["access", "model", "reasoning"],
  },
  send: { required: ["requestId", "sessionId", "prompt"], optional: [] },
  list: { required: [], optional: ["sessionIds"] },
  wait: { required: [], optional: ["sessionIds"] },
  integrate: {
    required: ["requestId", "sessionId", "executionId"],
    optional: [],
  },
  discard: {
    required: ["requestId", "sessionId", "executionId"],
    optional: [],
  },
  cancel: { required: ["sessionId"], optional: [] },
};
const agentToolDefinition = {
  type: "function",
  name: "loom_agent",
  description:
    "Manage Loom child sessions. Reuse requestId when retrying a mutation. Use list or wait to inspect children; integrate or discard a specific completed execution.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: Object.keys(agentOperations) },
      ...agentFields,
    },
    required: ["op"],
    additionalProperties: false,
    oneOf: Object.entries(agentOperations).map(([op, fields]) => ({
      properties: { op: { const: op } },
      required: fields.required,
    })),
  },
};

function agentCommand(value: unknown): AgentCommand {
  const command = object(value);
  const op = string(command.op);
  if (!Object.hasOwn(agentOperations, op))
    throw new Error("Invalid agent operation");
  const fields = agentOperations[op as AgentCommand["op"]];
  if (fields.required.some((key) => !(key in command)))
    throw new Error("Missing agent command field");
  for (const [key, value] of Object.entries(command)) {
    if (key === "op") continue;
    if (![...fields.required, ...fields.optional].includes(key as AgentField))
      throw new Error("Unexpected agent command field");
    if (key === "sessionIds") {
      if (
        !Array.isArray(value) ||
        value.some((id) => typeof id !== "string" || !id.trim())
      )
        throw new Error("Invalid sessionIds");
    } else if (
      typeof value !== "string" ||
      !value.trim() ||
      (key === "access" && value !== "read" && value !== "write") ||
      (key === "reasoning" && !reasoning(value))
    )
      throw new Error("Invalid agent command field");
  }
  return command as unknown as AgentCommand;
}

function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^(HARNESS|LOOM)/i.test(key) &&
        !/^UNIT_.*(REPORT|TOKEN|SECRET|KEY|PASSWORD|URL|ADDRESS)/i.test(key),
    ),
  );
}

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
  readonly capabilities = {
    inject: true,
    interrupt: true,
    readOnly: true,
    fork: true,
  };
  private readonly backends = new Map<string, CodexBackend>();
  private readonly launching = new Map<string, Promise<CodexBackend>>();
  private readonly discoveries = new Set<Promise<ManagedProcess>>();
  private closed = false;

  constructor(private readonly options: CodexRuntimeOptions = {}) {}

  async discoverOptions(cwd: string): Promise<RuntimeOptions> {
    if (this.closed) throw new Error("Runtime is closed");
    cwd = realpathSync.native(cwd);
    const starting = startManagedProcess(
      this.options.executable ?? executable(),
      this.options.args ?? ["app-server", "--listen", "stdio://"],
      {
        cwd,
        env: process.env,
      },
    );
    this.discoveries.add(starting);
    let managed: ManagedProcess;
    try { managed = await starting; }
    catch (error) { this.discoveries.delete(starting); throw error; }
    const child = managed.child;
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
    let finished = false;
    let exitTimer: NodeJS.Timeout | undefined;
    void managed.exited.then(() => {
      if (!finished) exitTimer = setTimeout(() => fail(new Error("Codex metadata process exited")), 250);
    });
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
      if (this.closed) throw new Error("Runtime is closed");
      await request("initialize", {
        clientInfo: { name: "loom", version: "0.1.0" },
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
      finished = true;
      clearTimeout(exitTimer);
      fail(new Error("Codex metadata request ended"));
      await managed.close();
      this.discoveries.delete(starting);
    }
  }

  async start(
    input: RuntimeInput,
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<RuntimeHandle> {
    if (this.closed) throw new Error("Runtime is closed");
    if (input.fork && (!input.observer || input.threadId))
      throw new Error("A fork requires a new observer session");
    if (input.observer) {
      const skills = await Promise.all(
        (input.skills ?? []).map(async (skill) => {
          const path = realpathSync.native(skill.path);
          if (!statSync(path).isFile() || statSync(path).size > 1_048_576)
            throw new Error("Observer skill must be a text file below 1 MiB");
          return `Explicit skill ${JSON.stringify(skill.name)} (${JSON.stringify(path)}):\n${await readFile(path, "utf8")}`;
        }),
      );
      input = {
        ...input,
        readOnly: true,
        writableRoots: [],
        env: {},
        skills: [],
        prompt: [...skills, input.prompt].join("\n\n"),
      };
    }
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
    const permissionMode: ExecutionPermissionMode =
      input.permissionMode === "inherit" && !input.readOnly && !input.observer && !input.child
        ? "inherit"
        : "workspace";
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
    if (input.delegation || input.child || input.observer)
      args.push("-c", "mcp_servers.loom.enabled=false");
    if (input.observer)
      for (const [key, value] of Object.entries(observerConfig))
        args.push("-c", `${key}=${JSON.stringify(value)}`);
    if (input.delegation || input.child)
      args.push("-c", "agents.enabled=false");
    const windowsSandbox = this.options.windowsSandbox ?? process.env.CODEX_WINDOWS_SANDBOX
      ?? (permissionMode === "workspace" ? "unelevated" : undefined);
    if (process.platform === "win32" && windowsSandbox)
      args.push(
        "-c",
        `windows.sandbox=${JSON.stringify(windowsSandbox)}`,
      );
    const owner = input.ownerId ?? randomUUID();
    if (this.launching.has(owner)) throw new Error("Session runtime is starting");
    const command = this.options.executable ?? executable();
    const launchArgs = this.options.args ?? args;
    const env = input.observer || input.child
      ? childEnvironment({ ...process.env, ...input.env })
      : { ...process.env, ...input.env };
    const configuration = JSON.stringify({ command, args: launchArgs, cwd: input.cwd, env,
      permissionMode, observer: input.observer, readOnly: input.readOnly, writableRoots: input.writableRoots });
    const launch = (async () => {
      let backend = this.backends.get(owner);
      if (backend?.state === "active") throw new Error("Session already has an active turn");
      if (backend && (backend.configuration !== configuration || !backend.usable)) {
        await backend.close();
        this.backends.delete(owner);
        backend = undefined;
      }
      if (!backend) {
        const managed = await startManagedProcess(command, launchArgs, { cwd: input.cwd, env });
        backend = new CodexBackend(managed, configuration, this.options);
        this.backends.set(owner, backend);
        const owned = backend;
        backend.onClosed = () => {
          if (this.backends.get(owner) === owned) this.backends.delete(owner);
        };
      }
      if (this.closed) {
        await backend.close();
        throw new Error("Runtime is closed");
      }
      return backend;
    })();
    this.launching.set(owner, launch);
    try {
      const backend = await launch;
      return backend.start(input, onEvent, permissionMode, !input.ownerId);
    } finally {
      if (this.launching.get(owner) === launch) this.launching.delete(owner);
    }
  }

  async resources(ownerId: string): Promise<RuntimeResources> {
    if (this.launching.has(ownerId)) return { state: "starting", processes: [] };
    return this.backends.get(ownerId)?.resources() ?? { state: "closed", processes: [] };
  }

  async stopResource(ownerId: string, resourceId: string): Promise<void> {
    const backend = this.backends.get(ownerId);
    if (!backend) throw new Error("Session has no managed processes");
    await backend.stopResource(resourceId);
  }

  async closeSession(ownerId: string): Promise<void> {
    const backend = await this.launching.get(ownerId) ?? this.backends.get(ownerId);
    await backend?.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.launching.values());
    const results = await Promise.allSettled([
      ...[...this.backends.values()].map(backend => backend.close()),
      ...[...this.discoveries].map(async pending => (await pending).close()),
    ]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

class CodexBackend {
  state: RuntimeResources["state"] = "idle";
  initialized = false;
  readonly previousTurns = new Set<string>();
  usage?: Usage;
  onClosed?: () => void;
  private sequence = 0;
  private execution?: CodexExecution;
  private idleTimer?: NodeJS.Timeout;
  private exitTimer?: NodeJS.Timeout;
  private processes: RuntimeResources["processes"] = [];
  private closing?: Promise<void>;
  private error?: string;
  private exited = false;
  private readonly lines;

  constructor(
    readonly managed: ManagedProcess,
    readonly configuration: string,
    private readonly options: CodexRuntimeOptions,
  ) {
    const child = managed.child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", line => {
      if (this.execution) this.execution.receive(line);
      else {
        try {
          const packet = object(JSON.parse(line));
          if (packet.id !== undefined && typeof packet.method === "string")
            child.stdin.write(JSON.stringify({ id: packet.id, error: { code: -32000, message: "No active turn" } }) + "\n");
        } catch {}
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.execution?.stderrReceived(chunk));
    child.stdin.on("error", error => this.failed(error));
    child.on("error", error => this.failed(error));
    child.on("exit", () => {
      if (child.pid !== managed.pid && this.state !== "closing" && this.state !== "closed") this.failed(new Error("Codex supervisor exited"));
    });
    void managed.exited.then(({ code, signal }) => {
      this.exited = true;
      if (this.state !== "closing" && this.state !== "closed") {
        // Backend exit and final stdout arrive on different OS pipes.
        this.exitTimer = setTimeout(() => this.failed(new Error(`Codex backend exited (${code ?? signal})`)), 250);
      }
    }, error => this.failed(error));
  }

  get usable() { return !this.exited && (this.state === "idle" || this.state === "active"); }
  nextId() { return ++this.sequence; }

  invalidate(error: unknown): void {
    if (this.state === "closing" || this.state === "closed") return;
    this.state = "failed";
    this.error = message(error);
  }

  start(input: RuntimeInput, emit: (event: RuntimeEvent) => void, mode: ExecutionPermissionMode, transient: boolean): RuntimeHandle {
    if (!this.usable || this.execution) throw new Error("Session runtime is unavailable or busy");
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.state = "active";
    const execution = new CodexExecution(this, input, emit, this.options, mode);
    this.execution = execution;
    execution.onFinish = (turnId) => {
      if (this.execution !== execution) return;
      if (turnId) this.previousTurns.add(turnId);
      this.execution = undefined;
      if (this.state === "closing" || this.state === "closed") return;
      if (this.state === "active") this.state = "idle";
      if (transient) void this.close().catch(() => {});
      else this.scheduleCleanup();
    };
    execution.start();
    return execution.handle;
  }

  private failed(error: unknown): void {
    if (this.state === "closed" || this.state === "closing") return;
    clearTimeout(this.exitTimer);
    this.error = message(error);
    this.state = "failed";
    this.execution?.transportFailed(error);
    if (this.state === "failed" && !this.idleTimer) this.scheduleCleanup();
  }

  private scheduleCleanup() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.idleTimer = undefined; void this.close().catch(() => {}); }, this.options.idleTimeoutMs ?? 300_000);
    this.idleTimer.unref();
  }

  async resources(): Promise<RuntimeResources> {
    if (this.state === "closed") return { state: "closed", processes: [] };
    try {
      this.processes = await this.managed.list();
      return { state: this.state, processes: this.processes, ...(this.error ? { error: this.error } : {}) };
    } catch (error) {
      return { state: "failed", processes: this.processes, error: `${message(error)}; showing the last confirmed process list` };
    }
  }

  async stopResource(id: string): Promise<void> {
    const resource = (await this.managed.list()).find(value => value.id === id);
    if (!resource) throw new Error("Resource no longer belongs to this session");
    if (resource.role === "backend") await this.close();
    else await this.managed.stop(id);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.state === "closed") return Promise.resolve();
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    clearTimeout(this.exitTimer);
    this.state = "closing";
    this.execution?.terminated();
    this.closing = this.managed.close().then(() => {
      this.state = "closed";
      this.error = undefined;
      this.lines.close();
      this.onClosed?.();
    }, error => {
      this.state = "failed";
      this.error = message(error);
      throw error;
    }).finally(() => { this.closing = undefined; });
    return this.closing;
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
  private threadId?: string;
  private turnId?: string;
  private usage?: Usage;
  private baseline?: Usage;
  private turnRequested = false;
  private readonly previousTurns = new Set<string>();
  private lastPreviousTurn?: string;
  private phase: "starting" | "running" | "closed" = "starting";
  private interrupted = false;
  private shutdownTimer?: NodeJS.Timeout;
  private stderr = "";
  private readonly secrets: string[];
  private resolveDone!: (result: RuntimeResult) => void;
  private resolveAccepted!: (result: RuntimeAcceptance) => void;
  private acceptance?: RuntimeAcceptance;
  private completedTurnId?: string;
  private initialization?: Promise<void>;
  private readonly toolReplies = new Map<unknown, () => void>();

  onFinish?: (turnId?: string) => void;

  constructor(
    private readonly backend: CodexBackend,
    private readonly input: RuntimeInput,
    private readonly onEvent: (event: RuntimeEvent) => void,
    private readonly options: CodexRuntimeOptions,
    private readonly permissionMode: ExecutionPermissionMode,
  ) {
    this.threadId = input.threadId;
    for (const id of backend.previousTurns) this.previousTurns.add(id);
    if (input.threadId) this.baseline = backend.usage;
    this.secrets = Object.entries(input.env ?? {})
      .filter(
        ([key, value]) =>
          /token|secret|password|key/i.test(key) && value.length > 0,
      )
      .map(([, value]) => value);
    const done = new Promise<RuntimeResult>((resolve) => {
      this.resolveDone = resolve;
    });
    const accepted = new Promise<RuntimeAcceptance>((resolve) => {
      this.resolveAccepted = resolve;
    });
    this.handle = {
      accepted,
      done,
      pid: backend.managed.pid,
      interrupt: () => this.interrupt(),
      inject: (text, input) => this.inject(text, input),
    };
  }

  stderrReceived(chunk: string): void {
    this.stderr = (this.stderr + chunk).slice(-8000);
    this.emit({ type: "log", text: chunk, detail: { source: "stderr" } });
  }

  transportFailed(error: unknown): void { this.fail(error); }

  terminated(): void {
    if (this.phase === "closed") return;
    this.interrupted = true;
    this.stop(this.snapshot("interrupted"));
  }

  start(): void {
    this.initialization = this.initialize().catch((error) => this.fail(error));
  }

  private async initialize(): Promise<void> {
    if (!this.backend.initialized) {
      await this.request("initialize", {
        clientInfo: { name: "loom", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: "initialized" });
      this.backend.initialized = true;
    }
    if (this.phase !== "starting") return;
    const reportProfile =
      this.input.readOnly && this.input.writableRoots?.length
        ? "new_harness_reports"
        : undefined;
    const config: JsonObject = {
      "shell_environment_policy.inherit": "all",
      "shell_environment_policy.set": this.input.env ?? {},
    };
    if (this.input.delegation || this.input.child || this.input.observer)
      config["mcp_servers.loom.enabled"] = false;
    if (this.input.delegation || this.input.child)
      config["agents.enabled"] = false;
    if (this.input.child) {
      config["shell_environment_policy.inherit"] = "none";
      config["shell_environment_policy.set"] = childEnvironment({
        ...process.env,
        ...this.input.env,
      });
    }
    if (this.input.observer) {
      Object.assign(config, observerConfig, {
        "shell_environment_policy.set": {},
      });
      const effective = object(
        await this.request("config/read", {
          cwd: this.input.cwd,
          includeLayers: false,
        }),
      );
      const settings = object(effective.config);
      const servers = Object.fromEntries(
        Object.keys(object(settings.mcp_servers)).map((name) => [
          name,
          { enabled: false },
        ]),
      );
      config.plugins = Object.fromEntries(
        Object.keys(object(settings.plugins)).map((name) => [
          name,
          { enabled: false },
        ]),
      );
      for (const [event, hooks] of Object.entries(object(settings.hooks)))
        if (Array.isArray(hooks)) config[`hooks.${event}`] = [];
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      config.mcp_servers = {
        ...servers,
        loom: { enabled: false },
        loom_observer: {
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL(`./observer-tools.${extension}`, import.meta.url),
            ),
            "--serve",
            this.input.cwd,
          ],
          enabled: true,
          required: true,
        },
      };
    }
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
    let inheritedPermissions: JsonObject = {};
    if (this.permissionMode === "inherit") {
      const effective = object(await this.request("config/read", {
        cwd: this.input.cwd,
        includeLayers: false,
      }));
      const settings = object(effective.config);
      const profile = string(settings.default_permissions);
      if (profile) inheritedPermissions = { permissions: profile };
      else if (settings.sandbox_mode === "read-only" || settings.sandbox_mode === "workspace-write" || settings.sandbox_mode === "danger-full-access")
        inheritedPermissions = { sandbox: settings.sandbox_mode };
    }
    const response = object(
      await this.request(
        this.input.fork
          ? "thread/fork"
          : this.threadId
            ? "thread/resume"
            : "thread/start",
        {
          ...(this.input.fork
            ? {
                threadId: this.input.fork.threadId,
                lastTurnId: this.input.fork.turnId,
                deferGoalContinuation: true,
              }
            : this.threadId
              ? { threadId: this.threadId }
              : {}),
          cwd: resolve(this.input.cwd),
          model: this.input.model,
          approvalPolicy: "never",
          ...(this.permissionMode === "inherit"
            ? inheritedPermissions
            : reportProfile
              ? { permissions: reportProfile }
              : { sandbox: this.input.readOnly ? "read-only" : "workspace-write" }),
          config,
          ...(!this.threadId &&
          !this.input.fork &&
          this.input.delegation === "managed" &&
          !this.input.observer
            ? { dynamicTools: [agentToolDefinition] }
            : {}),
        },
      ),
    );
    this.threadId = string(object(response.thread).id);
    if (this.input.fork && this.threadId === this.input.fork.threadId)
      throw new Error("Codex did not create an independent fork");
    const turns = object(response.thread).turns;
    if (
      this.input.fork &&
      (!Array.isArray(turns) ||
        string(object(turns.at(-1)).id) !== this.input.fork.turnId)
    )
      throw new Error("Codex fork did not preserve the requested checkpoint");
    if (Array.isArray(turns)) {
      for (const turn of turns) this.previousTurns.add(string(object(turn).id));
      this.lastPreviousTurn = string(object(turns.at(-1)).id) || undefined;
    }
    if (!this.threadId) throw new Error("Codex did not return a thread ID");
    if (this.input.observer) {
      const sandbox = object(response.sandbox);
      if (sandbox.type !== "readOnly" || sandbox.networkAccess !== false)
        throw new Error("Codex did not enforce the observer sandbox");
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = object(
          await this.request("mcpServerStatus/list", {
            threadId: this.threadId,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        );
        if (!Array.isArray(page.data))
          throw new Error("Codex did not report observer tool isolation");
        for (const value of page.data) {
          const server = object(value);
          if (
            server.name !== "loom_observer" &&
            server.runtimeStatus !== "disabled"
          )
            throw new Error(
              `Observer inherited an enabled tool server: ${string(server.name)}`,
            );
        }
        cursor = string(page.nextCursor) || undefined;
        if (cursor && cursors.has(cursor))
          throw new Error("Codex repeated its tool catalog cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    this.emit({
      type: "thread.started",
      threadId: this.threadId,
      ...(string(response.model) ? { model: string(response.model) } : {}),
    });
    if (this.phase !== "starting") return;
    const sandboxPolicy = this.input.readOnly
      ? { type: "readOnly", networkAccess: !this.input.observer }
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
    let turn: JsonObject;
    try {
      turn = object(
        await this.request("turn/start", {
          threadId: this.threadId,
          cwd: resolve(this.input.cwd),
          input: nativeInput(this.input.prompt, this.input),
          model: this.input.model,
          effort: this.input.reasoning,
          approvalPolicy: "never",
          ...(this.permissionMode === "inherit"
            ? {}
            : reportProfile
              ? { permissions: reportProfile }
              : { sandboxPolicy }),
        }),
      );
    } catch (error) {
      this.setAcceptance({
        status: error instanceof RpcRejection ? "rejected" : "uncertain",
        reason: message(error),
      });
      throw error;
    }
    this.turnId = string(object(turn.turn).id);
    if (!this.turnId) throw new Error("Codex did not return a turn ID");
    this.setAcceptance({
      status: "accepted",
      threadId: this.threadId,
      turnId: this.turnId,
    });
    if (this.phase !== "starting") return;
    this.phase = "running";
    this.emit({ type: "turn.started", detail: { turnId: this.turnId } });
  }

  private setAcceptance(result: RuntimeAcceptance): void {
    if (this.acceptance) return;
    this.acceptance = result;
    this.resolveAccepted(result);
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
    if (this.phase === "closed" || this.backend.managed.child.stdin.destroyed)
      throw new Error("Codex transport is closed");
    this.backend.managed.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.backend.nextId();
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

  receive(line: string): void {
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
          new RpcRejection(
            string(object(packet.error).message) || "Codex request failed",
          ),
        );
      else pending.resolve(packet.result);
      return;
    }
    const method = string(packet.method);
    const params = object(packet.params);
    if (packet.id !== undefined) {
      if (method === "item/tool/call") {
        this.callAgentTool(packet.id, params);
        return;
      }
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
    const notificationTurn = string(params.turnId || object(params.turn).id);
    if (method !== "thread/tokenUsage/updated" && notificationTurn &&
      (this.previousTurns.has(notificationTurn) || (this.turnId && notificationTurn !== this.turnId))) return;
    this.emit({ type: "log", detail: { method, params } });
    if (method === "model/rerouted" && string(params.toModel))
      this.emit({ type: "model.resolved", model: string(params.toModel) });
    const item = object(params.item);
    if (method === "turn/started") {
      const startedId = string(object(params.turn).id);
      if (this.previousTurns.has(startedId)) return;
      this.turnId = startedId || this.turnId;
      if (this.turnRequested && this.threadId && this.turnId)
        this.setAcceptance({
          status: "accepted",
          threadId: this.threadId,
          turnId: this.turnId,
        });
    }
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
        if (!previous) this.backend.usage = current;
        if (
          !this.turnRequested ||
          (previous && params.turnId === this.lastPreviousTurn && !this.usage)
        )
          this.baseline = current;
        else if (
          !previous &&
          ((!this.input.threadId && !this.input.fork) || this.baseline)
        ) {
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
      const completedId = string(turn.id);
      if (
        !this.turnRequested ||
        this.previousTurns.has(completedId) ||
        (this.turnId && completedId !== this.turnId)
      )
        return;
      if (completedId && this.threadId)
        this.setAcceptance({
          status: "accepted",
          threadId: this.threadId,
          turnId: completedId,
        });
      const status = turn.status;
      if (
        status === "completed" ||
        status === "interrupted" ||
        status === "failed"
      ) {
        if (status === "completed")
          this.completedTurnId = string(turn.id) || undefined;
        this.stop(
          this.snapshot(
            status,
            string(object(turn.error).message) || undefined,
          ),
        );
      } else this.fail(new Error("Codex returned an unknown turn status"));
    }
  }

  private cancelToolReplies(): void {
    for (const cancel of this.toolReplies.values()) cancel();
    this.toolReplies.clear();
  }

  private callAgentTool(id: unknown, params: JsonObject): void {
    if (this.toolReplies.has(id)) return;
    let settled = false;
    const reply = (success: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      this.toolReplies.delete(id);
      if (
        this.phase === "closed" ||
        this.backend.managed.child.stdin.destroyed ||
        this.backend.managed.child.stdin.writableEnded
      )
        return;
      try {
        this.write({
          id,
          result: {
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify(redact(value, this.secrets)) ?? "null",
              },
            ],
            success,
          },
        });
      } catch (error) {
        this.fail(error);
      }
    };
    if (
      this.input.delegation !== "managed" ||
      this.input.observer ||
      !this.input.agentTool ||
      params.tool !== "loom_agent" ||
      params.threadId !== this.threadId ||
      params.turnId !== this.turnId ||
      !this.turnRequested ||
      this.interrupted
    ) {
      reply(false, { error: "Agent tool is unavailable for this execution" });
      return;
    }
    let command: AgentCommand;
    try {
      command = agentCommand(params.arguments);
    } catch (error) {
      reply(false, { error: message(error) });
      return;
    }
    this.toolReplies.set(id, () =>
      reply(false, { error: "Execution stopped" }),
    );
    void Promise.resolve()
      .then(() => {
        if (settled) return;
        return this.input.agentTool!(command);
      })
      .then(
        (result) => reply(true, result),
        () => reply(false, { error: "Agent command failed" }),
      );
  }

  private snapshot(
    status: RuntimeResult["status"],
    error?: string,
  ): RuntimeResult {
    return {
      status,
      threadId: this.threadId,
      ...(this.completedTurnId
        ? { completedTurnId: this.completedTurnId }
        : {}),
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
    if (this.phase === "closed") return;
    this.backend.invalidate(error);
    this.setAcceptance({
      status:
        this.turnRequested && !(error instanceof RpcRejection)
          ? "uncertain"
          : "rejected",
      reason: message(error),
    });
    this.stop(
      this.snapshot(
        this.interrupted ? "interrupted" : "failed",
        message(error),
      ),
    );
    void this.backend.close().catch(() => {});
  }

  private stop(result: RuntimeResult): void {
    if (this.phase === "closed") return;
    this.cancelToolReplies();
    this.phase = "closed";
    this.setAcceptance({
      status: this.turnRequested ? "uncertain" : "rejected",
      reason: "Execution stopped before turn acceptance",
    });
    clearTimeout(this.shutdownTimer);
    this.rejectPending(new Error("Codex turn ended"));
    this.onFinish?.(this.turnId ?? result.completedTurnId);
    this.resolveDone(result);
  }

  private async interrupt(): Promise<void> {
    if (this.phase === "closed") return;
    this.interrupted = true;
    this.cancelToolReplies();
    this.shutdownTimer ??= setTimeout(() => {
      this.stop(this.snapshot("interrupted"));
      void this.backend.close().catch(() => {});
    }, this.options.shutdownTimeoutMs ?? 5000);
    if (this.threadId && this.turnId) {
      void this.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.turnId,
      }).catch(error => {
        if (this.phase !== "closed") {
          this.fail(error);
          void this.backend.close().catch(() => {});
        }
      });
    } else {
      this.stop(this.snapshot("interrupted"));
      await this.backend.close();
    }
    await this.handle.done;
  }

  private async inject(
    text: string,
    input?: Pick<RuntimeInput, "attachments" | "skills">,
  ): Promise<boolean> {
    if (this.input.observer) return false;
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
