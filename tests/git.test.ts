import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { GitBlockedError, GitWorkspaces } from "../src/server/git.ts";

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (
    await execute(
      "git",
      [
        "-c",
        "user.name=Harness Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd },
    )
  ).stdout.trim();
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "harness-git-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(join(root, "shared.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "baseline");
  return root;
}
async function cleanup(root: string) {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  assert.ok(root.split(sep).at(-1)?.startsWith("harness-git-"));
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

test("report-only tasks snapshot cleanly when runtime metadata is ignored", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, ".gitignore"), ".newharness/\n");
    await git(root, "add", ".gitignore");
    await git(root, "commit", "-m", "ignore runtime state");
    const adapter = new GitWorkspaces();
    const graph = await adapter.createGraph(root, "ignored", "run");
    const task = await adapter.createTask(graph, "reports", []);
    await mkdir(join(task.path, ".newharness", "reports"), { recursive: true });
    await writeFile(
      join(task.path, ".newharness", "reports", "done.md"),
      "report only",
    );
    const original = await git(task.path, "rev-parse", "HEAD");
    const sha = await adapter.snapshot(task, "report-only", "report-only");
    assert.equal(sha, original);
    assert.equal(await git(task.path, "ls-files", ".newharness"), "");
    await writeFile(join(task.path, "new-code.txt"), "code");
    const changed = await adapter.snapshot(task, "code", "code");
    assert.notEqual(changed, original);
    assert.equal(
      await git(task.path, "ls-tree", "-r", "--name-only", changed),
      ".gitignore\nnew-code.txt\nshared.txt",
    );
    await rm(join(task.path, "shared.txt"));
    await writeFile(join(task.path, "-file name.txt"), "literal path");
    const deleted = await adapter.snapshot(
      task,
      "delete tracked file",
      "delete",
    );
    const paths = (
      await git(task.path, "ls-tree", "-r", "--name-only", deleted)
    ).split("\n");
    assert(paths.includes("-file name.txt"));
    assert(!paths.includes("shared.txt"));
    assert(!paths.some((path) => path.startsWith(".newharness/")));
  } finally {
    await cleanup(root);
  }
});

test("fixed graph baseline, parallel tasks, snapshots and final merge preserve the original branch", async () => {
  const root = await repository();
  try {
    const adapter = new GitWorkspaces();
    const original = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "shared.txt"), "user uncommitted\n");
    const graph = await adapter.createGraph(root, "graph", "run");
    assert.equal(graph.baseCommit, original);
    assert.equal(
      await readFile(join(graph.path, "shared.txt"), "utf8"),
      "base\n",
    );
    const [left, right] = await Promise.all([
      adapter.createTask(graph, "left", []),
      adapter.createTask(graph, "right", []),
    ]);
    await writeFile(join(left.path, "left.txt"), "left output\n");
    await mkdir(join(left.path, ".newharness"));
    await writeFile(
      join(left.path, ".newharness", "secret.json"),
      "runtime metadata",
    );
    await writeFile(join(right.path, "right.txt"), "right output\n");
    const [leftSha, rightSha] = await Promise.all([
      adapter.snapshot(left, "left", "left-report"),
      adapter.snapshot(right, "right", "right-report"),
    ]);
    assert.equal(
      await git(left.path, "ls-tree", "-r", "--name-only", leftSha),
      "left.txt\nshared.txt",
    );
    await writeFile(
      join(left.path, "later.txt"),
      "not in the fixed dependency\n",
    );
    assert.equal(
      await new GitWorkspaces().snapshot(left, "retry", "left-report"),
      leftSha,
    );
    await adapter.snapshot(left, "later", "later-report");
    const joined = await adapter.createTask(graph, "join", [leftSha, rightSha]);
    assert.equal(
      await readFile(join(joined.path, "left.txt"), "utf8"),
      "left output\n",
    );
    assert.equal(
      await readFile(join(joined.path, "right.txt"), "utf8"),
      "right output\n",
    );
    await assert.rejects(readFile(join(joined.path, "later.txt")));
    const final = await adapter.mergeFinal(graph, [leftSha, rightSha], "final");
    assert.equal(
      await new GitWorkspaces().mergeFinal(graph, [leftSha, rightSha], "final"),
      final,
    );
    assert.equal(
      await git(graph.path, "ls-tree", "-r", "--name-only", final),
      "left.txt\nright.txt\nshared.txt",
    );
    assert.equal(await git(root, "rev-parse", "HEAD"), original);
    assert.equal(await git(root, "branch", "--show-current"), "main");
    assert.equal(
      await readFile(join(root, "shared.txt"), "utf8"),
      "user uncommitted\n",
    );
    assert.deepEqual(await adapter.createGraph(root, "graph", "run"), graph);
  } finally {
    await cleanup(root);
  }
});

test("dependency conflicts preserve the workspace, block snapshots and resume after staged resolution", async () => {
  const root = await repository();
  try {
    const adapter = new GitWorkspaces();
    const graph = await adapter.createGraph(root, "conflict", "run");
    const left = await adapter.createTask(graph, "left", []);
    const right = await adapter.createTask(graph, "right", []);
    await writeFile(join(left.path, "shared.txt"), "left\n");
    await writeFile(join(right.path, "shared.txt"), "right\n");
    const a = await adapter.snapshot(left, "left", "left");
    const b = await adapter.snapshot(right, "right", "right");
    let blocked: GitBlockedError | undefined;
    await assert.rejects(adapter.createTask(graph, "join", [a, b]), (error) => {
      assert.ok(error instanceof GitBlockedError);
      blocked = error;
      assert.ok(error.message.includes(error.workspace.path));
      return true;
    });
    assert.ok(blocked);
    const workspace = blocked.workspace;
    assert.match(
      await readFile(join(workspace.path, "shared.txt"), "utf8"),
      /<<<<<<< HEAD/,
    );
    await assert.rejects(
      new GitWorkspaces().createTask(graph, "join", [a, b]),
      GitBlockedError,
    );
    await assert.rejects(
      adapter.snapshot(workspace, "must not commit conflicts", "blocked"),
      GitBlockedError,
    );
    const independent = await adapter.createTask(graph, "independent", []);
    assert.equal(
      await readFile(join(independent.path, "shared.txt"), "utf8"),
      "base\n",
    );
    await writeFile(
      join(workspace.path, "shared.txt"),
      "resolved dependency\n",
    );
    await git(workspace.path, "add", "shared.txt");
    assert.deepEqual(
      await new GitWorkspaces().createTask(graph, "join", [a, b]),
      workspace,
    );
    const delivery = await adapter.snapshot(workspace, "delivery", "delivery");
    assert.equal(
      await git(workspace.path, "show", `${delivery}:shared.txt`),
      "resolved dependency",
    );
    await adapter.mergeFinal(graph, [delivery], "final");
    assert.equal(
      await readFile(join(graph.path, "shared.txt"), "utf8"),
      "resolved dependency\n",
    );
    assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "base\n");
  } finally {
    await cleanup(root);
  }
});

test("final conflicts remain blocked until resolved and final operation retries return the original result", async () => {
  const root = await repository();
  try {
    const adapter = new GitWorkspaces();
    const graph = await adapter.createGraph(root, "final-conflict", "run");
    const left = await adapter.createTask(graph, "left", []);
    const right = await adapter.createTask(graph, "right", []);
    await writeFile(join(left.path, "shared.txt"), "left final\n");
    await writeFile(join(right.path, "shared.txt"), "right final\n");
    const a = await adapter.snapshot(left, "left", "left");
    const b = await adapter.snapshot(right, "right", "right");
    await assert.rejects(
      adapter.mergeFinal(graph, [a, b], "final"),
      GitBlockedError,
    );
    await assert.rejects(
      new GitWorkspaces().mergeFinal(graph, [a, b], "final"),
      GitBlockedError,
    );
    await writeFile(join(graph.path, "shared.txt"), "resolved final\n");
    await git(graph.path, "add", "shared.txt");
    const final = await new GitWorkspaces().mergeFinal(graph, [a, b], "final");
    assert.equal(
      await git(graph.path, "show", `${final}:shared.txt`),
      "resolved final",
    );
    assert.equal(await adapter.mergeFinal(graph, [a, b], "final"), final);
    assert.equal(await git(root, "rev-parse", "HEAD"), graph.baseCommit);
  } finally {
    await cleanup(root);
  }
});

test("graph retries freeze HEAD, reject unsafe identifiers and discard only metadata from the index", async () => {
  const root = await repository();
  try {
    const adapter = new GitWorkspaces();
    await mkdir(join(root, ".newharness"));
    await writeFile(join(root, ".newharness", "tracked.json"), "old metadata");
    await git(root, "add", ".newharness");
    await git(root, "commit", "-m", "tracked metadata");
    const graph = await adapter.createGraph(root, "fixed", "run");
    await writeFile(join(root, "after.txt"), "later user commit");
    await git(root, "add", "after.txt");
    await git(root, "commit", "-m", "later user commit");
    assert.deepEqual(
      await new GitWorkspaces().createGraph(root, "fixed", "run"),
      graph,
    );
    const task = await adapter.createTask(graph, "task", []);
    await assert.rejects(readFile(join(task.path, "after.txt")));
    await writeFile(
      join(task.path, ".newharness", "tracked.json"),
      "staged metadata",
    );
    await git(task.path, "add", ".newharness/tracked.json");
    await writeFile(
      join(task.path, ".newharness", "tracked.json"),
      "latest metadata",
    );
    await writeFile(join(task.path, "output.txt"), "code");
    const [first, second] = await Promise.all([
      adapter.snapshot(
        task,
        'message with "quotes" and $() literal',
        "one-operation",
      ),
      new GitWorkspaces().snapshot(task, "retry", "one-operation"),
    ]);
    assert.equal(first, second);
    assert.equal(
      await git(task.path, "ls-tree", "-r", "--name-only", first),
      "output.txt\nshared.txt",
    );
    assert.equal(
      await readFile(join(task.path, ".newharness", "tracked.json"), "utf8"),
      "latest metadata",
    );
    await assert.rejects(
      adapter.createTask(graph, "../escape", []),
      /Workspace IDs/,
    );
    await assert.rejects(
      adapter.createGraph(root, "graph", "--evil"),
      /Workspace IDs/,
    );
    await assert.rejects(
      adapter.createTask(graph, "unsafe-sha", ["--upload-pack=evil"]),
      /full commit SHAs/,
    );
    await assert.rejects(
      adapter.createTask(graph, "task", [first]),
      /different fixed dependencies/,
    );
    await assert.rejects(
      adapter.snapshot(
        { path: root, branch: "main", baseCommit: graph.baseCommit },
        "no",
        "no",
      ),
      /registered Harness workspace/,
    );
  } finally {
    await cleanup(root);
  }
});
