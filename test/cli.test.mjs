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
