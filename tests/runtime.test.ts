import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  link,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexRuntime } from "../src/server/runtime.ts";
import { observerRead } from "../src/server/observer-tools.ts";
import type { RuntimeEvent } from "../src/shared/types.ts";

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
  return new CodexRuntime({
    executable: process.execPath,
    args: ["--input-type=module", "-e", server(body)],
    shutdownTimeoutMs: 300,
    requestTimeoutMs: 1000,
  });
}

test("acceptance receipts distinguish native rejection, lost acknowledgement, and confirmed start", async () => {
  for (const [action, expected] of [
    ["send({id:r.id,error:{message:'refused'}})", "rejected"],
    ["process.exit(7)", "uncertain"],
    [
      "reply(r,{turn:{id:'accepted-turn'}});notify('turn/completed',{threadId:'thread-one',turn:{id:'accepted-turn',status:'completed'}})",
      "accepted",
    ],
    [
      "notify('turn/started',{threadId:'thread-one',turn:{id:'accepted-turn'}});process.exit(7)",
      "accepted",
    ],
    [
      "notify('turn/completed',{threadId:'thread-one',turn:{id:'accepted-turn',status:'completed'}})",
      "accepted",
    ],
  ]) {
    const runtime = fake(`if(r.method === 'turn/start') {${action};}`);
    const handle = await runtime.start(
      { cwd: process.cwd(), prompt: "go" },
      () => {},
    );
    assert.equal((await handle.accepted).status, expected);
    const result = await handle.done;
    assert.equal(
      result.completedTurnId,
      result.status === "completed" ? "accepted-turn" : undefined,
    );
    await runtime.close();
  }
  const runtime = fake(
    `if(r.method === 'initialize')return send({id:r.id,error:{message:'unsupported'}});`,
  );
  const handle = await runtime.start(
    { cwd: process.cwd(), prompt: "go" },
    () => {},
  );
  assert.equal((await handle.accepted).status, "rejected");
  await handle.done;
});

test("observer reads are bounded to ordinary project files and hide runtime storage", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "loom-observer-tools-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  await mkdir(root);
  await mkdir(join(root, ".loom"));
  await writeFile(join(root, "code.txt"), "one\ntwo\nthree");
  await writeFile(join(parent, "outside.txt"), "private");
  await writeFile(join(root, ".loom", "state.json"), "token");
  await writeFile(join(root, ".env"), "secret");
  await mkdir(join(parent, "outside"));
  await writeFile(join(parent, "outside", "data.txt"), "private");
  await symlink(join(parent, "outside"), join(root, "escaped"), "junction");
  await link(join(parent, "outside.txt"), join(root, "linked.txt"));
  assert.equal(
    await observerRead(root, "read_file", {
      path: "code.txt",
      startLine: 2,
      lineCount: 1,
    }),
    "2: two",
  );
  for (const path of [
    "../outside.txt",
    ".loom/state.json",
    ".env",
    "escaped/data.txt",
    "linked.txt",
  ])
    await assert.rejects(observerRead(root, "read_file", { path }));
  const list = await observerRead(root, "list_files", {});
  assert.match(list, /code.txt/);
  assert.doesNotMatch(list, /\.loom|\.env|escaped/);
  await assert.rejects(
    observerRead(root, "write_file", { path: "code.txt" }),
    /Unsupported/,
  );
  assert.equal(
    await readFile(join(root, "code.txt"), "utf8"),
    "one\ntwo\nthree",
  );
});

test("observer forks a checkpoint into a separate native thread and resumes only its own identity", async () => {
  const runtime = fake(`
    if(r.method === 'config/read') return reply(r,{config:{mcp_servers:{remote:{},local:{}}}});
    if(r.method === 'mcpServerStatus/list') return reply(r,{data:[{name:'remote',runtimeStatus:'disabled'},{name:'loom_observer',runtimeStatus:'connected'}]});
    if(r.method === 'thread/fork' || r.method === 'thread/resume') {
      const p=r.params;
      if(r.method === 'thread/fork' && (p.threadId!=='source' || p.lastTurnId!=='checkpoint' || p.deferGoalContinuation!==true)) process.exit(9);
      if(r.method === 'thread/resume' && p.threadId!=='side-thread') process.exit(10);
      if(p.sandbox!=='read-only' || p.config['mcp_servers.remote.enabled']!==false || p.config['mcp_servers.local.enabled']!==false || !p.config['mcp_servers.loom_observer'].enabled || p.config['features.shell_tool']!==false) process.exit(11);
      if(process.env.HARNESS_TEST_TOKEN || process.env.LOOM_CALLBACK_TOKEN) process.exit(12);
      return reply(r,{thread:{id:'side-thread',turns:[{id:'checkpoint'}]},sandbox:{type:'readOnly',networkAccess:false}});
    }
    if(r.method === 'turn/start') {
      if(r.params.threadId!=='side-thread' || r.params.sandboxPolicy.type!=='readOnly' || r.params.sandboxPolicy.networkAccess!==false) process.exit(13);
      reply(r,{turn:{id:'side-turn'}});
      notify('turn/completed',{threadId:'side-thread',turn:{id:'side-turn',status:'completed'}});
    }
  `);
  for (const identity of [
    { fork: { threadId: "source", turnId: "checkpoint" } },
    { threadId: "side-thread" },
  ]) {
    const handle = await runtime.start(
      {
        cwd: process.cwd(),
        prompt: "observe",
        observer: true,
        ...identity,
        env: { HARNESS_TEST_TOKEN: "no", LOOM_CALLBACK_TOKEN: "no" },
      },
      () => {},
    );
    assert.deepEqual(await handle.accepted, {
      status: "accepted",
      threadId: "side-thread",
      turnId: "side-turn",
    });
    const result = await handle.done;
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.threadId, "side-thread");
    assert.equal(result.completedTurnId, "side-turn");
  }
  await runtime.close();
});

test("observer refuses a changed checkpoint, writable sandbox, or inherited tool server before dispatch", async () => {
  for (const failure of ["checkpoint", "sandbox", "server"]) {
    const runtime = fake(`
      if(r.method === 'config/read') return reply(r,{config:{mcp_servers:{}}});
      if(r.method === 'thread/fork') return reply(r,{thread:{id:'side',turns:[{id:${JSON.stringify(failure === "checkpoint" ? "wrong" : "checkpoint")}}]},sandbox:{type:${JSON.stringify(failure === "sandbox" ? "workspaceWrite" : "readOnly")},networkAccess:false}});
      if(r.method === 'mcpServerStatus/list') return reply(r,{data:[{name:'remote',runtimeStatus:'connected'}]});
      if(r.method === 'turn/start') process.exit(99);
    `);
    const handle = await runtime.start(
      {
        cwd: process.cwd(),
        prompt: "observe",
        observer: true,
        fork: { threadId: "source", turnId: "checkpoint" },
      },
      () => {},
    );
    assert.equal((await handle.accepted).status, "rejected");
    const result = await handle.done;
    assert.equal(result.status, "failed");
    assert.match(result.error!, /checkpoint|sandbox|enabled tool server/);
    await runtime.close();
  }
});

test("steering submitted during startup waits for its own native turn", async () => {
  const runtime = fake(`
    if(r.method === 'initialize') {setTimeout(()=>reply(r,{}),50);return;}
    if(r.method === 'turn/start') return reply(r,{turn:{id:'early-turn'}});
    if(r.method === 'turn/steer') {
      if(r.params.expectedTurnId !== 'early-turn') process.exit(9);
      reply(r,{turnId:'early-turn'});
      notify('turn/completed',{threadId:'thread-one',turn:{id:'early-turn',status:'completed'}});
    }
  `);
  try {
    const handle = await runtime.start(
      { cwd: process.cwd(), prompt: "start" },
      () => {},
    );
    assert.equal(await handle.inject("early correction"), true);
    assert.equal((await handle.done).status, "completed");
  } finally {
    await runtime.close();
  }
});

test("discovers paginated native models and enabled skills with visible load warnings", async () => {
  const runtime = fake(`
    if(r.method === 'model/list') {
      if(!r.params.cursor) return reply(r,{data:[{model:'native-model',displayName:'Native',isDefault:true,inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'future'}],defaultReasoningEffort:'high'}],nextCursor:'next'});
      return reply(r,{data:[{model:'second',displayName:'Second',supportedReasoningEfforts:[]}],nextCursor:null});
    }
    if(r.method === 'skills/list') {
      if(r.params.cwds.length !== 1 || r.params.cwds[0] !== process.cwd() || !r.params.forceReload) process.exit(9);
      return reply(r,{data:[{skills:[{name:'enabled',path:'/skills/enabled/SKILL.md',description:'Useful',enabled:true},{name:'disabled',path:'/disabled',enabled:false}],errors:[{path:'/bad',message:'Invalid skill'}]}]});
    }
  `);
  const options = await runtime.discoverOptions(process.cwd());
  assert.deepEqual(options.models, [
    {
      id: "native-model",
      name: "Native",
      isDefault: true,
      inputModalities: ["text", "image"],
      reasoning: ["high"],
      defaultReasoning: "high",
    },
    { id: "second", name: "Second", isDefault: false, reasoning: [] },
  ]);
  assert.deepEqual(options.skills, [
    {
      name: "enabled",
      path: "/skills/enabled/SKILL.md",
      description: "Useful",
    },
  ]);
  assert.deepEqual(options.warnings, ["/bad: Invalid skill"]);
  await runtime.close();
});

test("native catalog failures reject without substituting a static catalog", async () => {
  const runtime = fake(
    `if(r.method === 'model/list') return send({id:r.id,error:{message:'catalog unavailable'}});`,
  );
  await assert.rejects(
    runtime.discoverOptions(process.cwd()),
    /catalog unavailable/,
  );
  await runtime.close();
});

test("sends native images and skills and readable file references on start and steer", async () => {
  const runtime = fake(`
    if(r.method === 'thread/start') return reply(r,{thread:{id:'thread-one'},model:'resolved-model'});
    if(r.method === 'turn/start' || r.method === 'turn/steer') {
      const items = r.params.input;
      if(items.length !== 3 || items[0].type !== 'text' || !items[0].text.includes('Read the attached file') || !items[0].text.includes('notes.txt') || items[1].type !== 'localImage' || !items[1].path.endsWith('photo.png') || items[2].type !== 'skill' || items[2].name !== 'example') process.exit(9);
      if(r.method === 'turn/start') reply(r,{turn:{id:'active'}});
      else {
        reply(r,{turnId:'active'});
        notify('model/rerouted',{threadId:'thread-one',turnId:'active',fromModel:'resolved-model',toModel:'fallback-model',reason:'highRiskRequest'});
        notify('turn/completed',{threadId:'thread-one',turn:{id:'active',status:'completed'}});
      }
    }
  `);
  const attachments = [
    {
      id: "image",
      name: "photo.png",
      mediaType: "image/png",
      size: 1,
      kind: "image" as const,
      path: join(process.cwd(), "photo.png"),
    },
    {
      id: "file",
      name: "notes.txt",
      mediaType: "text/plain",
      size: 1,
      kind: "file" as const,
      path: join(process.cwd(), "notes.txt"),
    },
  ];
  const skills = [{ name: "example", path: join(process.cwd(), "SKILL.md") }];
  const events: RuntimeEvent[] = [];
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const handle = await runtime.start(
    { cwd: process.cwd(), prompt: "inspect", attachments, skills },
    (event) => {
      events.push(event);
      if (event.type === "turn.started") started();
    },
  );
  await Promise.race([
    ready,
    handle.done.then(() => {
      throw new Error("Ended before ready");
    }),
  ]);
  assert.equal(await handle.inject("", { attachments, skills }), true);
  assert.equal((await handle.done).status, "completed");
  assert.equal(
    events.find((event) => event.type === "thread.started")?.model,
    "resolved-model",
  );
  assert.equal(
    events.find((event) => event.type === "model.resolved")?.model,
    "fallback-model",
  );
});

test("resumed usage without a baseline is unknown while context uses the last native request", async () => {
  const runtime = fake(`
    if(r.method === 'turn/start') {
      reply(r,{turn:{id:'active'}});
      notify('thread/tokenUsage/updated',{threadId:'saved',turnId:'active',tokenUsage:{total:{inputTokens:1000,cachedInputTokens:500,outputTokens:100},last:{totalTokens:321},modelContextWindow:10000}});
      notify('turn/completed',{threadId:'saved',turn:{id:'active',status:'completed'}});
    }
  `);
  const events: RuntimeEvent[] = [];
  const handle = await runtime.start(
    { cwd: process.cwd(), prompt: "go", threadId: "saved" },
    (event) => events.push(event),
  );
  assert.equal((await handle.done).usage, undefined);
  assert.equal(
    events.some((event) => event.type === "usage"),
    false,
  );
  assert.deepEqual(events.find((event) => event.contextUsage)?.contextUsage, {
    tokens: 321,
    window: 10000,
  });
});

test("missing native context data remains unknown despite cumulative tokens", async () => {
  const runtime = fake(`
    if(r.method === 'turn/start') {
      reply(r,{turn:{id:'active'}});
      notify('thread/tokenUsage/updated',{threadId:'thread-one',turnId:'active',tokenUsage:{total:{inputTokens:1000,cachedInputTokens:500,outputTokens:100}}});
      notify('turn/completed',{threadId:'thread-one',turn:{id:'active',status:'completed'}});
    }
  `);
  const events: RuntimeEvent[] = [];
  const handle = await runtime.start(
    { cwd: process.cwd(), prompt: "go" },
    (event) => events.push(event),
  );
  await handle.done;
  assert.equal(
    events.some((event) => event.contextUsage),
    false,
  );
});

test("normalizes a real subprocess stream and waits for exit after completion", async () => {
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
  const handle = await runtime.start(
    { cwd: process.cwd(), prompt: "hello", readOnly: true },
    (event) => events.push(event),
  );
  const result = await handle.done;
  assert.equal(result.status, "completed");
  assert.equal(result.threadId, "thread-one");
  assert.equal(result.text, "hello");
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    cachedInputTokens: 3,
    outputTokens: 5,
  });
  assert.equal(
    events.filter((event) => event.type === "tool.started").length,
    1,
  );
  assert.equal(
    events.find((event) => event.type === "tool.completed")?.itemId,
    "tool",
  );
  assert.equal(
    events.find((event) => event.type === "assistant.delta")?.text,
    "hello",
  );
  assert.throws(() => process.kill(handle.pid!, 0));
  await runtime.close();
});

test("resumes the requested thread, steers only the current turn, and interrupts before done", async () => {
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
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const handle = await runtime.start(
    { cwd: process.cwd(), prompt: "go", threadId: "saved-thread" },
    (event) => {
      if ((event.detail as { method?: string })?.method === "turn/started")
        started();
    },
  );
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await handle.inject("new instruction"), true);
  await handle.interrupt();
  const result = await handle.done;
  assert.equal(result.status, "interrupted");
  assert.equal(result.threadId, "saved-thread");
  assert.equal(result.text, "new instruction");
  assert.equal(await handle.inject("late"), false);
  assert.throws(() => process.kill(handle.pid!, 0));
});

test("fails on RPC errors and unexpected process exit", async () => {
  for (const action of [
    `send({id:r.id,error:{code:-1,message:'invalid model'}})`,
    "process.exit(7)",
  ]) {
    const runtime = fake(`if(r.method === 'turn/start') { ${action}; }`);
    const handle = await runtime.start(
      { cwd: process.cwd(), prompt: "go" },
      () => {},
    );
    const result = await handle.done;
    assert.equal(result.status, "failed");
    assert.match(result.error!, /invalid model|exited before turn completion/);
    assert.throws(() => process.kill(handle.pid!, 0));
  }
});

test("reports only the current turn usage when resume totals arrive after its response", async () => {
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
  const handle = await runtime.start(
    { cwd: process.cwd(), threadId: "saved-thread", prompt: "go" },
    () => {},
  );
  assert.deepEqual((await handle.done).usage, {
    inputTokens: 20,
    cachedInputTokens: 5,
    outputTokens: 7,
  });
});

test("does not accept turn completion when its process cannot shut down", async () => {
  const runtime = fake(`
    if(r.method === 'turn/start') {
      reply(r,{turn:{id:'active'}});
      setInterval(()=>{},1000);
      notify('turn/completed',{threadId:'thread-one',turn:{id:'active',status:'completed'}});
    }
  `);
  const handle = await runtime.start(
    { cwd: process.cwd(), prompt: "go" },
    () => {},
  );
  const result = await handle.done;
  assert.equal(result.status, "failed");
  assert.match(result.error!, /did not exit/);
  assert.throws(() => process.kill(handle.pid!, 0));
});

test("interrupt during initialization kills an unresponsive child before resolving", async () => {
  const runtime = new CodexRuntime({
    executable: process.execPath,
    args: ["-e", "process.stdin.resume(); setInterval(()=>{},1000)"],
    shutdownTimeoutMs: 50,
    requestTimeoutMs: 500,
  });
  const handle = await runtime.start(
    { cwd: process.cwd(), prompt: "go" },
    () => {},
  );
  await handle.interrupt();
  assert.equal((await handle.done).status, "interrupted");
  assert.throws(() => process.kill(handle.pid!, 0));
  await runtime.close();
  await assert.rejects(
    runtime.start({ cwd: process.cwd(), prompt: "go" }, () => {}),
    /closed/,
  );
});

test("declines approval requests and preserves sandbox and environment options", async () => {
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
  const handle = await runtime.start(
    {
      cwd: process.cwd(),
      prompt: "go",
      readOnly: true,
      env: { HARNESS_TEST_TOKEN: "inherited" },
    },
    () => {},
  );
  assert.equal((await handle.done).status, "completed");
});

test("keeps execution credentials out of events and final text", async () => {
  const runtime = fake(`
    if(r.method === 'turn/start') {
      reply(r,{turn:{id:'active'}});
      notify('item/agentMessage/delta',{threadId:'thread-one',itemId:'message',delta:process.env.HARNESS_TEST_TOKEN});
      notify('item/completed',{threadId:'thread-one',item:{id:'tool',type:'commandExecution',aggregatedOutput:process.env.HARNESS_TEST_TOKEN}});
      notify('turn/completed',{threadId:'thread-one',turn:{id:'active',status:'completed'}});
    }
  `);
  const events: RuntimeEvent[] = [];
  const handle = await runtime.start(
    {
      cwd: process.cwd(),
      prompt: "go",
      env: { HARNESS_TEST_TOKEN: "private-execution-token" },
    },
    (event) => events.push(event),
  );
  assert.equal((await handle.done).text, "[redacted]");
  assert.doesNotMatch(JSON.stringify(events), /private-execution-token/);
});

test("rejects report roots that would make the entire reviewed project writable", async () => {
  const runtime = fake("");
  await assert.rejects(
    runtime.start(
      {
        cwd: process.cwd(),
        prompt: "go",
        readOnly: true,
        writableRoots: [process.cwd()],
      },
      () => {},
    ),
    /cannot include the project/,
  );
});

test(
  "real Codex starts and resumes a persisted read-only thread",
  { skip: process.env.HARNESS_CODEX_SMOKE !== "1", timeout: 180_000 },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "harness-codex-smoke-"));
    const runtime = new CodexRuntime();
    t.after(() => runtime.close());
    try {
      const first = await runtime.start(
        {
          cwd,
          prompt:
            "Remember the marker RUNTIME_SAPPHIRE_42 for the next message. Reply only with that marker. Do not call tools.",
          readOnly: true,
          reasoning: "low",
        },
        () => {},
      );
      const initial = await first.done;
      assert.equal(initial.status, "completed", initial.error);
      assert.match(initial.text, /RUNTIME_SAPPHIRE_42/);
      assert.ok(initial.threadId);
      assert.ok(initial.usage && initial.usage.inputTokens > 0);
      const second = await runtime.start(
        {
          cwd,
          threadId: initial.threadId,
          prompt:
            "What marker did I ask you to remember? Reply only with that marker. Do not call tools.",
          readOnly: true,
          reasoning: "low",
        },
        () => {},
      );
      const resumed = await second.done;
      assert.equal(resumed.status, "completed", resumed.error);
      assert.equal(resumed.threadId, initial.threadId);
      assert.match(resumed.text, /RUNTIME_SAPPHIRE_42/);
      assert.ok(resumed.usage && resumed.usage.inputTokens > 0);
    } finally {
      await runtime.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "real Codex confines reviewer writes to reports and reaches authenticated loopback",
  {
    skip: process.env.HARNESS_CODEX_PERMISSIONS_SMOKE !== "1",
    timeout: 180_000,
  },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "harness-codex-permissions-"));
    const reports = join(cwd, "reports");
    await mkdir(reports);
    const http = createServer((request, response) => {
      response.writeHead(
        request.headers.authorization === "Bearer smoke-only-token" ? 200 : 403,
      );
      response.end("loopback-ok");
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const proof = `
const fs=require('node:fs');
(async()=>{
 let denied=false;
 try{fs.writeFileSync(${JSON.stringify(join(cwd, "forbidden.txt"))},'must-not-exist')}catch(error){denied=true}
 let traversalDenied=false;
 const relative=require('node:path').relative(process.cwd(),${JSON.stringify(join(cwd, "forbidden-relative.txt"))});
 try{fs.writeFileSync(relative,'must-not-exist')}catch(error){traversalDenied=true}
 const response=await fetch(process.env.HARNESS_TEST_URL,{headers:{authorization:'Bearer '+process.env.HARNESS_TEST_TOKEN}});
 const result={denied,traversalDenied,status:response.status,text:await response.text()};
 fs.writeFileSync(${JSON.stringify(join(reports, "proof.json"))},JSON.stringify(result));
 console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1});
`;
    await writeFile(join(cwd, "proof.cjs"), proof);
    const runtime = new CodexRuntime();
    t.after(() => runtime.close());
    const events: RuntimeEvent[] = [];
    try {
      const handle = await runtime.start(
        {
          cwd,
          readOnly: true,
          writableRoots: [reports],
          reasoning: "low",
          env: {
            HARNESS_TEST_URL: url,
            HARNESS_TEST_TOKEN: "smoke-only-token",
          },
          prompt: `This is an authorized sandbox enforcement test in a disposable directory. Run exactly node ${JSON.stringify(join(cwd, "proof.cjs"))} once using the shell tool. The fixture intentionally attempts one forbidden file creation to prove access is denied, writes its proof in the allowed reports directory, and tests a localhost HTTP endpoint. Do not modify the fixture. Do not request escalation. Reply with its output.`,
        },
        (event) => events.push(event),
      );
      const result = await handle.done;
      assert.equal(result.status, "completed", result.error);
      const evidence = JSON.parse(
        await readFile(join(reports, "proof.json"), "utf8").catch((error) => {
          throw new Error(`${error.message}\nCodex: ${result.text}`);
        }),
      );
      assert.deepEqual(evidence, {
        denied: true,
        traversalDenied: true,
        status: 200,
        text: "loopback-ok",
      });
      await assert.rejects(readFile(join(cwd, "forbidden.txt")), /ENOENT/);
      await assert.rejects(
        readFile(join(cwd, "forbidden-relative.txt")),
        /ENOENT/,
      );
      assert.ok(events.some((event) => event.type === "tool.completed"));
    } finally {
      await runtime.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "real Codex accepts steering and confirms interruption",
  { skip: process.env.HARNESS_CODEX_CONTROL_SMOKE !== "1", timeout: 180_000 },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "harness-codex-control-"));
    const runtime = new CodexRuntime();
    t.after(() => runtime.close());
    let toolStarted!: () => void;
    const ready = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let commandPid: number | undefined;
    let output = "";
    try {
      const handle = await runtime.start(
        {
          cwd,
          readOnly: true,
          reasoning: "low",
          prompt:
            "Run the shell command node -e \"console.log('RUNTIME_CHILD_PID='+process.pid);setTimeout(()=>console.log('WAIT_COMPLETE'),30000)\" exactly once with yield_time_ms=1000. Keep waiting for completion, then reply DONE. This is an authorized interrupt test; do not request escalation.",
        },
        (event) => {
          const detail = event.detail as
            { method?: string; params?: { delta?: string } } | undefined;
          if (detail?.method === "item/commandExecution/outputDelta") {
            output += detail.params?.delta ?? "";
            const match = /RUNTIME_CHILD_PID=(\d+)/.exec(output);
            if (match) {
              commandPid = Number(match[1]);
              toolStarted();
            }
          }
        },
      );
      await Promise.race([
        ready,
        handle.done.then((result) => {
          throw new Error(
            `Turn ended before control probe: ${result.error ?? result.text}`,
          );
        }),
      ]);
      assert.equal(
        await handle.inject(
          "After the running command finishes, reply STEER_ACCEPTED instead.",
        ),
        true,
      );
      await handle.interrupt();
      assert.equal((await handle.done).status, "interrupted");
      assert.throws(() => process.kill(handle.pid!, 0));
      const stoppedPid = commandPid;
      assert.ok(stoppedPid);
      assert.throws(() => process.kill(stoppedPid, 0));
    } finally {
      await runtime.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
