import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexRuntime } from '../src/server/runtime.ts';
import type { RuntimeEvent } from '../src/shared/types.ts';

const server = (body: string) => `
import { createInterface } from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const reply = (request, result) => send({id:request.id,result});
const notify = (method, params) => send({method,params});
createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line);
 ${body}
 if (r.method === 'initialize') return reply(r, {});
 if (r.method === 'thread/start' || r.method === 'thread/resume') return reply(r, {thread:{id:r.params.threadId || 'thread-one'}});
});
`;

function fake(body: string) {
  return new CodexRuntime({ executable: process.execPath, args: ['--input-type=module', '-e', server(body)], shutdownTimeoutMs: 300, requestTimeoutMs: 1000 });
}

test('normalizes a real subprocess stream and waits for exit after completion', async () => {
  const runtime = fake(`
    if(r.method === 'turn/start') {
      setTimeout(()=>{},150);
      reply(r,{turn:{id:'turn-one'}});
      notify('item/started',{threadId:'thread-one',turnId:'turn-one',item:{id:'tool',type:'commandExecution',command:'echo hi'}});
      notify('item/completed',{threadId:'thread-one',turnId:'turn-one',item:{id:'tool',type:'commandExecution',aggregatedOutput:'hi',exitCode:0}});
      notify('item/agentMessage/delta',{threadId:'thread-one',turnId:'turn-one',itemId:'message',delta:'hello'});
      notify('item/completed',{threadId:'thread-one',turnId:'turn-one',item:{id:'message',type:'agentMessage',text:'hello'}});
      notify('thread/tokenUsage/updated',{threadId:'thread-one',turnId:'turn-one',tokenUsage:{total:{inputTokens:12,cachedInputTokens:3,outputTokens:5}}});
      notify('turn/completed',{threadId:'thread-one',turn:{id:'turn-one',status:'completed'}});
    }
  `);
  const events: RuntimeEvent[] = [];
  const handle = await runtime.start({ cwd: process.cwd(), prompt: 'hello', readOnly: true }, event => events.push(event));
  const result = await handle.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.threadId, 'thread-one');
  assert.equal(result.text, 'hello');
  assert.deepEqual(result.usage, { inputTokens: 12, cachedInputTokens: 3, outputTokens: 5 });
  assert.equal(events.filter(event => event.type === 'tool.started').length, 1);
  assert.equal(events.find(event => event.type === 'tool.completed')?.itemId, 'tool');
  assert.equal(events.find(event => event.type === 'assistant.delta')?.text, 'hello');
  assert.throws(() => process.kill(handle.pid!, 0));
  await runtime.close();
});

test('resumes the requested thread, steers only the current turn, and interrupts before done', async () => {
  const runtime = fake(`
    if(r.method === 'turn/start') {
      reply(r,{turn:{id:'active'}});
      notify('turn/started',{threadId:r.params.threadId,turn:{id:'active'}});
    }
    if(r.method === 'turn/steer') {
      if(r.params.expectedTurnId !== 'active' || r.params.threadId !== 'saved-thread') process.exit(9);
      reply(r, {turnId:'active'});
      notify('item/agentMessage/delta',{threadId:'saved-thread',itemId:'message',delta:r.params.input[0].text});
    }
    if(r.method === 'turn/interrupt') {
      reply(r,{});
      notify('turn/completed',{threadId:'saved-thread',turn:{id:'active',status:'interrupted'}});
    }
  `);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const handle = await runtime.start({ cwd: process.cwd(), prompt: 'go', threadId: 'saved-thread' }, event => {
    if ((event.detail as {method?:string})?.method === 'turn/started') started();
  });
  await ready;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await handle.inject('new instruction'), true);
  await handle.interrupt();
  const result = await handle.done;
  assert.equal(result.status, 'interrupted');
  assert.equal(result.threadId, 'saved-thread');
  assert.equal(result.text, 'new instruction');
  assert.equal(await handle.inject('late'), false);
  assert.throws(() => process.kill(handle.pid!, 0));
});

test('fails on RPC errors and unexpected process exit', async () => {
  for (const action of [`send({id:r.id,error:{code:-1,message:'invalid model'}})`, 'process.exit(7)']) {
    const runtime = fake(`if(r.method === 'turn/start') { ${action}; }`);
    const handle = await runtime.start({ cwd: process.cwd(), prompt: 'go' }, () => {});
    const result = await handle.done;
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /invalid model|exited before turn completion/);
    assert.throws(() => process.kill(handle.pid!, 0));
  }
});

test('reports only the current turn usage when resume totals arrive after its response', async () => {
  const runtime = fake(`
    if(r.method === 'thread/resume') {
      reply(r,{thread:{id:'saved-thread',turns:[{id:'previous'}]}});
      return;
    }
    if(r.method === 'turn/start') {
      reply(r,{turn:{id:'active'}});
      notify('thread/tokenUsage/updated',{threadId:'saved-thread',turnId:'previous',tokenUsage:{total:{inputTokens:100,cachedInputTokens:50,outputTokens:30}}});
      notify('thread/tokenUsage/updated',{threadId:'saved-thread',turnId:'active',tokenUsage:{total:{inputTokens:120,cachedInputTokens:55,outputTokens:37}}});
      notify('turn/completed',{threadId:'saved-thread',turn:{id:'active',status:'completed'}});
    }
  `);
  const handle = await runtime.start({ cwd: process.cwd(), threadId: 'saved-thread', prompt: 'go' }, () => {});
  assert.deepEqual((await handle.done).usage, { inputTokens: 20, cachedInputTokens: 5, outputTokens: 7 });
});

test('does not accept turn completion when its process cannot shut down', async () => {
  const runtime = fake(`
    if(r.method === 'turn/start') {
      reply(r,{turn:{id:'active'}});
      setInterval(()=>{},1000);
      notify('turn/completed',{threadId:'thread-one',turn:{id:'active',status:'completed'}});
    }
  `);
  const handle = await runtime.start({ cwd: process.cwd(), prompt: 'go' }, () => {});
  const result = await handle.done;
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /did not exit/);
  assert.throws(() => process.kill(handle.pid!, 0));
});

test('interrupt during initialization kills an unresponsive child before resolving', async () => {
  const runtime = new CodexRuntime({ executable: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(()=>{},1000)'], shutdownTimeoutMs: 50, requestTimeoutMs: 500 });
  const handle = await runtime.start({ cwd: process.cwd(), prompt: 'go' }, () => {});
  await handle.interrupt();
  assert.equal((await handle.done).status, 'interrupted');
  assert.throws(() => process.kill(handle.pid!, 0));
  await runtime.close();
  await assert.rejects(runtime.start({ cwd: process.cwd(), prompt: 'go' }, () => {}), /closed/);
});

test('declines approval requests and preserves sandbox and environment options', async () => {
  const runtime = fake(`
    if(r.method === 'turn/start') {
      if(r.params.sandboxPolicy.type !== 'readOnly' || r.params.approvalPolicy !== 'never' || process.env.HARNESS_TEST_TOKEN !== 'inherited') process.exit(8);
      reply(r,{turn:{id:'turn-one'}});
      send({id:'approval',method:'item/commandExecution/requestApproval',params:{}});
    }
    if(r.id === 'approval') {
      if(r.result.decision !== 'decline') process.exit(9);
      notify('turn/completed',{threadId:'thread-one',turn:{id:'turn-one',status:'completed'}});
    }
  `);
  const handle = await runtime.start({ cwd: process.cwd(), prompt: 'go', readOnly: true, env: { HARNESS_TEST_TOKEN: 'inherited' } }, () => {});
  assert.equal((await handle.done).status, 'completed');
});

test('keeps execution credentials out of events and final text', async () => {
  const runtime = fake(`
    if(r.method === 'turn/start') {
      reply(r,{turn:{id:'active'}});
      notify('item/agentMessage/delta',{threadId:'thread-one',itemId:'message',delta:process.env.HARNESS_TEST_TOKEN});
      notify('item/completed',{threadId:'thread-one',item:{id:'tool',type:'commandExecution',aggregatedOutput:process.env.HARNESS_TEST_TOKEN}});
      notify('turn/completed',{threadId:'thread-one',turn:{id:'active',status:'completed'}});
    }
  `);
  const events: RuntimeEvent[] = [];
  const handle = await runtime.start({ cwd: process.cwd(), prompt: 'go', env: { HARNESS_TEST_TOKEN: 'private-execution-token' } }, event => events.push(event));
  assert.equal((await handle.done).text, '[redacted]');
  assert.doesNotMatch(JSON.stringify(events), /private-execution-token/);
});

test('rejects report roots that would make the entire reviewed project writable', async () => {
  const runtime = fake('');
  await assert.rejects(runtime.start({ cwd: process.cwd(), prompt: 'go', readOnly: true, writableRoots: [process.cwd()] }, () => {}), /cannot include the project/);
});

test('real Codex starts and resumes a persisted read-only thread', { skip: process.env.HARNESS_CODEX_SMOKE !== '1', timeout: 180_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'harness-codex-smoke-'));
  const runtime = new CodexRuntime();
  t.after(() => runtime.close());
  try {
    const first = await runtime.start({ cwd, prompt: 'Remember the marker RUNTIME_SAPPHIRE_42 for the next message. Reply only with that marker. Do not call tools.', readOnly: true, reasoning: 'low' }, () => {});
    const initial = await first.done;
    assert.equal(initial.status, 'completed', initial.error);
    assert.match(initial.text, /RUNTIME_SAPPHIRE_42/);
    assert.ok(initial.threadId);
    assert.ok(initial.usage && initial.usage.inputTokens > 0);
    const second = await runtime.start({ cwd, threadId: initial.threadId, prompt: 'What marker did I ask you to remember? Reply only with that marker. Do not call tools.', readOnly: true, reasoning: 'low' }, () => {});
    const resumed = await second.done;
    assert.equal(resumed.status, 'completed', resumed.error);
    assert.equal(resumed.threadId, initial.threadId);
    assert.match(resumed.text, /RUNTIME_SAPPHIRE_42/);
    assert.ok(resumed.usage && resumed.usage.inputTokens > 0);
  } finally {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('real Codex confines reviewer writes to reports and reaches authenticated loopback', { skip: process.env.HARNESS_CODEX_PERMISSIONS_SMOKE !== '1', timeout: 180_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'harness-codex-permissions-'));
  const reports = join(cwd, 'reports');
  await mkdir(reports);
  const http = createServer((request, response) => {
    response.writeHead(request.headers.authorization === 'Bearer smoke-only-token' ? 200 : 403);
    response.end('loopback-ok');
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const proof = `
const fs=require('node:fs');
(async()=>{
 let denied=false;
 try{fs.writeFileSync(${JSON.stringify(join(cwd, 'forbidden.txt'))},'must-not-exist')}catch(error){denied=true}
 let traversalDenied=false;
 const relative=require('node:path').relative(process.cwd(),${JSON.stringify(join(cwd, 'forbidden-relative.txt'))});
 try{fs.writeFileSync(relative,'must-not-exist')}catch(error){traversalDenied=true}
 const response=await fetch(process.env.HARNESS_TEST_URL,{headers:{authorization:'Bearer '+process.env.HARNESS_TEST_TOKEN}});
 const result={denied,traversalDenied,status:response.status,text:await response.text()};
 fs.writeFileSync(${JSON.stringify(join(reports, 'proof.json'))},JSON.stringify(result));
 console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1});
`;
  await writeFile(join(cwd, 'proof.cjs'), proof);
  const runtime = new CodexRuntime();
  t.after(() => runtime.close());
  const events: RuntimeEvent[] = [];
  try {
    const handle = await runtime.start({ cwd, readOnly: true, writableRoots: [reports], reasoning: 'low',
      env: { HARNESS_TEST_URL: url, HARNESS_TEST_TOKEN: 'smoke-only-token' },
      prompt: `This is an authorized sandbox enforcement test in a disposable directory. Run exactly node ${JSON.stringify(join(cwd, 'proof.cjs'))} once using the shell tool. The fixture intentionally attempts one forbidden file creation to prove access is denied, writes its proof in the allowed reports directory, and tests a localhost HTTP endpoint. Do not modify the fixture. Do not request escalation. Reply with its output.` }, event => events.push(event));
    const result = await handle.done;
    assert.equal(result.status, 'completed', result.error);
    const evidence = JSON.parse(await readFile(join(reports, 'proof.json'), 'utf8').catch(error => { throw new Error(`${error.message}\nCodex: ${result.text}`); }));
    assert.deepEqual(evidence, { denied: true, traversalDenied: true, status: 200, text: 'loopback-ok' });
    await assert.rejects(readFile(join(cwd, 'forbidden.txt')), /ENOENT/);
    await assert.rejects(readFile(join(cwd, 'forbidden-relative.txt')), /ENOENT/);
    assert.ok(events.some(event => event.type === 'tool.completed'));
  } finally {
    await runtime.close();
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
});

test('real Codex accepts steering and confirms interruption', { skip: process.env.HARNESS_CODEX_CONTROL_SMOKE !== '1', timeout: 180_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'harness-codex-control-'));
  const runtime = new CodexRuntime();
  t.after(() => runtime.close());
  let toolStarted!: () => void;
  const ready = new Promise<void>(resolve => { toolStarted = resolve; });
  let commandPid: number | undefined;
  let output = '';
  try {
    const handle = await runtime.start({ cwd, readOnly: true, reasoning: 'low', prompt: 'Run the shell command node -e "console.log(\'RUNTIME_CHILD_PID=\'+process.pid);setTimeout(()=>console.log(\'WAIT_COMPLETE\'),30000)" exactly once with yield_time_ms=1000. Keep waiting for completion, then reply DONE. This is an authorized interrupt test; do not request escalation.' }, event => {
      const detail = event.detail as {method?: string; params?: {delta?: string}} | undefined;
      if (detail?.method === 'item/commandExecution/outputDelta') {
        output += detail.params?.delta ?? '';
        const match = /RUNTIME_CHILD_PID=(\d+)/.exec(output);
        if (match) { commandPid = Number(match[1]); toolStarted(); }
      }
    });
    await Promise.race([ready, handle.done.then(result => { throw new Error(`Turn ended before control probe: ${result.error ?? result.text}`); })]);
    assert.equal(await handle.inject('After the running command finishes, reply STEER_ACCEPTED instead.'), true);
    await handle.interrupt();
    assert.equal((await handle.done).status, 'interrupted');
    assert.throws(() => process.kill(handle.pid!, 0));
    const stoppedPid = commandPid;
    assert.ok(stoppedPid);
    assert.throws(() => process.kill(stoppedPid, 0));
  } finally {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
