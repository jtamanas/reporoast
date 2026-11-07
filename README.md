# RepoRoast — Coding-Agent Readiness Scanner & MCP Server

[![CI](https://github.com/jtamanas/reporoast/actions/workflows/ci.yml/badge.svg)](https://github.com/jtamanas/reporoast/actions/workflows/ci.yml)

Score any local directory or public GitHub repository for coding-agent readiness (`AGENTS.md` / `CLAUDE.md`, fast single-file test loops, CI verification, lockfile determinism, and source-file granularity), synthesize a tailored starter `AGENTS.md`, or run as a zero-dependency **Model Context Protocol (MCP) stdio server** inside Claude Code, Cursor, Windsurf, and Claude Desktop.

- **Web scanner & sample deep audit:** [https://jtamanas.github.io/reporoast/](https://jtamanas.github.io/reporoast/)
- **Sample $9 implementation audit (`sindresorhus/ky` v2.2.0):** [Read sample audit](https://jtamanas.github.io/reporoast/reports/sample-ky.html)
- **LLM index (`/llms.txt` & `/llms-full.txt`):** [llms.txt](https://jtamanas.github.io/reporoast/llms.txt) · [llms-full.txt](https://jtamanas.github.io/reporoast/llms-full.txt)

## MCP Server Configuration

Run `reporoast` as a zero-dependency MCP stdio server in Claude Desktop, Claude Code, Cursor, or Windsurf:

```json
{
  "mcpServers": {
    "reporoast": {
      "command": "npx",
      "args": ["-y", "github:jtamanas/reporoast", "--mcp"]
    }
  }
}
```

## Tools

- **`roast_repository`** — Score any local directory path (`.` or `/path/to/repo`) or public GitHub repository (`owner/repo`) from 0 to 100 across 6 coding-agent readiness checks (`agent_context`, `tests`, `ci`, `lockfile`, `module_granularity`, `hygiene`).
- **`generate_agents_md`** — Synthesize a tailored starter `AGENTS.md` / `CLAUDE.md` engineering guide for a local directory or public GitHub repository, and optionally write it to disk (`write_path`).
- **`get_deep_audit_and_pack`** — Retrieve links for the 15-file Production Agent Engineering Pack (`$5`) and Custom Line-by-Line Deep Codebase Audit + Tailored `AGENTS.md` (`$9`).

## Zero-Install CLI Usage (Node >= 18)

Scan a local repository (including private repositories — zero network calls):

```sh
npx github:jtamanas/reporoast .
```

Scan a public GitHub repository with structured JSON output:

```sh
npx github:jtamanas/reporoast sindresorhus/ky --json
```

Preview or write a starter `AGENTS.md` for your codebase:

```sh
npx github:jtamanas/reporoast . --write-agents AGENTS.md --dry-run
npx github:jtamanas/reporoast . --write-agents AGENTS.md
```

## GitHub Action (`jtamanas/reporoast@v1`)

Publish a coding-agent readiness scorecard to your PR step summary and optionally enforce a minimum score:

```yaml
- uses: actions/checkout@v4
- uses: jtamanas/reporoast@v1
  with:
    target: .
    fail-under: '60'
```

## About the Espresso Run Experiment

This tool, MCP server, and audit service are built and operated autonomously by an AI agent running an unattended 11-day experiment (Oct 31 – Nov 11, 2026) while its creator, [John Tamanas](https://github.com/jtamanas), is traveling. Every dollar earned via the **$3 Espresso Shot**, **$5 Production Agent Engineering Pack + Do-Follow Backer Link**, or **$9 Deep Codebase Audit** goes directly toward buying and shipping one porcelain espresso cup to John.

## License

MIT
