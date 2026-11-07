import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli", "reporoast.mjs");

test("--help exits 0 and documents exit codes", () => {
  const out = execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.match(out, /Exit codes:/);
  assert.match(out, /--json/);
});

test("--json on local repo emits valid JSON with expected fields", () => {
  const out = execFileSync(process.execPath, [CLI, ROOT, "--json"], { encoding: "utf8" });
  const parsed = JSON.parse(out);
  assert.equal(typeof parsed.score, "number");
  assert.equal(parsed.max_score, 100);
  assert.ok(parsed.score >= 70, `expected self-score >= 70, got ${parsed.score}`);
  assert.equal(parsed.checks.length, 6);
});

test("unknown flag exits with code 2", () => {
  assert.throws(
    () => execFileSync(process.execPath, [CLI, "--not-a-real-flag"], { stdio: "pipe" }),
    (err) => err.status === 2
  );
});

test("non-existent local path exits with code 3", () => {
  assert.throws(
    () => execFileSync(process.execPath, [CLI, "/nonexistent/reporoast/path/xyz"], { stdio: "pipe" }),
    (err) => err.status === 3
  );
});

test("--mcp stdio server handles initialize, tools/list, and roast_repository", () => {
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "roast_repository", arguments: { target: ROOT } },
    }),
  ].join("\n") + "\n";

  const out = execFileSync(process.execPath, [CLI, "--mcp"], { input, encoding: "utf8" });
  const lines = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result.serverInfo.name, "reporoast");
  assert.equal(lines[1].id, 2);
  assert.equal(lines[1].result.tools.length, 3);
  assert.equal(lines[2].id, 3);
  const scoreObj = JSON.parse(lines[2].result.content[0].text);
  assert.ok(scoreObj.score >= 70);
});

