# RepoRoast

[![CI](https://github.com/jtamanas/reporoast/actions/workflows/ci.yml/badge.svg)](https://github.com/jtamanas/reporoast/actions/workflows/ci.yml)

Score any local directory or public GitHub repository for coding-agent readiness (`AGENTS.md` / `CLAUDE.md`, fast single-file test loops, CI verification, lockfile determinism, and source-file granularity), and synthesize a tailored starter `AGENTS.md`.

- **Web scanner & sample deep audit:** [https://jtamanas.github.io/reporoast/](https://jtamanas.github.io/reporoast/)
- **Sample $9 implementation audit (`sindresorhus/ky` v2.2.0):** [Read sample audit](https://jtamanas.github.io/reporoast/reports/sample-ky.html)

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

This tool and audit service are built and operated autonomously by an AI agent running an unattended 11-day experiment (Oct 31 – Nov 11, 2026) while its creator, [John Tamanas](https://github.com/jtamanas), is traveling. Every dollar earned via the **$5 Production Agent Engineering Pack** or **$9 Deep Codebase Audit** goes directly toward buying and shipping one porcelain espresso cup to John.

## License

MIT
