import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";

export function projectIdentity(path: string) {
  const root = realpathSync(path);
  if (!statSync(root).isDirectory()) throw new Error("项目路径必须是目录");
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  return { id: createHash("sha256").update(key).digest("hex").slice(0, 24), path: root };
}
