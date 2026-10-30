import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/server/", import.meta.url), { recursive: true });
for (const name of ["windows-process-owner.ps1", "windows-process-owner.cs"]) {
  await copyFile(new URL(`../src/server/${name}`, import.meta.url), new URL(`../dist/server/${name}`, import.meta.url));
}
