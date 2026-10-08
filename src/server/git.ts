import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { GitAdapter, Workspace } from "../shared/types.ts";

interface Manifest {
  kind: "graph" | "task";
  projectRoot: string;
  workspace: Workspace;
  dependencies: string[];
  prepared: boolean;
}

const metadata = [".newharness"];
const codePaths = [".", ...metadata.map((path) => `:(exclude)${path}`)];
const locks = new Map<string, Promise<unknown>>();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function locked<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((accept, reject) => {
    const child = execFile(
      "git",
      [
        "-c",
        "user.name=Loom",
        "-c",
        "user.email=loom@localhost",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "merge.autoStash=false",
        "-c",
        "rerere.enabled=false",
        ...args,
      ],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_MERGE_AUTOEDIT: "no",
        },
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `Git ${args[0]} failed in ${cwd}: ${stderr.trim() || stdout.trim() || error.message}`,
            ),
          );
        else accept(stdout.trim());
      },
    );
    child.stdin?.end(input);
  });
}

function identifier(value: string): void {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)
  ) {
    throw new Error(
      "Workspace IDs must contain 1–100 letters, digits, underscores or hyphens",
    );
  }
}

async function directory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Managed directory must not be a symlink: ${path}`);
}

async function readManifest(path: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(path + ".json", "utf8")) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveManifest(manifest: Manifest): Promise<void> {
  const path = manifest.workspace.path + ".json";
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(manifest), { flag: "wx" });
  await rename(temporary, path);
}

async function inspect(workspace: Workspace): Promise<Manifest> {
  const manifest = await readManifest(workspace.path);
  if (
    !manifest ||
    manifest.workspace.path !== workspace.path ||
    manifest.workspace.branch !== workspace.branch ||
    manifest.workspace.baseCommit !== workspace.baseCommit
  ) {
    throw new Error(`Not a registered Harness workspace: ${workspace.path}`);
  }
  if (
    resolve(await realpath(workspace.path)) !== resolve(workspace.path) ||
    resolve(await git(workspace.path, ["rev-parse", "--show-toplevel"])) !==
      resolve(workspace.path) ||
    (await git(workspace.path, ["symbolic-ref", "--short", "HEAD"])) !==
      workspace.branch
  ) {
    throw new Error(
      `Managed workspace location or branch changed: ${workspace.path}`,
    );
  }
  return manifest;
}

async function ensureWorktree(manifest: Manifest): Promise<Workspace> {
  const workspace = manifest.workspace;
  try {
    await lstat(join(workspace.path, ".git"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let branchExists = false;
    try {
      await git(manifest.projectRoot, [
        "show-ref",
        "--verify",
        `refs/heads/${workspace.branch}`,
      ]);
      branchExists = true;
    } catch {}
    await git(manifest.projectRoot, [
      "worktree",
      "add",
      ...(branchExists ? [] : ["-b", workspace.branch]),
      workspace.path,
      branchExists ? workspace.branch : workspace.baseCommit,
    ]);
  }
  await inspect(workspace);
  return workspace;
}

async function commits(workspace: Workspace, shas: string[]): Promise<void> {
  for (const sha of shas) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha))
      throw new Error("Dependencies must be full commit SHAs");
    if (
      (await git(workspace.path, [
        "rev-parse",
        "--verify",
        `${sha}^{commit}`,
      ])) !== sha.toLowerCase()
    ) {
      throw new Error(`Dependency is not a commit: ${sha}`);
    }
  }
}

export class GitBlockedError extends Error {
  readonly workspace: Workspace;
  constructor(workspace: Workspace, detail: string) {
    super(`Git workspace blocked at ${workspace.path}: ${detail}`);
    this.name = "GitBlockedError";
    this.workspace = workspace;
  }
}

async function unmerged(workspace: Workspace): Promise<void> {
  if (await git(workspace.path, ["ls-files", "--unmerged"])) {
    throw new GitBlockedError(
      workspace,
      "resolve and stage the conflicting files, then retry",
    );
  }
}

async function merging(workspace: Workspace): Promise<boolean> {
  try {
    await git(workspace.path, ["rev-parse", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function merge(workspace: Workspace, shas: string[]): Promise<void> {
  await unmerged(workspace);
  if (await merging(workspace)) {
    await git(workspace.path, ["commit", "--no-edit"]);
  }
  if (
    await git(workspace.path, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ...codePaths,
    ])
  ) {
    throw new GitBlockedError(
      workspace,
      "commit or snapshot existing code changes before merging",
    );
  }
  for (const sha of shas) {
    try {
      await git(workspace.path, [
        "merge",
        "--no-ff",
        "--no-edit",
        "--no-stat",
        sha,
      ]);
    } catch (error) {
      throw new GitBlockedError(
        workspace,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function operationRef(workspace: Workspace, kind: string, id: string): string {
  if (!id || id.length > 512)
    throw new Error("An operation ID of 1–512 characters is required");
  return `refs/newharness/operations/${hash(workspace.branch)}/${kind}/${hash(id)}`;
}

async function recorded(
  workspace: Workspace,
  ref: string,
): Promise<string | undefined> {
  try {
    return await git(workspace.path, ["rev-parse", "--verify", ref]);
  } catch {
    return undefined;
  }
}

export class GitWorkspaces implements GitAdapter {
  async createGraph(
    projectRoot: string,
    graphId: string,
    runId: string,
  ): Promise<Workspace> {
    identifier(graphId);
    identifier(runId);
    const root = await realpath(projectRoot);
    if (
      resolve(await git(root, ["rev-parse", "--show-toplevel"])) !==
      resolve(root)
    ) {
      throw new Error("The project must be a Git repository root");
    }
    const group = join(root, ".newharness", "worktrees", runId, graphId);
    return locked(group, async () => {
      let parent = root;
      for (const part of [".newharness", "worktrees", runId, graphId]) {
        parent = join(parent, part);
        await directory(parent);
      }
      const path = join(group, "graph");
      const branch = `newharness/${runId}/${graphId}/graph`;
      let manifest = await readManifest(path);
      if (
        manifest &&
        (manifest.kind !== "graph" ||
          manifest.workspace.path !== path ||
          manifest.workspace.branch !== branch)
      ) {
        throw new Error(`A different managed graph already occupies ${path}`);
      }
      if (!manifest) {
        const baseCommit = await git(root, [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ]);
        manifest = {
          kind: "graph",
          projectRoot: root,
          dependencies: [],
          prepared: true,
          workspace: { path, branch, baseCommit },
        };
        await saveManifest(manifest);
      }
      return ensureWorktree(manifest);
    });
  }

  async createTask(
    graph: Workspace,
    taskId: string,
    dependencyShas: string[],
  ): Promise<Workspace> {
    identifier(taskId);
    const graphManifest = await inspect(graph);
    if (graphManifest.kind !== "graph")
      throw new Error("Tasks require a graph workspace");
    await commits(graph, dependencyShas);
    const tasks = join(dirname(graph.path), "tasks");
    const path = join(tasks, taskId);
    const branch = graph.branch.replace(/\/graph$/, `/task/${taskId}`);
    return locked(path, async () => {
      await directory(tasks);
      let manifest = await readManifest(path);
      if (
        manifest &&
        (manifest.kind !== "task" ||
          manifest.workspace.path !== path ||
          manifest.workspace.branch !== branch)
      ) {
        throw new Error(`A different managed task already occupies ${path}`);
      }
      if (
        manifest &&
        JSON.stringify(manifest.dependencies) !== JSON.stringify(dependencyShas)
      ) {
        throw new Error(
          `Task ${taskId} already has different fixed dependencies`,
        );
      }
      if (!manifest) {
        manifest = {
          kind: "task",
          projectRoot: graphManifest.projectRoot,
          dependencies: [...dependencyShas],
          prepared: false,
          workspace: { path, branch, baseCommit: graph.baseCommit },
        };
        await saveManifest(manifest);
      }
      const workspace = await ensureWorktree(manifest);
      if (!manifest.prepared) {
        await merge(workspace, manifest.dependencies);
        manifest.prepared = true;
        await saveManifest(manifest);
      }
      return workspace;
    });
  }

  async snapshot(
    workspace: Workspace,
    message: string,
    operationId: string,
  ): Promise<string> {
    return locked(workspace.path, async () => {
      await inspect(workspace);
      const ref = operationRef(workspace, "snapshot", operationId);
      const existing = await recorded(workspace, ref);
      if (existing) return existing;
      await unmerged(workspace);
      if (await merging(workspace))
        throw new GitBlockedError(
          workspace,
          "finish the dependency merge before taking a snapshot",
        );
      const parent = await git(workspace.path, ["rev-parse", "HEAD"]);
      await git(workspace.path, [
        "rm",
        "-r",
        "--force",
        "--cached",
        "--ignore-unmatch",
        "--",
        ...metadata,
      ]);
      await git(workspace.path, ["add", "--all", "--", ...codePaths]);
      const tree = await git(workspace.path, ["write-tree"]);
      const parentTree = await git(workspace.path, [
        "rev-parse",
        `${parent}^{tree}`,
      ]);
      const sha =
        tree === parentTree
          ? parent
          : await git(
              workspace.path,
              ["commit-tree", tree, "-p", parent],
              message + "\n",
            );
      await git(
        workspace.path,
        ["update-ref", "--stdin"],
        `start\nupdate refs/heads/${workspace.branch} ${sha} ${parent}\ncreate ${ref} ${sha}\nprepare\ncommit\n`,
      );
      return sha;
    });
  }

  async mergeFinal(
    workspace: Workspace,
    shas: string[],
    operationId: string,
  ): Promise<string> {
    return locked(workspace.path, async () => {
      const manifest = await inspect(workspace);
      if (manifest.kind !== "graph")
        throw new Error("Final merge requires a graph workspace");
      const ref = operationRef(workspace, "final", operationId);
      const existing = await recorded(workspace, ref);
      if (existing) return existing;
      await commits(workspace, shas);
      await merge(workspace, shas);
      const sha = await git(workspace.path, ["rev-parse", "HEAD"]);
      await git(workspace.path, [
        "update-ref",
        ref,
        sha,
        "0".repeat(sha.length),
      ]);
      return sha;
    });
  }
}
