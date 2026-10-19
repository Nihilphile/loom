import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Workspace } from "../src/shared/types.ts";
import { GitBlockedError, GitWorkspaces } from "../src/server/git.ts";

const execute = promisify(execFile);
const noValidation = async () => ({ status: "not_configured" as const });
const deliver = (adapter: GitWorkspaces, graph: Workspace, source: string, id: string) => adapter.integrateTask(graph, source, id, noValidation, () => false);

test("serial deliveries include unrelated results, preserve fixed task bases and leave main untouched", async () => {
  const root = await repository();
  try {
    const adapter = new GitWorkspaces();
    const original = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "shared.txt"), "user uncommitted\n");
    const graph = await adapter.createGraph(root, "graph", "run");
    assert.equal(await git(graph.path, "branch", "--show-current"), "");
    const [left, right] = await Promise.all([
      adapter.createTask(graph, "left", original), adapter.createTask(graph, "right", original),
    ]);
    await writeFile(join(left.path, "left.txt"), "left");
    await writeFile(join(right.path, "right.txt"), "right");
    const a = await adapter.snapshot(left, "left", "left");
    const b = await adapter.snapshot(right, "right", "right");
    const receipts = await Promise.all([deliver(adapter, graph, a, "a"), deliver(adapter, graph, b, "b")]);
    assert.equal(receipts[1].baseSha, receipts[0].integratedSha);
    const head = await adapter.integrationHead(graph);
    const joined = await adapter.createTask(graph, "join", head);
    assert.equal(await readFile(join(joined.path, "left.txt"), "utf8"), "left");
    assert.equal(await readFile(join(joined.path, "right.txt"), "utf8"), "right");
    await assert.rejects(readFile(join(right.path, "left.txt")));
    assert.equal(right.baseCommit, original);
    assert.deepEqual(await deliver(new GitWorkspaces(), graph, a, "a"), receipts[0]);
    assert.equal(await adapter.integrationHead(graph), head);
    await adapter.refreshIntegrationMirror(graph);
    assert.equal(await git(graph.path, "rev-parse", "HEAD"), head);
    assert.equal(await git(root, "rev-parse", "HEAD"), original);
    assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "user uncommitted\n");
  } finally { await cleanup(root); }
});

test("conflict blocks publication while independent delivery proceeds and staged resolution retries the source", async () => {
  const root = await repository();
  try {
    const adapter = new GitWorkspaces();
    const graph = await adapter.createGraph(root, "conflict", "run");
    const left = await adapter.createTask(graph, "left", graph.baseCommit);
    const right = await adapter.createTask(graph, "right", graph.baseCommit);
    const independent = await adapter.createTask(graph, "independent", graph.baseCommit);
    await writeFile(join(left.path, "shared.txt"), "left\n");
    await writeFile(join(right.path, "shared.txt"), "right\n");
    await writeFile(join(independent.path, "independent.txt"), "independent");
    const a = await adapter.snapshot(left, "left", "left");
    const b = await adapter.snapshot(right, "right", "right");
    const c = await adapter.snapshot(independent, "independent", "independent");
    const first = await deliver(adapter, graph, a, "a");
    await assert.rejects(deliver(adapter, graph, b, "b"), GitBlockedError);
    assert.equal(await adapter.integrationHead(graph), first.integratedSha);
    assert.equal(await adapter.integrationReceipt(graph, "b"), undefined);
    const third = await deliver(adapter, graph, c, "c");
    let candidate!: Workspace;
    await assert.rejects(deliver(adapter, graph, b, "b"), (error) => {
      assert(error instanceof GitBlockedError); candidate = error.workspace; return true;
    });
    assert.equal(candidate.baseCommit, third.integratedSha);
    await writeFile(join(candidate.path, "shared.txt"), "resolved\n");
    await git(candidate.path, "add", "shared.txt");
    const result = await deliver(adapter, graph, b, "b");
    assert.equal(result.sourceSha, b);
    assert.equal(await git(graph.path, "show", `${result.integratedSha}:shared.txt`), "resolved");
    assert.equal(await git(root, "rev-parse", "HEAD"), graph.baseCommit);
  } finally { await cleanup(root); }
});

test("validation sees the merged candidate and failure, mutations and cancellation hold the branch", async () => {
  const root = await repository();
  try {
    const adapter = new GitWorkspaces();
    const graph = await adapter.createGraph(root, "validation", "run");
    const task = await adapter.createTask(graph, "task", graph.baseCommit);
    await writeFile(join(task.path, "code.txt"), "code");
    const source = await adapter.snapshot(task, "source", "source");
    await assert.rejects(adapter.integrateTask(graph, source, "fail", async (candidate) => {
      assert.equal(await readFile(join(candidate.path, "code.txt"), "utf8"), "code");
      throw new Error("tests failed");
    }, () => false), /tests failed/);
    await assert.rejects(deliver(adapter, graph, graph.baseCommit, "fail"), /different delivery source/);
    for (const mutation of ["untracked", "tracked", "commit"]) {
      await assert.rejects(adapter.integrateTask(graph, source, mutation, async (candidate) => {
        if (mutation === "untracked") await writeFile(join(candidate.path, "extra.txt"), "oops");
        else await writeFile(join(candidate.path, "code.txt"), "oops");
        if (mutation === "commit") { await git(candidate.path, "add", "."); await git(candidate.path, "commit", "-m", "unexpected"); }
        return { status: "passed", command: mutation, output: "" };
      }, () => false), /changed the candidate/);
      await assert.rejects(deliver(new GitWorkspaces(), graph, source, mutation), /restore the exact clean candidate/);
      assert.equal(await adapter.integrationReceipt(graph, mutation), undefined);
      assert.equal(await adapter.integrationHead(graph), graph.baseCommit);
    }
    let cancelled = false;
    await assert.rejects(adapter.integrateTask(graph, source, "cancel", async () => {
      cancelled = true; return noValidation();
    }, () => cancelled), /cancelled/);
    assert.equal(await adapter.integrationHead(graph), graph.baseCommit);
    const receipt = await deliver(adapter, graph, source, "fail");
    assert.equal(receipt.validation.status, "not_configured");
    assert.equal(await git(root, "rev-parse", "HEAD"), graph.baseCommit);
  } finally { await cleanup(root); }
});

test("receipts survive stale dirty mirrors and no-change deliveries have distinct boundaries", async () => {
  const root = await repository();
  try {
    const adapter = new GitWorkspaces();
    const graph = await adapter.createGraph(root, "receipt", "run");
    await writeFile(join(graph.path, "shared.txt"), "user mirror edits");
    const first = await deliver(adapter, graph, graph.baseCommit, "empty-one");
    assert.notEqual(first.integratedSha, graph.baseCommit);
    await assert.rejects(adapter.refreshIntegrationMirror(graph), /mirror has local changes/);
    const reopened = new GitWorkspaces();
    assert.deepEqual(await reopened.integrationReceipt(graph, "empty-one"), first);
    assert.deepEqual(await deliver(reopened, graph, graph.baseCommit, "empty-one"), first);
    const second = await deliver(adapter, graph, graph.baseCommit, "empty-two");
    assert.notEqual(second.integratedSha, first.integratedSha);
    assert.equal(await git(graph.path, "rev-parse", "HEAD"), graph.baseCommit);
    assert.equal(await readFile(join(graph.path, "shared.txt"), "utf8"), "user mirror edits");
    const task = await adapter.createTask(graph, "after", second.integratedSha);
    assert.equal(task.baseCommit, second.integratedSha);
    await git(graph.path, "update-ref", `refs/heads/${graph.branch}`, graph.baseCommit);
    await assert.rejects(reopened.integrationReceipt(graph, "empty-one"), /merge-base/);
    await assert.rejects(deliver(reopened, graph, graph.baseCommit, "empty-one"), /merge-base/);
  } finally { await cleanup(root); }
});
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
async function repository(label = "") {
  const root = await mkdtemp(join(tmpdir(), "harness-git-" + label));
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

test("child worktrees isolate siblings and integrate nested exact output with conflict recovery", async () => {
  const root = await repository("long-agentic-project-path-for-windows-");
  try {
    const adapter = new GitWorkspaces();
    const graph = await adapter.createGraph(root, "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");
    const task = await adapter.createTask(graph, "work", graph.baseCommit);
    const left = await adapter.createChild(task, "33333333-3333-3333-3333-333333333333");
    const right = await adapter.createChild(task, "44444444-4444-4444-4444-444444444444");
    const nested = await adapter.createChild(left, "55555555-5555-5555-5555-555555555555");
    assert.equal(dirname(left.path), dirname(nested.path));
    assert.equal(left.branch.length, nested.branch.length);
    assert(left.branch.length < 40);
    await writeFile(join(nested.path, "nested.txt"), "nested output");
    await assert.rejects(readFile(join(left.path, "nested.txt")), /ENOENT/);
    await assert.rejects(readFile(join(right.path, "nested.txt")), /ENOENT/);
    const nestedSha = await adapter.snapshot(nested, "nested", "nested-output");
    await assert.rejects(adapter.integrateChild(task, nested, nestedSha, "wrong-parent"), /immediate parent/);
    await adapter.integrateChild(left, nested, nestedSha, "nested-output");
    const leftSha = await adapter.snapshot(left, "left", "left-output");
    const merged = await adapter.integrateChild(task, left, leftSha, "left-output");
    assert.equal(await adapter.integrateChild(task, left, leftSha, "left-output"), merged);
    assert.equal(await readFile(join(task.path, "nested.txt"), "utf8"), "nested output");
    await writeFile(join(task.path, "shared.txt"), "parent\n");
    await writeFile(join(right.path, "shared.txt"), "child\n");
    const rightSha = await adapter.snapshot(right, "right", "right-output");
    await assert.rejects(adapter.integrateChild(task, right, rightSha, "right-output"), GitBlockedError);
    assert.match(await git(task.path, "ls-files", "--unmerged"), /shared.txt/);
    await writeFile(join(task.path, "shared.txt"), "resolved\n");
    await git(task.path, "add", "shared.txt");
    await adapter.integrateChild(task, right, rightSha, "right-output");
    assert.equal(await readFile(join(task.path, "shared.txt"), "utf8"), "resolved\n");
    assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "base\n");
  } finally { await cleanup(root); }
});

test("report-only tasks snapshot cleanly when runtime metadata is ignored", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, ".gitignore"), ".newharness/\n");
    await git(root, "add", ".gitignore");
    await git(root, "commit", "-m", "ignore runtime state");
    const adapter = new GitWorkspaces();
    const graph = await adapter.createGraph(root, "ignored", "run");
    const task = await adapter.createTask(graph, "reports", graph.baseCommit);
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
    await writeFile(
      join(task.path, " leading [literal].txt"),
      "leading whitespace",
    );
    const deleted = await adapter.snapshot(
      task,
      "delete tracked file",
      "delete",
    );
    const paths = (
      await execute("git", ["ls-tree", "-r", "-z", "--name-only", deleted], {
        cwd: task.path,
      })
    ).stdout.split("\0");
    assert(paths.includes("-file name.txt"));
    assert(paths.includes(" leading [literal].txt"));
    assert(!paths.includes("shared.txt"));
    assert(!paths.some((path) => path.startsWith(".newharness/")));
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
    const task = await adapter.createTask(graph, "task", graph.baseCommit);
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
      adapter.createTask(graph, "../escape", graph.baseCommit),
      /Workspace IDs/,
    );
    await assert.rejects(
      adapter.createGraph(root, "graph", "--evil"),
      /Workspace IDs/,
    );
    await assert.rejects(
      adapter.createTask(graph, "unsafe-sha", "--upload-pack=evil"),
      /full commit SHAs/,
    );
    await assert.rejects(
      adapter.createTask(graph, "task", first),
      /different fixed start commit/,
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
