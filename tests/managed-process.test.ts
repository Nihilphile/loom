import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { startManagedProcess } from "../src/server/managed-process.ts";

const start = (code: string) => startManagedProcess(process.execPath, ["--input-type=module", "-e", code], { cwd: process.cwd(), env: process.env });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert(Date.now() < deadline, "process condition completed before timeout"); await delay(25); }
}

test("owned session processes preserve protocol stdio and can be independently stopped", { skip: process.platform !== "win32", timeout: 60000 }, async (t) => {
  const code = `import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();
    createInterface({input:process.stdin}).on('line',line=>process.stdout.write(line+'\\n'));setInterval(()=>{},1000);`;
  const a = await start(code); t.after(() => a.close());
  const b = await start(code); t.after(() => b.close());
  let output = ""; a.child.stdout.on("data", chunk => { output += chunk; });
  a.child.stdin.write('{"request":"echo"}\n');
  await waitFor(() => output.includes('\n'));
  assert.equal(output, '{"request":"echo"}\n');
  await waitFor(async () => (await a.list()).some(item => item.role === "descendant" && item.name === "node") && (await b.list()).some(item => item.role === "descendant" && item.name === "node"));
  const descendants = (await a.list()).filter(item => item.role === "descendant" && item.name === "node");
  const foreign = (await b.list()).find(item => item.role === "descendant" && item.name === "node")!;
  await assert.rejects(a.stop(foreign.id), /not owned/);
  assert(alive(foreign.pid));
  await a.stop(descendants[0].id);
  assert(!alive(descendants[0].pid));
  assert(alive(a.pid));
  const aPid = a.pid;
  await a.close();
  assert(!alive(aPid));
  assert(alive(b.pid));
  assert(alive(foreign.pid));
});

test("backend exit is observable while detached descendants remain managed", { skip: process.platform !== "win32", timeout: 45000 }, async (t) => {
  const owner = await start(`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();setTimeout(()=>process.exit(0),200);`);
  t.after(() => owner.close());
  assert.deepEqual(await owner.exited, { code: 0, signal: null });
  assert(!alive(owner.pid));
  const descendants = await owner.list();
  assert.equal(descendants.length, 1);
  assert.equal(descendants[0].role, "descendant");
  assert(alive(descendants[0].pid));
  await owner.close();
  assert(!alive(descendants[0].pid));
});

test("losing the process owner terminates its job members", { skip: process.platform !== "win32", timeout: 45000 }, async () => {
  const owner = await start(`import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`);
  try {
    await waitFor(async () => (await owner.list()).some(item => item.role === "descendant" && item.name === "node"));
    const members = await owner.list();
    assert(owner.child.kill());
    await waitFor(() => members.every(value => !alive(value.pid)));
    assert.notEqual((await owner.exited).code, 0);
  } finally { await owner.close().catch(() => {}); }
});

test("owner disconnect after the Loom process exits reclaims the session", { skip: process.platform !== "win32", timeout: 45000 }, async (t) => {
  const moduleUrl = new URL("../src/server/managed-process.ts", import.meta.url).href;
  const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {startManagedProcess} from ${JSON.stringify(moduleUrl)};
    const owner=await startManagedProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),env:process.env});
    console.log(JSON.stringify({helper:owner.child.pid,members:await owner.list()}));
    setInterval(()=>{},1000);
  `], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  host.stdout.on("data", chunk => { output += chunk; });
  t.after(() => { if (host.exitCode === null && host.signalCode === null) host.kill(); });
  await waitFor(() => output.includes("\n"));
  const data: { helper: number; members: { pid: number }[] } = JSON.parse(output.trim());
  assert(data.members.length > 0);
  assert(host.kill());
  await waitFor(() => data.members.every(value => !alive(value.pid)) && !alive(data.helper));
});
