import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const distEntry = path.join(packageRoot, "dist/index.js");
const shebang = "#!/usr/bin/env node";

test("built executable has one shebang and valid syntax", async () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await execFileAsync(npm, ["run", "build"], { cwd: packageRoot });

  const source = await readFile(distEntry, "utf8");
  const lines = source.split(/\r?\n/);
  assert.equal(lines[0], shebang);
  assert.notEqual(lines[1], shebang);
  assert.equal(source.match(/^#!\/usr\/bin\/env node$/gm)?.length, 1);

  await execFileAsync(process.execPath, ["--check", distEntry]);
});

test("the server version is the package version", async () => {
  const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { version: string };
  const { MCP_VERSION } = await import("./version.js");
  assert.equal(MCP_VERSION, pkg.version);
});
