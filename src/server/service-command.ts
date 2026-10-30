import { spawn } from "node:child_process";
import { openSync, closeSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v4";
import { readServiceRecord, replaceServiceFile, serviceDirectory, serviceInfoSchema, servicePidAlive, serviceProcessAlive, type ServiceCommand, type ServiceRecord, type ServiceInfo } from "./service.ts";

const firstUpgrade = "当前地址没有可管理的 Loom 服务。若旧服务仍在运行，请在原终端按一次 Ctrl+C，再运行 npm start。";
type Probe = { kind: "offline" | "closing" } | { kind: "online"; info: ServiceInfo };
async function probe(url: URL, record?: ServiceRecord): Promise<Probe> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/service", url), {
      headers: record ? { "x-loom-service-key": record.controlToken, "x-loom-service-instance": record.instanceId } : {},
      signal: AbortSignal.timeout(1000), redirect: "error",
    });
  } catch (error) {
    if (error instanceof TypeError && error.cause instanceof Error && "code" in error.cause && error.cause.code === "ECONNREFUSED") return { kind: "offline" };
    if (record) {
      const latest = readServiceRecord(Number(url.port || 80));
      if (latest?.instanceId !== record.instanceId || latest.state !== "ready") return { kind: "closing" };
    }
    throw error;
  }
  if (response.status === 503 && record) return { kind: "closing" };
  if (!response.ok) {
    if (record && readServiceRecord(Number(url.port || 80))?.instanceId !== record.instanceId) return { kind: "closing" };
    throw new Error(firstUpgrade);
  }
  const parsed = serviceInfoSchema.safeParse(await response.json());
  if (!parsed.success || !record || parsed.data.instanceId !== record.instanceId) throw new Error(firstUpgrade);
  return { kind: "online", info: parsed.data };
}
const launchSchema = z.object({ ownerPid: z.number().int().positive(), id: z.uuid(), successorPid: z.number().int().positive().optional() });
function readLaunch(port: number) {
  try {
    return launchSchema.parse(JSON.parse(readFileSync(join(serviceDirectory(), port + ".launch"), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
function activeLaunch(port: number) {
  const launch = readLaunch(port);
  return !!launch && (servicePidAlive(launch.ownerPid) || (launch.successorPid !== undefined && servicePidAlive(launch.successorPid)));
}
async function startDefault(port: number) {
  const lock = join(serviceDirectory(), port + ".launch");
  const launch: z.infer<typeof launchSchema> = { ownerPid: process.pid, id: randomUUID() };
  mkdirSync(serviceDirectory(), { recursive: true });
  const claim = () => {
    try { writeFileSync(lock, JSON.stringify(launch), { flag: "wx", mode: 0o600 }); return true; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      return false;
    }
  };
  if (!claim()) {
    if (activeLaunch(port)) return () => {};
    try { unlinkSync(lock); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (!claim()) return () => {};
  }
  const release = () => {
    if (readLaunch(port)?.id !== launch.id) return;
    if (launch.successorPid && servicePidAlive(launch.successorPid) && readServiceRecord(port)?.pid !== launch.successorPid) return;
    unlinkSync(lock);
  };
  const log = openSync(join(serviceDirectory(), port + ".log"), "a");
  try {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL("./main." + (import.meta.url.endsWith(".ts") ? "ts" : "js"), import.meta.url)), "--port", String(port)], {
      cwd: process.cwd(), env: { ...process.env, LOOM_RESTART_PARENT_ID: launch.id }, detached: true, windowsHide: true, stdio: ["ignore", log, log, "ipc"],
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    if (!child.pid) throw new Error("Startup process did not provide an identity");
    launch.successorPid = child.pid;
    const temporary = lock + "." + launch.id + ".tmp";
    writeFileSync(temporary, JSON.stringify(launch), { mode: 0o600, flag: "wx" });
    replaceServiceFile(temporary, lock);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Startup child did not acknowledge startup")), 10000);
      child.once("message", (message) => {
        if (message !== launch.id) { clearTimeout(timeout); reject(new Error("Startup child returned a different identity")); return; }
        const disconnected = () => { clearTimeout(timeout); resolve(); };
        if (child.connected) child.once("disconnect", disconnected);
        else disconnected();
      });
      child.send(launch.id, (error) => { if (error) { clearTimeout(timeout); reject(error); } });
    });
    child.unref();
  } catch (error) { release(); throw error; }
  finally { closeSync(log); }
  process.stdout.write("服务未运行，按默认配置启动，沿用项目注册表。\n");
  return release;
}
export async function controlService(command: ServiceCommand, url: URL, timeoutMs: number) {
  if (process.env.HARNESS_TOKEN) throw new Error("Unit 执行不能停止或重启 Loom 服务，请在独立终端操作。");
  const port = Number(url.port || 80);
  let record = readServiceRecord(port);
  const current = await probe(url, record);
  const latest = readServiceRecord(port);
  const replaced = !!latest && latest.instanceId !== record?.instanceId;
  if (command === "stop" && replaced) throw new Error("服务实例已经变化，请等待另一项操作完成后重试停止。");
  if (!replaced && latest?.instanceId === record?.instanceId) record = latest;
  if (!record && !replaced && current.kind === "closing") throw new Error("服务正在关闭，请稍后重试。");
  let release = () => {};
  if (!replaced && current.kind === "offline" && (!record || !serviceProcessAlive(record))) {
    if (command === "stop") {
      if (activeLaunch(port)) throw new Error("服务正在启动，请等待另一项操作完成。");
      process.stdout.write("Loom 已停止。\n"); return;
    }
    release = await startDefault(port);
    record = undefined;
  } else if (record) {
    const pending = record.state === "stopping" ? "stop" : record.state === "restarting" ? "restart" : undefined;
    if (pending && pending !== command) throw new Error("另一项服务操作正在进行，请等待完成。");
    if (!pending && !replaced && current.kind !== "closing") {
      if (current.kind === "offline") throw new Error("服务记录中的进程仍在运行，但管理接口不可达，请检查 HARNESS_URL 和端口。");
      let response: Response | undefined;
      try {
        response = await fetch(new URL("/api/service/" + command, url), {
          method: "POST", headers: { "x-loom-service-key": record.controlToken, "x-loom-service-instance": record.instanceId }, signal: AbortSignal.timeout(5000), redirect: "error",
        });
      } catch (error) {
        const latest = readServiceRecord(port);
        if (latest?.instanceId === record.instanceId && latest.state === "ready") throw error;
      }
      if (response && !response.ok) {
        const latest = readServiceRecord(port);
        const matching = latest?.instanceId === record.instanceId && latest.state === (command === "stop" ? "stopping" : "restarting");
        if (!matching) throw new Error("服务未接受操作，请检查是否正在关闭或服务身份已经变化。");
      }
    }
  }
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const latest = readServiceRecord(port);
      if (command === "stop") {
        if (latest && latest.instanceId !== record?.instanceId) throw new Error("服务实例已经变化，请等待另一项操作完成后重试停止。");
        if (!latest && (!record || !servicePidAlive(record.pid))) {
          if (activeLaunch(port)) throw new Error("服务正在启动，请等待另一项操作完成。");
          process.stdout.write("Loom 已停止。\n"); return;
        }
      } else if (latest && latest.instanceId !== record?.instanceId && latest.state === "ready") {
        const ready = await probe(url, latest);
        if (ready.kind === "online" && ready.info.state === "ready") {
          process.stdout.write("Loom 已就绪 · " + url.origin + "\n日志 · " + latest.logFile + "\n"); return;
        }
      }
      if (record && latest?.instanceId === record.instanceId && latest.state !== "ready" && !serviceProcessAlive(latest))
        throw new Error("服务操作进程已经退出，请检查日志后重新运行命令。");
      await delay(100);
    }
    throw new Error("等待 Loom " + (command === "stop" ? "停止" : "重启") + "超时，没有强制结束进程。请检查 " + join(serviceDirectory(), port + ".log") + "。");
  } finally { release(); }
}
