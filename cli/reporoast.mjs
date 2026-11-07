#!/usr/bin/env node
/**
 * reporoast — Score any local directory or public GitHub repository for coding-agent readiness.
 * Zero external dependencies (Node >= 18).
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_FOUND = 3;
const EXIT_AUTH_OR_LIMIT = 4;

const HELP = `Usage:
  reporoast <target> [options]
  reporoast --mcp

Targets:
  . | /path/to/repo              Scan a local repository directory (works on private repos)
  owner/repo                     Scan a public GitHub repository via REST API
  https://github.com/owner/repo  Scan a public GitHub repository URL

Options:
  --mcp                  Run as a Model Context Protocol (MCP) stdio server for Claude Code, Cursor & Windsurf
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
  npx github:jtamanas/reporoast --mcp
`;

function parseArgs(argv) {
  const opts = {
    target: null,
    mcp: path.basename(process.argv[1] || "").includes("mcp"),
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
    } else if (arg === "--mcp") {
      opts.mcp = true;
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

async function resolveTargetInfo(target, timeoutMs) {
  if (target === "." || target.startsWith("./") || target.startsWith("/") || fs.existsSync(target)) {
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw Object.assign(new Error(`Local directory not found: ${resolved}`), { code: EXIT_NOT_FOUND });
    }
    const blobs = walkLocalDir(resolved);
    return { name: resolved, shortName: path.basename(resolved), blobs };
  }
  const slug = parseGithubSlug(target);
  if (!slug) {
    throw Object.assign(
      new Error(`Target '${target}' is neither an existing directory nor a valid 'owner/repo' slug.`),
      { code: EXIT_USAGE }
    );
  }
  return await fetchGithubTree(slug, timeoutMs);
}

const MCP_TOOLS = [
  {
    name: "roast_repository",
    description:
      "Score any local directory path or public GitHub repository (owner/repo) from 0 to 100 for AI coding-agent readiness (AGENTS.md/CLAUDE.md, test loops, CI workflows, lockfile determinism, module granularity, and security hygiene).",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Local directory path (e.g. '.') or public GitHub repository ('owner/repo' or full GitHub URL).",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "generate_agents_md",
    description:
      "Synthesize a tailored starter AGENTS.md / CLAUDE.md engineering guide for any local repository directory or public GitHub repository (owner/repo).",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Local directory path (e.g. '.') or public GitHub repository ('owner/repo').",
        },
        write_path: {
          type: "string",
          description: "Optional local file path to write the generated AGENTS.md to.",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "get_deep_audit_and_pack",
    description:
      "Get details and links for the 15-file Production Agent Engineering Pack ($5) and Custom Line-by-Line Deep Codebase Audit + Tailored AGENTS.md ($9) from the live Espresso Run autonomous agent experiment.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Optional repository slug or URL to include in the audit request.",
        },
      },
    },
  },
];

function runMcpServer(timeoutMs) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (_) {
      return;
    }
    if (msg.id === undefined || msg.id === null) return;

    try {
      if (msg.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "reporoast", version: "1.2.0" },
          },
        });
      } else if (msg.method === "ping") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "tools/list") {
        send({ jsonrpc: "2.0", id: msg.id, result: { tools: MCP_TOOLS } });
      } else if (msg.method === "tools/call") {
        const name = msg.params?.name;
        const args = msg.params?.arguments || {};
        if (name === "roast_repository") {
          const info = await resolveTargetInfo(String(args.target || "."), timeoutMs);
          const result = scoreRepository(info.name, info.shortName, info.blobs);
          const { starterAgents, ...compact } = result;
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(compact, null, 2) }],
            },
          });
        } else if (name === "generate_agents_md") {
          const info = await resolveTargetInfo(String(args.target || "."), timeoutMs);
          const result = scoreRepository(info.name, info.shortName, info.blobs);
          let note = "";
          if (args.write_path) {
            const dest = path.resolve(String(args.write_path));
            fs.writeFileSync(dest, result.starterAgents, "utf8");
            note = `\n\n<!-- Wrote starter AGENTS.md to ${dest} -->`;
          }
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: result.starterAgents + note }],
            },
          });
        } else if (name === "get_deep_audit_and_pack") {
          const repoNote = args.repo ? ` for ${args.repo}` : "";
          const text = [
            `# RepoRoast — Production Agent Engineering Pack & Custom Deep Audit${repoNote}`,
            ``,
            `- **Web Scanner & Instant Download:** https://jtamanas.github.io/reporoast/?utm_source=mcp`,
            `- **Sample $9 Deep Audit (sindresorhus/ky v2.2.0):** https://jtamanas.github.io/reporoast/reports/sample-ky.html`,
            `- **1-Click Stripe Checkout ($3 Shot / $5 Pack+Backer Link / $9 Repo Audit / $15 Full Cup):** https://buy.stripe.com/bfZu5kF9H25r7cC8gIcbsc00`,
            ``,
            `Operated autonomously by an AI agent running the 11-day Espresso Run challenge (Oct 31 – Nov 11, 2026) to earn enough verified revenue to buy and ship one porcelain espresso cup for John Tamanas.`,
          ].join("\n");
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text }] },
          });
        } else {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `Unknown tool: ${name}` },
          });
        }
      } else {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
      }
    } catch (err) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Error: ${err.message || String(err)}` }],
        },
      });
    }
  });
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

  if (opts.mcp) {
    runMcpServer(opts.timeoutMs);
    return;
  }

  if (!opts.target) {
    process.stderr.write("Error: Missing <target>. Pass '.' for current directory, 'owner/repo', or '--mcp'. Run 'reporoast --help'.\n");
    process.exit(EXIT_USAGE);
  }

  try {
    const targetInfo = await resolveTargetInfo(opts.target, opts.timeoutMs);
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
