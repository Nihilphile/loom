import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { createHttpServer } from "./http.ts";
import { CodexRuntime } from "./runtime.ts";
import { GitWorkspaces } from "./git.ts";
import { readServiceRecord, removeServiceRecord, serviceDirectory, writeServiceRecord, type ServiceCommand, type ServiceControl, type ServiceRecord } from "./service.ts";

if (process.env.LOOM_RESTART_PARENT_ID) {
  const expected = process.env.LOOM_RESTART_PARENT_ID;
  if (!process.connected) throw new Error("Restart handoff requires its parent channel");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Restart parent did not hand off startup")), 10000);
    process.once("message", (message) => {
      clearTimeout(timeout);
      if (message === expected) resolve();
      else reject(new Error("Invalid restart handoff"));
    });
  });
  await new Promise<void>((resolve, reject) => process.send?.(expected, (error: Error | null) => error ? reject(error) : resolve()));
  if (process.connected) process.disconnect();
  delete process.env.LOOM_RESTART_PARENT_ID;
}
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(flag("port") || process.env.HARNESS_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
const record: ServiceRecord = {
  version: 1, instanceId: randomUUID(), pid: process.pid,
  url: "http://127.0.0.1:" + port, controlToken: randomBytes(32).toString("hex"),
  startedAt: new Date().toISOString(), logFile: join(serviceDirectory(), port + ".log"), state: "ready",
};
let operation: ServiceCommand | undefined;
let stopping: Promise<void> | undefined;
const service: ServiceControl = {
  token: record.controlToken,
  info: () => ({ product: "loom", instanceId: record.instanceId, pid: record.pid, state: record.state }),
  accept(command) {
    if (operation) return { started: false, operation };
    const next: ServiceRecord = { ...record, state: command === "restart" ? "restarting" : "stopping" };
    writeServiceRecord(port, next);
    operation = command;
    record.state = next.state;
    return { started: true, operation };
  },
  run: () => stopping ??= stop(),
};
const app = await createHttpServer({
  runtime: new CodexRuntime(), git: new GitWorkspaces(),
  projectRoot: flag("project"), staticDir: fileURLToPath(new URL("../web", import.meta.url)),
  catalogPath: process.env.HARNESS_CATALOG, registryPath: process.env.HARNESS_REGISTRY, service,
});
async function stop() {
  try {
    await app.close();
    if (operation === "restart") {
      const log = openSync(record.logFile, "a");
      try {
        const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
          cwd: process.cwd(), env: { ...process.env, LOOM_RESTART_PARENT_ID: record.instanceId }, detached: true, windowsHide: true,
          stdio: ["ignore", log, log, "ipc"],
        });
        await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        if (!child.pid) throw new Error("Restart process did not provide an identity");
        record.successorPid = child.pid;
        if (readServiceRecord(port)?.instanceId !== record.instanceId) throw new Error("Service ownership changed during restart");
        writeServiceRecord(port, record);
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Restart child did not acknowledge startup")), 10000);
          child.once("message", (message) => {
            if (message !== record.instanceId) { clearTimeout(timeout); reject(new Error("Restart child returned a different identity")); return; }
            const disconnected = () => { clearTimeout(timeout); resolve(); };
            if (child.connected) child.once("disconnect", disconnected);
            else disconnected();
          });
          child.send(record.instanceId, (error) => { if (error) { clearTimeout(timeout); reject(error); } });
        });
        child.unref();
      } finally { closeSync(log); }
    } else removeServiceRecord(port, record.instanceId);
    process.exit(0);
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exit(1);
  }
}
const signalStop = () => {
  if (!operation) service.accept("stop");
  void service.run();
};
process.on("SIGINT", signalStop);
process.on("SIGTERM", signalStop);
try {
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, "127.0.0.1", resolve);
  });
  writeServiceRecord(port, record);
  process.stdout.write("Loom · " + record.url + "\n");
} catch (error) {
  process.stderr.write(String(error) + "\n");
  await app.close();
  process.exitCode = 1;
}
