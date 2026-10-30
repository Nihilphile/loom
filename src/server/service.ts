import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";

export type ServiceCommand = "stop" | "restart";
export const serviceRecordSchema = z.object({
  version: z.literal(1),
  instanceId: z.uuid(),
  pid: z.number().int().positive(),
  url: z.url(),
  controlToken: z.string().min(32),
  startedAt: z.iso.datetime(),
  logFile: z.string(),
  state: z.enum(["ready", "stopping", "restarting"]),
  successorPid: z.number().int().positive().optional(),
});
export type ServiceRecord = z.infer<typeof serviceRecordSchema>;
export const serviceInfoSchema = serviceRecordSchema.pick({ instanceId: true, pid: true, state: true }).extend({ product: z.literal("loom") });
export type ServiceInfo = z.infer<typeof serviceInfoSchema>;
export interface ServiceControl {
  token: string;
  info(): ServiceInfo;
  accept(command: ServiceCommand): { started: boolean; operation: ServiceCommand };
  run(): Promise<void>;
}
export const serviceDirectory = () => resolve(process.env.HARNESS_SERVICE_DIR || fileURLToPath(new URL("../../.newharness/services", import.meta.url)));
export const serviceFile = (port: number) => join(serviceDirectory(), `${port}.json`);
export function replaceServiceFile(temporary: string, target: string) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, target); return; }
    catch (error) {
      const busy = process.platform === "win32" && error instanceof Error && "code" in error && ["EPERM", "EBUSY", "EACCES"].includes(String(error.code));
      if (!busy || attempt >= 30) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}
export function readServiceRecord(port: number): ServiceRecord | undefined {
  try {
    return serviceRecordSchema.parse(JSON.parse(readFileSync(serviceFile(port), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("服务记录无效，请检查 " + serviceFile(port));
  }
}
export function writeServiceRecord(port: number, record: ServiceRecord) {
  mkdirSync(serviceDirectory(), { recursive: true });
  const temporary = serviceFile(port) + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    replaceServiceFile(temporary, serviceFile(port));
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}
export function removeServiceRecord(port: number, instanceId: string) {
  if (readServiceRecord(port)?.instanceId === instanceId) unlinkSync(serviceFile(port));
}
export function servicePidAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}
export function serviceProcessAlive(record: ServiceRecord) {
  return servicePidAlive(record.pid) || (record.successorPid !== undefined && servicePidAlive(record.successorPid));
}
