import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export interface ManagedProcessInfo {
  id: string;
  pid: number;
  name: string;
  role: "backend" | "descendant";
  memoryBytes: number;
}

export interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  list(): Promise<ManagedProcessInfo[]>;
  stop(id: string): Promise<void>;
  close(): Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function startManagedProcess(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ManagedProcess> {
  return process.platform === "win32"
    ? startWindows(executable, args, options)
    : startPosix(executable, args, options);
}

async function startWindows(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<ManagedProcess> {
  const pipeName = `loom-owner-${randomUUID()}`;
  let socket: Socket | undefined;
  let resolveReady!: (pid: number) => void;
  let rejectReady!: (error: Error) => void;
  let resolveExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExit = resolve; });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let sequence = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  const fail = (error: Error) => {
    rejectReady(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    resolveExit({ code: 1, signal: null });
  };
  const server = createServer((connection) => {
    if (socket) { connection.destroy(); return; }
    socket = connection;
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) { connection.destroy(new Error("Process owner response exceeded limit")); return; }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === "ready" && Number.isSafeInteger(message.pid) && message.pid > 0) resolveReady(message.pid);
          else if (message.type === "exit") resolveExit({ code: message.code, signal: null });
          else if (message.type === "fault") fail(new Error(String(message.error)));
          else if (Number.isSafeInteger(message.id)) {
            const request = pending.get(message.id);
            if (!request) continue;
            pending.delete(message.id); clearTimeout(request.timer);
            if (message.error) request.reject(new Error(String(message.error)));
            else request.resolve(message.result);
          }
        } catch (error) { connection.destroy(new Error(`Invalid process owner response: ${errorText(error)}`)); }
      }
    });
    connection.on("error", fail);
    connection.on("close", () => { if (!closed) fail(new Error("Process owner control channel closed")); });
    connection.write(JSON.stringify({ executable, args, cwd: options.cwd }) + "\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(`\\\\.\\pipe\\${pipeName}`, resolve);
  });
  const script = fileURLToPath(new URL("./windows-process-owner.ps1", import.meta.url));
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-PipeName", pipeName], {
    ...options, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let startupError = "";
  const captureError = (data: Buffer) => { startupError = (startupError + data.toString()).slice(-4000); };
  child.stderr.on("data", captureError);
  child.on("error", fail);
  let helperGone = false;
  const helperExited = new Promise<void>((resolve) => child.once("exit", (code, signal) => {
    helperGone = true;
    resolve();
    if (!closed) fail(new Error(`Process owner exited (${code ?? signal})${startupError ? `: ${startupError}` : ""}`));
  }));
  const timer = setTimeout(() => fail(new Error("Process owner startup timed out")), 20000);
  let pid: number;
  try { pid = await ready; }
  catch (error) {
    socket?.destroy(); server.close(); child.kill();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    throw error;
  } finally { clearTimeout(timer); child.stderr.off("data", captureError); }
  const request = (method: string, resourceId?: string): Promise<unknown> => {
    if (!socket || socket.destroyed) return Promise.reject(new Error("Process owner is disconnected"));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Process ${method} timed out`)); }, 8000);
      pending.set(id, { resolve, reject, timer });
      socket!.write(JSON.stringify({ id, method, resourceId }) + "\n");
    });
  };
  return {
    child, pid, exited,
    async list() { return closed ? [] : await request("list") as ManagedProcessInfo[]; },
    async stop(id) { if (closed) throw new Error("Session resources are closed"); await request("stop", id); },
    close() {
      return closing ??= (async () => {
        let failure: unknown;
        let cleanupConfirmed = false;
        try { await request("close"); cleanupConfirmed = true; }
        catch (error) { failure = error; }
        finally {
          socket?.destroy(); server.close();
          if (!helperGone) {
            await Promise.race([helperExited, pause(1500)]);
            if (!helperGone) {
              if (!child.kill()) failure = new Error("Process owner could not be terminated");
              await Promise.race([helperExited, pause(1500)]);
            }
          }
          closed = cleanupConfirmed;
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        }
        if (!closed) throw new Error(`Session cleanup could not be confirmed${failure ? `: ${errorText(failure)}` : ""}`);
      })();
    },
  };
}

async function linuxProcess(pid: number): Promise<(ManagedProcessInfo & { group: number }) | undefined> {
  try {
    const [stat, status] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/status`, "utf8")]);
    const end = stat.lastIndexOf(")");
    const fields = stat.slice(end + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return undefined;
    return { id: `${pid}:${fields[19]}`, pid, name: stat.slice(stat.indexOf("(") + 1, end), role: "descendant", group: Number(fields[2]), memoryBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) * 1024 };
  } catch { return undefined; }
}

async function startPosix(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<ManagedProcess> {
  const child = spawn(executable, args, { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: 1, signal: null }));
  });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const pid = child.pid!;
  const root = await linuxProcess(pid);
  const known = new Map<number, string>();
  if (root) known.set(pid, root.id);
  let closed = false;
  let closing: Promise<void> | undefined;
  const list = async (): Promise<ManagedProcessInfo[]> => {
    if (closed) return [];
    if (process.platform !== "linux") return child.exitCode === null && child.signalCode === null
      ? [{ id: `backend:${pid}`, pid, name: executable, role: "backend", memoryBytes: 0 }] : [];
    const rows = await Promise.all((await readdir("/proc")).filter(value => /^\d+$/.test(value)).map(value => linuxProcess(Number(value))));
    const groupOwned = rows.some(value => value?.group === pid && known.get(value.pid) === value.id);
    return rows.filter((value): value is NonNullable<typeof value> => !!value && ((groupOwned && value.group === pid) || known.get(value.pid) === value.id))
      .map(({ group, ...value }) => { known.set(value.pid, value.id); return { ...value, role: value.pid === pid ? "backend" : "descendant" }; });
  };
  const tracker = process.platform === "linux" ? setInterval(() => { void list().catch(() => {}); }, 500) : undefined;
  tracker?.unref();
  const signal = (target: number, name: NodeJS.Signals) => {
    try { process.kill(target, name); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  };
  return {
    child, pid, exited, list,
    async stop(id) {
      const found = (await list()).find(value => value.id === id);
      if (!found) throw new Error("Resource is not owned by this session");
      if (process.platform === "linux" && (await linuxProcess(found.pid))?.id !== found.id) throw new Error("Session resource has exited");
      signal(found.pid, "SIGKILL");
    },
    close() {
      return closing ??= (async () => {
        clearInterval(tracker);
        child.stdin.end();
        for (const force of ["SIGTERM", "SIGKILL"] as const) {
          const members = await list();
          if (process.platform === "linux") {
            for (const value of members) {
              const current = await linuxProcess(value.pid);
              if (current?.id !== value.id) continue;
              signal(current.group === pid ? -pid : value.pid, force);
            }
          } else if (members.length) signal(-pid, force);
          const deadline = Date.now() + 1000;
          while ((await list()).length && Date.now() < deadline) await pause(40);
        }
        const remaining = await list();
        closed = remaining.length === 0;
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        if (remaining.length) throw new Error("Session processes did not exit");
      })();
    },
  };
}
