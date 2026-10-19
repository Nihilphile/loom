import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { controllerCommandSchema, controllerDescriptions } from "./shared/controller.ts";

const configSchema = z.strictObject({
  port: z.coerce.number().int().min(1).max(65535),
  project: z.string().regex(/^[a-f0-9]{24}$/), session: z.uuid(),
  key: z.string().min(32).max(512),
});

async function main() {
  if (process.env.HARNESS_TOKEN)
    throw new Error("The loom MCP is for the Desktop controller, not Unit executions");
  const flags: Record<string, string> = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!["--port", "--project", "--session"].includes(name) || !args[i + 1] || flags[name.slice(2)])
      throw new Error("Usage: node dist/mcp-controller.js --port <local-port> --project <project-id> --session <free-session-uuid>");
    flags[name.slice(2)] = args[i + 1];
  }
  const parsed = configSchema.safeParse({ ...flags, port: flags.port ?? "4317", key: process.env.LOOM_CONTROLLER_KEY });
  if (!parsed.success) throw new Error("Invalid controller configuration: set port, project, session and LOOM_CONTROLLER_KEY (32 to 512 characters)");
  const config = parsed.data;
  const endpoint = `http://127.0.0.1:${config.port}/api/projects/${config.project}/controller/${config.session}`;
  const server = new McpServer({ name: "loom", version: "0.1.0" });
  for (const schema of controllerCommandSchema.options) {
    const op = schema.shape.op.value;
    const { op: _operation, ...inputShape } = schema.shape;
    server.registerTool(`loom_${op}`, {
      description: controllerDescriptions[op], inputSchema: z.strictObject(inputShape),
      annotations: { readOnlyHint: ["state", "task_types", "reports", "inbox"].includes(op), openWorldHint: false },
    }, async (args) => {
      const failure = (code: string, message: string) => ({ isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
        structuredContent: { error: { code, message } } });
      try {
        const response = await fetch(endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { "Content-Type": "application/json", "X-Loom-Controller-Key": config.key },
          body: JSON.stringify({ ...args, op }),
        });
        const result: unknown = await response.json();
        if (!response.ok) {
          const error = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(result);
          return failure(error.success ? error.data.error.code : "HTTP_ERROR",
            error.success ? error.data.error.message.replaceAll(config.key, "[redacted]") : `Loom HTTP returned ${response.status}`);
        }
        const payload = z.record(z.string(), z.unknown()).safeParse(result);
        if (!payload.success) return failure("INVALID_RESPONSE", "Loom returned an invalid controller response");
        return { content: [{ type: "text" as const, text: JSON.stringify(payload.data) }], structuredContent: payload.data };
      } catch (error) {
        return failure(error instanceof Error && error.name === "TimeoutError" ? "HTTP_TIMEOUT" : "HTTP_UNAVAILABLE",
          "Local Loom request failed. A mutation may have completed; read state or retry the same requestId before issuing new work.");
      }
    });
  }
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : "Controller startup failed") + "\n");
  process.exitCode = 1;
});
