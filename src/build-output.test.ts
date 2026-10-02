import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("the built server starts without a key and explains how to sign in", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "stormgtm-mcp-nokey-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.STORMGTM_API_KEY;
  delete env.STORMGTM_API_URL;
  const child = spawn(process.execPath, [distEntry], { cwd: packageRoot, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } });
    const deadline = Date.now() + 10_000;
    while (!stdout.includes('"id":2') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const reply = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id?: number; result?: { isError?: boolean; content: Array<{ text: string }> } }).find((message) => message.id === 2);
    assert.equal(reply?.result?.isError, true);
    assert.match(reply?.result?.content[0]?.text ?? "", /stormgtm login/);
    assert.match(stderr, /not signed in/);
    assert.doesNotMatch(stderr, /\n\s+at /);
  } finally {
    child.kill();
    await rm(home, { recursive: true, force: true });
  }
});
