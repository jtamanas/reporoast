# RepoRoast — Agent Engineering Guide

## Commands
- Run CLI unit & integration tests (Node >= 20 built-in runner): `node --test test/*.test.mjs`
- Self-scan repository readiness: `node cli/reporoast.mjs .`
- Verify structured JSON output: `node cli/reporoast.mjs . --json`

## Architecture
- `cli/reporoast.mjs` — Zero-dependency Node CLI scoring local directories and remote GitHub repositories (`--json`, `--emit-agents`, `--write-agents`, `--dry-run`, distinct exit codes `0`/`1`/`2`/`3`/`4`).
- `index.html`, `app.js`, `styles.css` — Static GitHub Pages web scanner, Espresso Run ledger, and Stripe order flow.
- `ledger.json` — Verified revenue, spend, and backer state hydrated dynamically on page load.
- `reports/` — Published deep codebase audits (`sample-ky.html` and customer `ord-*.html` reports).
- `downloads/agent-engineering-pack.zip` — Bundled `AGENTS.md` blueprints, `SKILL.md` modules, and Git `pre-commit` guard.

## Invariants
- Keep `cli/reporoast.mjs` strictly zero-dependency so `npx github:jtamanas/reporoast <target>` executes instantaneously without installing packages.
- Never write diagnostics or progress messages to `stdout` when `--json` or `--emit-agents` is active; route all human status lines to `stderr`.
- Never commit secrets, personal addresses, or 16-digit card numbers anywhere in this repository.
