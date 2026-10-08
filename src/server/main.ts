import { fileURLToPath } from "node:url";
import { createHttpServer } from "./http.ts";
import { CodexRuntime } from "./runtime.ts";
import { GitWorkspaces } from "./git.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(flag("port") || process.env.HARNESS_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid port");
const app = await createHttpServer({
  runtime: new CodexRuntime(),
  git: new GitWorkspaces(),
  projectRoot: flag("project"),
  staticDir: fileURLToPath(new URL("../web", import.meta.url)),
  catalogPath: process.env.HARNESS_CATALOG,
  registryPath: process.env.HARNESS_REGISTRY,
});
app.server.listen(port, "127.0.0.1", () =>
  process.stdout.write(`New Harness · http://127.0.0.1:${port}\n`),
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void app.close().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(String(error) + "\n");
      process.exit(1);
    },
  );
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
app.server.on("error", (error) => {
  process.stderr.write(error.message + "\n");
  stop();
});
