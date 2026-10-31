#!/usr/bin/env node
/**
 * reporoast — Score any local directory or public GitHub repository for coding-agent readiness.
 * Zero external dependencies (Node >= 18).
 */

import fs from "node:fs";
import path from "node:path";

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_FOUND = 3;
const EXIT_AUTH_OR_LIMIT = 4;

const HELP = `Usage:
  reporoast <target> [options]

Targets:
  . | /path/to/repo              Scan a local repository directory (works on private repos)
  owner/repo                     Scan a public GitHub repository via REST API
  https://github.com/owner/repo  Scan a public GitHub repository URL

Options:
  --json                 Emit structured JSON on stdout (diagnostics go to stderr)
  --emit-agents          Print a starter AGENTS.md tailored to the target on stdout
  --write-agents <path>  Write generated starter AGENTS.md to <path> (fails if exists unless --force)
  --dry-run              Preview --write-agents without modifying the filesystem
  --force                Overwrite existing file when used with --write-agents
  --timeout-ms <ms>      HTTP timeout in milliseconds for GitHub API calls (default: 15000)
  -h, --help             Show this help document and exit 0

Environment:
  GITHUB_TOKEN           Optional token used to raise GitHub API rate limits on remote scans

Exit codes:
  0  Success
  2  Invalid usage or conflicting flags
  3  Target directory or GitHub repository not found
  4  GitHub API authentication or rate-limit failure
  1  Unexpected runtime failure

Examples:
  npx github:jtamanas/reporoast .
  npx github:jtamanas/reporoast sindresorhus/ky --json
  npx github:jtamanas/reporoast . --write-agents AGENTS.md --dry-run
`;

function parseArgs(argv) {
  const opts = {
    target: null,
    json: false,
    emitAgents: false,
    writeAgents: null,
    dryRun: false,
    force: false,
    timeoutMs: 15000,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--emit-agents") {
      opts.emitAgents = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--write-agents") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw Object.assign(new Error("Missing path argument for --write-agents <path>"), { code: EXIT_USAGE });
      }
      opts.writeAgents = next;
    } else if (arg === "--timeout-ms") {
      const next = Number(argv[++i]);
      if (!Number.isFinite(next) || next <= 0) {
        throw Object.assign(new Error("Invalid positive number for --timeout-ms <ms>"), { code: EXIT_USAGE });
      }
      opts.timeoutMs = next;
    } else if (arg.startsWith("-")) {
      throw Object.assign(new Error(`Unknown flag: ${arg}. Run 'reporoast --help' for usage.`), { code: EXIT_USAGE });
    } else if (!opts.target) {
      opts.target = arg;
    } else {
      throw Object.assign(new Error(`Unexpected positional argument: ${arg}`), { code: EXIT_USAGE });
    }
  }
  return opts;
}

const IGNORED_DIRS = new Set([".git", "node_modules", ".venv", "venv", "target", "dist", "build", ".next", "__pycache__"]);

function walkLocalDir(rootDir) {
  const blobs = [];
  function visit(current, relPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full, rel);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(full);
          blobs.push({ path: rel, size: st.size });
        } catch (_) {}
      }
    }
  }
  visit(rootDir, "");
  return blobs;
}

function parseGithubSlug(target) {
  const clean = target.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const m = clean.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(clean)) return clean;
  return null;
}

async function fetchGithubTree(slug, timeoutMs) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "reporoast-cli/1.0",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const metaRes = await fetch(`https://api.github.com/repos/${slug}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (metaRes.status === 404) {
    throw Object.assign(new Error(`GitHub repository not found: ${slug}`), { code: EXIT_NOT_FOUND });
  }
  if (metaRes.status === 401 || metaRes.status === 403 || metaRes.status === 429) {
    throw Object.assign(
      new Error(`GitHub API HTTP ${metaRes.status} for ${slug}. Set GITHUB_TOKEN to raise rate limits.`),
      { code: EXIT_AUTH_OR_LIMIT }
    );
  }
  if (!metaRes.ok) {
    throw Object.assign(new Error(`GitHub API HTTP ${metaRes.status}`), { code: EXIT_RUNTIME });
  }

  const meta = await metaRes.json();
  const branch = encodeURIComponent(meta.default_branch || "main");
  const treeRes = await fetch(`https://api.github.com/repos/${slug}/git/trees/${branch}?recursive=1`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!treeRes.ok) {
    throw Object.assign(new Error(`Failed fetching git tree (HTTP ${treeRes.status})`), { code: EXIT_RUNTIME });
  }
  const treeJson = await treeRes.json();
  const blobs = (treeJson.tree || [])
    .filter((n) => n.type === "blob")
    .map((n) => ({ path: n.path, size: n.size || 0 }));

  return { name: meta.full_name, shortName: meta.name, blobs };
}

function scoreRepository(name, shortName, blobs) {
  const paths = blobs.map((b) => b.path);
  const lower = new Set(paths.map((p) => p.toLowerCase()));
  const checks = [];
  let score = 0;

  const ctxFiles = paths.filter((p) =>
    /^(agents\.md|claude\.md|\.cursorrules|\.github\/copilot-instructions\.md|\.windsurfrules)$/i.test(p)
  );
  if (ctxFiles.length > 0) {
    const first = blobs.find((b) => b.path === ctxFiles[0]);
    const sz = first ? first.size : 0;
    const pts = sz >= 800 ? 25 : 16;
    score += pts;
    checks.push({ id: "agent_context", points: pts, max: 25, detail: `${ctxFiles[0]} (${sz} B)` });
  } else {
    checks.push({ id: "agent_context", points: 0, max: 25, detail: "Missing AGENTS.md / CLAUDE.md" });
  }

  const testFiles = paths.filter((p) =>
    /(^|\/)(test|tests|__tests__|spec|test-d)\/|\.(test|spec)\.[a-z0-9]+$|_test\.go$/i.test(p)
  );
  const testPts = testFiles.length >= 8 ? 20 : testFiles.length >= 1 ? 11 : 0;
  score += testPts;
  checks.push({ id: "tests", points: testPts, max: 20, detail: `${testFiles.length} test files` });

  const workflows = paths.filter((p) => /^\.github\/workflows\/.+\.(yml|yaml)$/i.test(p));
  const ciPts = workflows.length > 0 ? 20 : 0;
  score += ciPts;
  checks.push({ id: "ci", points: ciPts, max: 20, detail: `${workflows.length} GitHub Actions workflows` });

  const lockfiles = paths.filter((p) =>
    /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|cargo\.lock|go\.sum|gemfile\.lock)$/i.test(p)
  );
  const lockPts = lockfiles.length > 0 ? 15 : 7;
  score += lockPts;
  checks.push({ id: "lockfile", points: lockPts, max: 15, detail: lockfiles[0] || "none committed" });

  const largeCode = blobs
    .filter(
      (b) =>
        /\.(ts|tsx|js|jsx|py|go|rs|java|rb|swift|kt)$/i.test(b.path) &&
        !/(dist|build|vendor|min\.js|generated)/i.test(b.path) &&
        b.size > 38000
    )
    .sort((a, b) => b.size - a.size);
  const modPts = largeCode.length === 0 ? 10 : 4;
  score += modPts;
  checks.push({
    id: "module_granularity",
    points: modPts,
    max: 10,
    detail: largeCode.length === 0 ? "No source file > 38 KB" : `Largest: ${largeCode[0].path} (${Math.round(largeCode[0].size / 1024)} KB)`,
  });

  const hasGitignore = lower.has(".gitignore");
  const hasSec = lower.has("security.md") || lower.has(".github/security.md") || lower.has(".github/dependabot.yml");
  const secPts = hasGitignore && hasSec ? 10 : hasGitignore ? 6 : 0;
  score += secPts;
  checks.push({
    id: "hygiene",
    points: secPts,
    max: 10,
    detail: hasGitignore && hasSec ? ".gitignore + security/dependabot" : hasGitignore ? ".gitignore only" : "missing .gitignore",
  });

  let testCmd = "# Add single-file test command";
  let checkCmd = "# Add lint / typecheck command";
  if (lower.has("cargo.toml")) {
    testCmd = "cargo test <test_name> -- --nocapture";
    checkCmd = "cargo clippy --workspace --all-targets -- -D warnings";
  } else if (lower.has("go.mod")) {
    testCmd = "go test -race -run TestName ./...";
    checkCmd = "go vet ./...";
  } else if (lower.has("pyproject.toml") || lower.has("requirements.txt")) {
    testCmd = `${lower.has("uv.lock") ? "uv run pytest" : "pytest"} tests/<module>.py -q`;
    checkCmd = "ruff check .";
  } else if (lower.has("package.json")) {
    const pm = lower.has("pnpm-lock.yaml") ? "pnpm" : lower.has("bun.lock") || lower.has("bun.lockb") ? "bun" : "npm";
    testCmd = `${pm} test`;
    checkCmd = `${pm} run build`;
  }

  const topDirs = Array.from(
    new Set(paths.filter((p) => p.includes("/") && !p.startsWith(".")).map((p) => p.split("/")[0]))
  ).slice(0, 6);

  const starterAgents = [
    `# ${shortName} — Agent Engineering Guide`,
    ``,
    `## Verification Commands`,
    `- Fast test loop: \`${testCmd}\``,
    `- Static & build check: \`${checkCmd}\``,
    ``,
    `## Key Directories`,
    ...(topDirs.length ? topDirs.map((d) => `- \`${d}/\` —`) : [`- Root module layout`]),
    ``,
    `## Guardrails`,
    `- Add a focused regression test before fixing any bug.`,
    `- Preserve public exports and error contracts.`,
    ...(largeCode.length ? [`- Inspect targeted line ranges in \`${largeCode[0].path}\` instead of full-file rewrites.`] : []),
    ``,
  ].join("\n");

  return { target: name, files_scanned: blobs.length, score, max_score: 100, checks, starterAgents };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(err.code || EXIT_USAGE);
  }

  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(EXIT_OK);
  }

  if (!opts.target) {
    process.stderr.write("Error: Missing <target>. Pass '.' for current directory or 'owner/repo'. Run 'reporoast --help'.\n");
    process.exit(EXIT_USAGE);
  }

  try {
    let targetInfo;
    if (opts.target === "." || opts.target.startsWith("./") || opts.target.startsWith("/") || fs.existsSync(opts.target)) {
      const resolved = path.resolve(opts.target);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        process.stderr.write(`Error: Local directory not found: ${resolved}\n`);
        process.exit(EXIT_NOT_FOUND);
      }
      const blobs = walkLocalDir(resolved);
      targetInfo = { name: resolved, shortName: path.basename(resolved), blobs };
    } else {
      const slug = parseGithubSlug(opts.target);
      if (!slug) {
        process.stderr.write(`Error: Target '${opts.target}' is neither an existing directory nor a valid 'owner/repo' slug.\n`);
        process.exit(EXIT_USAGE);
      }
      targetInfo = await fetchGithubTree(slug, opts.timeoutMs);
    }

    const result = scoreRepository(targetInfo.name, targetInfo.shortName, targetInfo.blobs);

    if (opts.writeAgents) {
      const dest = path.resolve(opts.writeAgents);
      if (fs.existsSync(dest) && !opts.force && !opts.dryRun) {
        process.stderr.write(`Error: ${dest} already exists. Pass --force to overwrite or --dry-run to preview.\n`);
        process.exit(EXIT_USAGE);
      }
      if (opts.dryRun) {
        process.stderr.write(`[dry-run] Would write ${Buffer.byteLength(result.starterAgents)} bytes to ${dest}\n`);
      } else {
        fs.writeFileSync(dest, result.starterAgents, "utf8");
        process.stderr.write(`Done. Wrote starter AGENTS.md to ${dest}\n`);
      }
    }

    if (opts.emitAgents) {
      process.stdout.write(result.starterAgents);
      process.exit(EXIT_OK);
    }

    if (opts.json) {
      const { starterAgents, ...compact } = result;
      process.stdout.write(JSON.stringify(compact, null, 2) + "\n");
      process.exit(EXIT_OK);
    }

    process.stdout.write(`RepoRoast: ${result.target} (${result.files_scanned} files scanned)\n`);
    process.stdout.write(`Score:     ${result.score} / ${result.max_score}\n\n`);
    for (const c of result.checks) {
      const col = `${c.points}/${c.max}`.padEnd(6, " ");
      process.stdout.write(`  [${col}] ${c.id.padEnd(20, " ")} ${c.detail}\n`);
    }
    process.stdout.write(`\nNext steps:\n`);
    process.stdout.write(`  Generate starter AGENTS.md:  npx github:jtamanas/reporoast ${opts.target} --emit-agents\n`);
    process.stdout.write(`  Deep $9 codebase audit:      https://jtamanas.github.io/reporoast/?utm_source=cli\n`);
  } catch (err) {
    process.stderr.write(`Error: ${err.message || String(err)}\n`);
    process.exit(err.code || EXIT_RUNTIME);
  }
}

main();
