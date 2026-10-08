#!/usr/bin/env node
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const help = `New Harness CLI
  unit report --outcome ready|approved|changes_requested|blocked --report <file> [--key <id>]
  letter send --graph <id> --to <graph/task/unit[,address]> --title <20 chars> --file <path> [--steer|--followup]
  state
  graph create --file <graph.json>
  graph run|resume|resolve --id <graph-id>
  graph pause --id <graph-id> [--hard]
  graph add-task --id <graph-id> --file <task.json>

The launcher supplies HARNESS_URL, HARNESS_PROJECT_ID, HARNESS_TOKEN and HARNESS_ADDRESS. Never print credentials.`;
async function main() {
  if (!args.length || args.includes("--help")) {
    process.stdout.write(help + "\n");
    return;
  }
  const url = new URL(process.env.HARNESS_URL || "http://127.0.0.1:4317");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:"
  )
    throw new Error("HARNESS_URL must be a local HTTP address");
  const option = (name: string, required = true) => {
    const index = args.indexOf("--" + name);
    const value = index >= 0 ? args[index + 1] : undefined;
    if (required && (!value || value.startsWith("--")))
      throw new Error("Missing --" + name);
    return value;
  };
  let path: string, body: unknown;
  if (args[0] === "unit" && args[1] === "report") {
    if (!process.env.HARNESS_TOKEN)
      throw new Error("This command requires a harness unit execution");
    path = "/api/unit/report";
    body = {
      outcome: option("outcome"),
      report: resolve(option("report")!),
      key: option("key", false),
    };
  } else if (args[0] === "letter" && args[1] === "send") {
    if (args.includes("--steer") && args.includes("--followup"))
      throw new Error("Choose either --steer or --followup");
    path = "/api/letters";
    body = {
      graphId: option("graph"),
      from: process.env.HARNESS_ADDRESS || option("from"),
      to: option("to")!
        .split(",")
        .map((v) => v.trim()),
      title: option("title"),
      path: resolve(option("file")!),
      mode: args.includes("--steer")
        ? "steer"
        : args.includes("--followup")
          ? "followup"
          : "auto",
    };
  } else if (args[0] === "graph") {
    if (args[1] === "create") {
      path = "/api/graphs";
      body = JSON.parse(readFileSync(resolve(option("file")!), "utf8"));
    } else if (args[1] === "add-task") {
      path = `/api/graphs/${encodeURIComponent(option("id")!)}/tasks`;
      body = JSON.parse(readFileSync(resolve(option("file")!), "utf8"));
    } else if (["run", "resume", "resolve", "pause"].includes(args[1])) {
      path = `/api/graphs/${encodeURIComponent(option("id")!)}/${args[1]}`;
      body =
        args[1] === "pause"
          ? { mode: args.includes("--hard") ? "hard" : "soft" }
          : {};
    } else throw new Error(help);
  } else if (args[0] === "state") {
    path = "/api/state";
  } else throw new Error(help);
  const projectId = process.env.HARNESS_PROJECT_ID;
  if (projectId)
    path = `/api/projects/${encodeURIComponent(projectId)}` + path.slice(4);
  const response = await fetch(new URL(path, url), {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.HARNESS_TOKEN
        ? { Authorization: "Bearer " + process.env.HARNESS_TOKEN }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
main().catch((error) => {
  process.stderr.write(
    (error instanceof Error ? error.message : String(error)) + "\n",
  );
  process.exitCode = 1;
});
