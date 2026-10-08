import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const blocked = new Set([
  ".git",
  ".loom",
  ".newharness",
  ".codex",
  "node_modules",
]);
const hidden = (path: string) => {
  const parts = path.split(/[\\/]/);
  const report =
    [".newharness", ".loom"].includes(parts[0]?.toLowerCase()) &&
    parts[1]?.toLowerCase() === "reports";
  return (report ? parts.slice(2) : parts).some(
    (part) => blocked.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part),
  );
};

export async function observerRead(
  root: string,
  operation: string,
  args: Record<string, unknown>,
): Promise<string> {
  root = await realpath(root);
  const requested = typeof args.path === "string" ? args.path : ".";
  const target = await realpath(resolve(root, requested));
  const within = relative(root, target);
  if (
    isAbsolute(within) ||
    within === ".." ||
    within.startsWith(`..${sep}`) ||
    hidden(within)
  )
    throw new Error("Path is outside the readable project");
  if (operation === "list_files") {
    const entries = await readdir(target, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          !entry.isSymbolicLink() &&
          !hidden([within, entry.name].filter(Boolean).join(sep)),
      )
      .slice(0, 500)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .join("\n");
  }
  if (operation !== "read_file") throw new Error("Unsupported read operation");
  const file = await open(target, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink > 1)
      throw new Error("Only ordinary project files can be read");
    if (stat.size > 1_048_576)
      throw new Error("File exceeds the 1 MiB read limit");
    const data = Buffer.alloc(Math.min(stat.size, 1_048_576));
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (data.subarray(0, bytesRead).includes(0))
      throw new Error("Binary files cannot be read as text");
    const lines = data.subarray(0, bytesRead).toString("utf8").split("\n");
    const start =
      typeof args.startLine === "number" && Number.isInteger(args.startLine)
        ? Math.max(1, args.startLine)
        : 1;
    const count =
      typeof args.lineCount === "number" && Number.isInteger(args.lineCount)
        ? Math.max(1, Math.min(500, args.lineCount))
        : 200;
    return lines
      .slice(start - 1, start - 1 + count)
      .map((line, index) => `${start + index}: ${line}`)
      .join("\n")
      .slice(0, 50_000);
  } finally {
    await file.close();
  }
}

if (process.argv[2] === "--serve") {
  const root = process.argv[3];
  if (!root) throw new Error("Observer project root is required");
  const send = (value: unknown) =>
    process.stdout.write(`${JSON.stringify(value)}\n`);
  for await (const line of createInterface({ input: process.stdin })) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.id === undefined) continue;
    try {
      let result;
      if (request.method === "initialize")
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "loom-observer", version: "1" },
        };
      else if (request.method === "tools/list")
        result = {
          tools: [
            {
              name: "list_files",
              description:
                "List a project directory. Runtime storage and symlinks are excluded.",
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                additionalProperties: false,
              },
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
              },
            },
            {
              name: "read_file",
              description:
                "Read numbered lines from an ordinary text file inside the project.",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  startLine: { type: "integer", minimum: 1 },
                  lineCount: { type: "integer", minimum: 1, maximum: 500 },
                },
                required: ["path"],
                additionalProperties: false,
              },
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
              },
            },
          ],
        };
      else if (request.method === "tools/call")
        result = {
          content: [
            {
              type: "text",
              text: await observerRead(
                root,
                request.params?.name,
                request.params?.arguments ?? {},
              ),
            },
          ],
        };
      else if (request.method === "ping") result = {};
      else throw new Error("Unsupported observer request");
      send({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Read failed",
            },
          ],
        },
      });
    }
  }
}
