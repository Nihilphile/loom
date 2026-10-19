import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { HarnessEngine } from "./engine.ts";
import { Catalog } from "./catalog.ts";
import { ProjectRegistry } from "./projects.ts";
import { resolveAttachments, saveAttachment } from "./attachments.ts";
import { z } from "zod/v4";
import { ControllerError, controllerCommandSchema } from "../shared/controller.ts";
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
  TurnInput,
  InterviewSettings,
} from "../shared/types.ts";

type StateStream = {
  send: (message: () => string) => void;
  close: () => void;
};

export async function createHttpServer(options: {
  runtime: Runtime;
  git: GitAdapter;
  catalogPath?: string;
  registryPath?: string;
  projectRoot?: string;
  staticDir?: string;
}) {
  const catalog = new Catalog(options.catalogPath);
  const registry = new ProjectRegistry(
    options.registryPath ||
      (options.catalogPath
        ? join(dirname(options.catalogPath), "projects.json")
        : undefined),
  );
  const engines = new Map<string, HarnessEngine>();
  const streams = new Map<string, Set<StateStream>>();
  let defaultProjectId: string | undefined;
  let endpoint = "";
  let closing = false;
  const view = (engine?: HarnessEngine): AppState =>
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
  const stateMessage = (id: string) =>
    "event: state\ndata: " + JSON.stringify(view(engines.get(id))) + "\n\n";
  const broadcast = (id: string) => {
    let message: string | undefined;
    const latest = () => (message ??= stateMessage(id));
    for (const stream of streams.get(id) || []) stream.send(latest);
  };
  const open = (id: string): HarnessEngine => {
    const existing = engines.get(id);
    if (existing) return existing;
    const entry = registry.get(id);
    const engine = new HarnessEngine(
      entry.path,
      options.runtime,
      options.git,
      catalog,
    );
    engine.state.project.name = entry.name;
    engine.endpoint = endpoint;
    engines.set(id, engine);
    engine.listeners.add(() => broadcast(id));
    return engine;
  };
  if (options.projectRoot) {
    defaultProjectId = registry.register(options.projectRoot).id;
    open(defaultProjectId);
  }
  const server = createServer(async (req, res) => {
    const controllerRequest = /^\/api\/(?:projects\/[^/]+\/)?controller\//.test(req.url || "");
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (closing) {
        json(503, { error: "服务正在关闭" });
        return;
      }
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
      const url = new URL(req.url || "/", `http://${host}`);
      const scoped = /^\/api\/projects\/([^/]+)(\/.*)$/.exec(url.pathname);
      const path = scoped ? "/api" + scoped[2] : url.pathname;
      const token = (req.headers.authorization || "").replace(/^Bearer /, "");
      const controllerRoute = /^\/api\/controller\/([^/]+)$/.exec(path);
      const controllerKey = req.headers["x-loom-controller-key"];
      if ((controllerRoute && (req.headers.authorization || !scoped)) || (controllerKey && !controllerRoute))
        throw new ControllerError("FORBIDDEN", "Controller credentials require an explicit project controller route; Unit credentials are not accepted", 403);
      let projectId = scoped ? decodeURIComponent(scoped[1]) : defaultProjectId;
      if (!scoped && token) {
        const digest = createHash("sha256").update(token).digest("hex");
        projectId = [...engines].find(([, e]) =>
          e.state.executions.some((x) => x.tokenHash === digest),
        )?.[0];
        if (!projectId) {
          json(401, { error: "执行凭据无效" });
          return;
        }
      }
      const engine = scoped
        ? open(projectId!)
        : projectId
          ? engines.get(projectId)
          : undefined;
      if (
        token &&
        engine &&
        !engine.state.executions.some(
          (x) =>
            x.tokenHash === createHash("sha256").update(token).digest("hex"),
        )
      ) {
        json(403, { error: "执行凭据不属于此项目" });
        return;
      }
      if (req.method === "GET" && path === "/api/projects") {
        json(200, {
          projects: registry.projects.map((p) => ({
            ...p,
            activeSessions:
              engines
                .get(p.id)
                ?.state.sessions.filter((s) => s.status === "running").length ||
              0,
            activeGraphs:
              engines
                .get(p.id)
                ?.state.graphs.filter((g) =>
                  ["running", "pausing", "merging"].includes(g.status),
                ).length || 0,
          })),
        });
        return;
      }
      if (req.method === "GET" && path === "/api/stream") {
        if (!engine || !projectId) {
          json(409, { error: "请先打开项目" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const id = projectId;
        const subscribers = streams.get(id) || new Set<StateStream>();
        let state: "ready" | "blocked" | "pending" | "closed" = "ready";
        const send = (message: () => string) => {
          if (state === "closed") return;
          if (state !== "ready") {
            state = "pending";
            return;
          }
          if (!res.write(message())) state = "blocked";
        };
        const drain = () => {
          if (state === "closed") return;
          const pending = state === "pending";
          state = "ready";
          if (pending) send(() => stateMessage(id));
        };
        const cleanup = () => {
          state = "closed";
          res.off("drain", drain);
          res.off("close", cleanup);
          subscribers.delete(stream);
          if (!subscribers.size) streams.delete(id);
        };
        const stream: StateStream = {
          send,
          close: () => {
            cleanup();
            res.end();
          },
        };
        streams.set(id, subscribers);
        subscribers.add(stream);
        res.on("drain", drain);
        res.once("close", cleanup);
        send(() => stateMessage(id));
        return;
      }
      if (req.method === "GET" && path === "/api/state") {
        json(200, view(engine));
        return;
      }
      let body: Record<string, unknown> = {};
      if (["POST", "PATCH", "PUT"].includes(req.method || "")) {
        let raw = "";
        req.setEncoding("utf8");
        for await (const chunk of req) {
          raw += chunk;
          if (
            raw.length > (path === "/api/attachments" ? 14_100_000 : 1_000_000)
          )
            throw new Error("请求过大");
        }
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("请求必须是 JSON 对象");
        body = parsed as Record<string, unknown>;
      }
      if (
        req.method === "POST" &&
        (path === "/api/project" || path === "/api/projects")
      ) {
        if (typeof body.path !== "string") throw new Error("缺少项目路径");
        const entry = registry.register(
          body.path,
          body.name as string | undefined,
        );
        if (path === "/api/project") {
          defaultProjectId ??= entry.id;
          json(200, view(open(entry.id)));
        } else json(201, entry);
        return;
      }
      if (path.startsWith("/api/")) {
        if (!engine) {
          json(409, { error: "请先打开项目" });
          return;
        }
        const parts = path.split("/").filter(Boolean).map(decodeURIComponent),
          method = req.method;
        if (controllerRoute) {
          if (method !== "POST") throw new ControllerError("METHOD_NOT_ALLOWED", "Controller operations require POST", 405);
          const sessionId = z.uuid().safeParse(decodeURIComponent(controllerRoute[1]));
          const command = controllerCommandSchema.safeParse(body);
          if (!sessionId.success || !command.success)
            throw new ControllerError("INVALID_ARGUMENT", "Invalid controller operation or arguments", 400);
          json(200, await engine.controllerCommand(sessionId.data, typeof controllerKey === "string" ? controllerKey : "", command.data));
          return;
        }
        if (method === "PUT" && path === "/api/developer/interviews") {
          json(
            200,
            engine.updateInterviews(body as unknown as InterviewSettings),
          );
          return;
        }
        if (
          method === "POST" &&
          parts[1] === "sessions" &&
          parts[3] === "sidechats"
        ) {
          json(
            201,
            engine.createSidechat(parts[2], body as { title?: string }),
          );
          return;
        }
        if (
          method === "POST" &&
          parts[1] === "sessions" &&
          parts[3] === "interviews"
        ) {
          json(202, await engine.interview(parts[2]));
          return;
        }
        if (
          method === "POST" &&
          parts[1] === "sessions" &&
          parts[3] === "preparations" &&
          parts[5] === "resolve"
        ) {
          json(
            200,
            engine.resolvePreparation(
              parts[2],
              parts[4],
              body as { accepted: boolean; threadId?: string; turnId?: string },
            ),
          );
          return;
        }
        if (method === "GET" && path === "/api/runtime/options") {
          if (!options.runtime.discoverOptions)
            throw new Error("当前 Runtime 不支持模型与 Skill 查询");
          json(
            200,
            await options.runtime.discoverOptions(engine.state.project.path),
          );
          return;
        }
        if (method === "POST" && path === "/api/attachments") {
          json(
            201,
            saveAttachment(
              engine.state.project.path,
              body as { name: string; mediaType: string; base64: string },
            ),
          );
          return;
        }
        if (method === "GET" && parts[1] === "attachments" && parts[2]) {
          const attachment = resolveAttachments(engine.state.project.path, [
            parts[2],
          ])[0];
          const bytes = await readFile(attachment.path);
          res.writeHead(200, {
            "Content-Type": attachment.mediaType,
            "Content-Length": bytes.length,
            "Content-Disposition": `${attachment.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/'/g, "%27")}`,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=31536000, immutable",
          });
          res.end(bytes);
          return;
        }
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
          json(
            202,
            await engine.sendMessage(parts[2], body as unknown as TurnInput),
          );
          return;
        }
        if (
          method === "DELETE" &&
          parts[1] === "sessions" &&
          parts[3] === "queue" &&
          parts[4]
        ) {
          json(200, engine.cancelQueued(parts[2], parts[4]));
          return;
        }
        if (
          method === "POST" &&
          parts[1] === "sessions" &&
          parts[3] === "continue"
        ) {
          json(200, await engine.continueQueue(parts[2]));
          return;
        }
        if (
          method === "POST" &&
          parts[1] === "sessions" &&
          parts[3] === "interrupt"
        ) {
          json(
            200,
            await engine.interrupt(
              parts[2],
              body.expectedExecutionId as string | undefined,
            ),
          );
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
            json(200, await engine.resumeGraph(id));
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
          for (const id of engines.keys()) broadcast(id);
          return;
        }
        if (method === "POST" && path === "/api/catalog/task-types") {
          json(200, engine.saveType(body as unknown as TaskType));
          for (const id of engines.keys()) broadcast(id);
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
      if (error instanceof ControllerError) {
        json(error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      if (controllerRequest) {
        json(400, { error: { code: "OPERATION_FAILED", message: error instanceof Error ? error.message : "Controller operation failed" } });
        return;
      }
      json(400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  server.on("listening", () => {
    const address = server.address();
    if (address && typeof address !== "string") {
      endpoint = `http://127.0.0.1:${address.port}`;
      for (const engine of engines.values()) engine.endpoint = endpoint;
    }
  });
  return {
    server,
    get engine() {
      return defaultProjectId ? engines.get(defaultProjectId) : undefined;
    },
    engines,
    close: async () => {
      closing = true;
      await Promise.all([...engines.values()].map((e) => e.shutdown()));
      for (const subscribers of streams.values())
        for (const s of subscribers) s.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      for (const engine of engines.values()) engine.close();
      await options.runtime.close?.();
    },
  };
}
