import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import type { ProjectEntry } from "../shared/types.ts";
import { projectIdentity } from "./project-path.ts";

export class ProjectRegistry {
  readonly projects: ProjectEntry[];
  constructor(readonly file = join(homedir(), ".newharness", "projects.json")) {
    this.projects = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as { projects: ProjectEntry[] })
          .projects
      : [];
  }
  get(id: string): ProjectEntry {
    const project = this.projects.find((p) => p.id === id);
    if (!project) throw new Error("项目不存在");
    return project;
  }
  register(path: string, name?: string): ProjectEntry {
    if (typeof path !== "string" || !path.trim() || !isAbsolute(path))
      throw new Error("请输入项目文件夹的绝对路径");
    if (
      name !== undefined &&
      (typeof name !== "string" || !name.trim() || name.length > 120)
    )
      throw new Error("项目名称无效");
    const root = resolve(path);
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true });
      const run = (args: string[]) => {
        const result = spawnSync("git", args, {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
        });
        if (result.error || result.status !== 0)
          throw new Error(
            result.error?.message || result.stderr || "Git 初始化失败",
          );
      };
      run(["init", "-b", "main"]);
      writeFileSync(join(root, ".gitignore"), ".newharness/\n", { flag: "wx" });
      run(["add", "--", ".gitignore"]);
      run([
        "-c",
        "user.name=New Harness",
        "-c",
        "user.email=local@new-harness",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        "Initialize project",
      ]);
    }
    const identity = projectIdentity(root);
    const existing = this.projects.find((p) => p.id === identity.id);
    if (existing) return existing;
    const entry: ProjectEntry = {
      ...identity,
      name: name?.trim() || basename(identity.path),
      createdAt: new Date().toISOString(),
    };
    const next = [...this.projects, entry];
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = this.file + ".tmp";
    writeFileSync(
      temporary,
      JSON.stringify({ version: 1, projects: next }, null, 2),
    );
    renameSync(temporary, this.file);
    this.projects.push(entry);
    return entry;
  }
}
