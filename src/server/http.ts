import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { HarnessEngine } from "./engine.ts";
import { Catalog } from "./catalog.ts";
import type {
  Runtime,
  GitAdapter,
  AppState,
  GraphInput,
  TaskInput,
  LetterInput,
  AgentTemplate,
  TaskType,
  Outcome,
  Graph,
  Session,
} from "../shared/types.ts";

export async function createHttpServer(options: {
  runtime: Runtime;
  git: GitAdapter;
  catalogPath?: string;
  projectRoot?: string;
  staticDir?: string;
}) {
  const catalog = new Catalog(options.catalogPath),
    streams = new Set<ServerResponse>();
  let engine: HarnessEngine | undefined;
  const view = (): AppState =>
    engine?.view() || {
      project: null,
      sessions: [],
      graphs: [],
      letters: [],
      agentTemplates: catalog.agents,
      taskTypes: catalog.taskTypes,
      runtime: {
        name: options.runtime.name,
        capabilities: options.runtime.capabilities,
      },
    };
  const broadcast = () => {
    const message = "event: state\ndata: " + JSON.stringify(view()) + "\n\n";
    for (const stream of streams) stream.write(message);
  };
  const open = (path: string) => {
    if (
      engine?.busy ||
      engine?.state.graphs.some((g) =>
        ["running", "pausing", "merging"].includes(g.status),
      )
    )
      throw new Error("请先暂停当前项目并等待执行结束");
    if (
      engine &&
      resolve(path).toLowerCase() === engine.state.project.path.toLowerCase()
    )
      return;
    const next = new HarnessEngine(path, options.runtime, options.git, catalog);
    engine?.close();
    engine = next;
    engine.listeners.add(broadcast);
    broadcast();
  };
  if (options.projectRoot) open(options.projectRoot);
  const server = createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const host = req.headers.host || "";
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) {
        json(403, { error: "只允许本地访问" });
        return;
      }
      if (
        (req.headers.origin && new URL(req.headers.origin).host !== host) ||
        req.headers["sec-fetch-site"] === "cross-site"
      ) {
        json(403, { error: "跨站请求被拒绝" });
        return;
      }
      const url = new URL(req.url || "/", `http://${host}`),
        path = url.pathname;
      if (path === "/api/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("event: state\ndata: " + JSON.stringify(view()) + "\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      }
      if (req.method === "GET" && path === "/api/state") {
        json(200, view());
        return;
      }
      let body: Record<string, unknown> = {};
      if (["POST", "PATCH"].includes(req.method || "")) {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 1_000_000) throw new Error("请求过大");
        }
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("请求必须是 JSON 对象");
        body = parsed as Record<string, unknown>;
      }
      if (req.method === "POST" && path === "/api/project") {
        if (typeof body.path !== "string") throw new Error("缺少项目路径");
        open(body.path);
        const address = server.address();
        if (engine && address && typeof address !== "string")
          engine.endpoint = `http://127.0.0.1:${address.port}`;
        json(200, view());
        return;
      }
      if (path.startsWith("/api/")) {
        if (!engine) {
          json(409, { error: "请先打开项目" });
          return;
        }
        const parts = path.split("/").filter(Boolean).map(decodeURIComponent),
          method = req.method;
        const token = (req.headers.authorization || "").replace(/^Bearer /, "");
        if (method === "POST" && path === "/api/sessions") {
          json(
            201,
            engine.createSession(
              body as {
                title: string;
                model?: string;
                reasoning?: Session["reasoning"];
              },
            ),
          );
          return;
        }
        if (
          method === "POST" &&
          parts[1] === "sessions" &&
          parts[3] === "turn"
        ) {
          json(202, engine.sendMessage(parts[2], body.text as string));
          return;
        }
        if (
          method === "POST" &&
          parts[1] === "sessions" &&
          parts[3] === "interrupt"
        ) {
          json(200, await engine.interrupt(parts[2]));
          return;
        }
        if (method === "GET" && path === "/api/events") {
          json(
            200,
            engine.store.events({
              sessionId: url.searchParams.get("sessionId") || undefined,
              graphId: url.searchParams.get("graphId") || undefined,
              after: Number(url.searchParams.get("after") || 0),
            }),
          );
          return;
        }
        if (method === "POST" && path === "/api/graphs") {
          json(201, engine.createGraph(body as unknown as GraphInput));
          return;
        }
        if (parts[1] === "graphs" && parts[2]) {
          const id = parts[2];
          if (method === "PATCH" && parts.length === 3) {
            json(
              200,
              engine.updateGraph(
                id,
                body as {
                  subscription?: Graph["subscription"];
                  controllerSessionId?: string;
                },
              ),
            );
            return;
          }
          if (method === "POST" && parts[3] === "run") {
            json(200, await engine.runGraph(id));
            return;
          }
          if (method === "POST" && parts[3] === "pause") {
            json(
              200,
              await engine.pauseGraph(id, body.mode as "soft" | "hard"),
            );
            return;
          }
          if (method === "POST" && parts[3] === "resume") {
            json(200, engine.resumeGraph(id));
            return;
          }
          if (method === "POST" && parts[3] === "resolve") {
            json(
              200,
              await engine.resolveGraph(id, body.taskId as string | undefined),
            );
            return;
          }
          if (method === "POST" && parts[3] === "tasks") {
            json(201, engine.appendTask(id, body as unknown as TaskInput));
            return;
          }
          if (method === "PATCH" && parts[3] === "tasks" && parts[4]) {
            json(
              200,
              engine.editTask(id, parts[4], body as Partial<TaskInput>),
            );
            return;
          }
          if (method === "GET" && parts[3] === "debug") {
            json(200, engine.debug(id));
            return;
          }
        }
        if (method === "POST" && path === "/api/unit/report") {
          if (!token) {
            json(401, { error: "缺少执行凭据" });
            return;
          }
          json(
            200,
            engine.submit(
              token,
              body as { outcome: Outcome; report: string; key?: string },
            ),
          );
          return;
        }
        if (method === "POST" && path === "/api/letters") {
          json(
            201,
            engine.sendLetter(
              body as unknown as LetterInput,
              token || undefined,
            ),
          );
          return;
        }
        if (method === "GET" && parts[1] === "reports" && parts[2]) {
          json(200, engine.report(parts[2]));
          return;
        }
        if (method === "POST" && path === "/api/catalog/agents") {
          json(200, engine.saveAgent(body as unknown as AgentTemplate));
          return;
        }
        if (method === "POST" && path === "/api/catalog/task-types") {
          json(200, engine.saveType(body as unknown as TaskType));
          return;
        }
        json(404, { error: "接口不存在" });
        return;
      }
      if (req.method !== "GET") {
        json(405, { error: "不支持的方法" });
        return;
      }
      const base = resolve(options.staticDir || "dist/web"),
        file = resolve(base, path === "/" ? "index.html" : "." + path);
      if (file !== base && !file.startsWith(base + sep)) {
        json(403, { error: "路径越界" });
        return;
      }
      try {
        const content = await readFile(file);
        res.writeHead(200, {
          "Content-Type":
            (
              {
                ".html": "text/html; charset=utf-8",
                ".js": "text/javascript",
                ".css": "text/css",
                ".svg": "image/svg+xml",
              } as Record<string, string>
            )[extname(file)] || "application/octet-stream",
        });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Run npm run build to prepare the Web UI.");
      }
    } catch (error) {
      json(400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  server.on("listening", () => {
    const address = server.address();
    if (engine && address && typeof address !== "string")
      engine.endpoint = `http://127.0.0.1:${address.port}`;
  });
  return {
    server,
    get engine() {
      return engine;
    },
    close: async () => {
      await engine?.shutdown();
      for (const s of streams) s.end();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      engine?.close();
      await options.runtime.close?.();
    },
  };
}
