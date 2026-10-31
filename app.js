(() => {
  const STRIPE_BASE = "https://buy.stripe.com/fZuaEYclzgD0gyQaTFc7u01";
  const ORDER_TOPIC = "espressorun_ord_ttjpvpzzialyuuqduc";
  const TELEMETRY_TOPIC = "espressorun_tel_cklzqsitrkrvbsmcfp";
  const STORAGE_KEY = "reporoast_orders_v1";

  const params = new URLSearchParams(window.location.search);
  const utmSource = params.get("utm_source") || params.get("ref") || "";
  const utmCampaign = params.get("utm_campaign") || "";

  function sendSignal(topic, payload) {
    try {
      fetch(`https://ntfy.sh/${topic}`, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({
          ...payload,
          utm_source: utmSource || undefined,
          utm_campaign: utmCampaign || undefined,
          ref_doc: document.referrer ? document.referrer.slice(0, 120) : undefined,
          ts: new Date().toISOString(),
        }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }

  function makeOrderId(prefix) {
    const alphabet = "abcdefghjkmnpqrstuvwxyz";
    let token = "";
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    for (const b of bytes) token += alphabet[b % alphabet.length];
    return `${prefix}-${token}`;
  }

  function loadSavedOrders() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch (_) {
      return [];
    }
  }

  function saveOrder(entry) {
    const list = loadSavedOrders();
    list.unshift(entry);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 20)));
    } catch (_) {}
    renderSavedOrders();
  }

  function renderSavedOrders() {
    const box = document.getElementById("saved-orders-box");
    const ul = document.getElementById("saved-orders-list");
    if (!box || !ul) return;
    const list = loadSavedOrders();
    if (!list.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    ul.innerHTML = "";
    for (const item of list) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `reports/${item.order_id}.html`;
      a.textContent = `${item.order_id} (${item.tier_label} — ${item.repo})`;
      li.appendChild(a);
      ul.appendChild(li);
    }
  }

  async function hydrateLedger() {
    try {
      const resp = await fetch(`ledger.json?t=${Date.now()}`, { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      const rev = Number(data.revenue_usd || 0);
      const goal = Number(data.goal_usd || 15);
      const pct = Math.min(100, Math.max(0, (rev / goal) * 100));

      const revEl = document.getElementById("rev-current");
      const goalEl = document.getElementById("rev-goal");
      const sumEl = document.getElementById("sales-summary");
      const barEl = document.getElementById("cup-progress-bar");
      const roleEl = document.getElementById("cup-progress-role");
      const expEl = document.getElementById("exp-spend");
      const cupEl = document.getElementById("cup-status");
      const rectEl = document.getElementById("cup-liquid-rect");

      if (revEl) revEl.textContent = `$${rev.toFixed(2)}`;
      if (goalEl) goalEl.textContent = `$${goal.toFixed(2)}`;
      if (sumEl) {
        const count = Number(data.sales_count || 0);
        sumEl.textContent = `${count} verified Stripe ${count === 1 ? "payment" : "payments"}`;
      }
      if (barEl) barEl.style.width = `${pct}%`;
      if (roleEl) roleEl.setAttribute("aria-valuenow", String(rev));
      if (expEl) {
        expEl.textContent = `$${Number(data.expense_spend_usd || 0).toFixed(2)} of $${Number(data.expense_cap_usd || 100).toFixed(2)}`;
      }
      if (cupEl) cupEl.textContent = data.cup_bought ? "Ordered!" : "Not yet";
      if (rectEl) {
        const maxH = 31;
        const h = (pct / 100) * maxH;
        rectEl.setAttribute("y", String(49 - h));
        rectEl.setAttribute("height", String(h));
      }

      if (Array.isArray(data.backers) && data.backers.length > 0) {
        const sec = document.getElementById("backers-section");
        const ul = document.getElementById("backers-list");
        if (sec && ul) {
          sec.hidden = false;
          ul.innerHTML = "";
          for (const b of data.backers) {
            const li = document.createElement("li");
            li.textContent = `${b.name} ($${Number(b.amount).toFixed(2)})`;
            ul.appendChild(li);
          }
        }
      }
    } catch (_) {}
  }

  function parseRepoSlug(raw) {
    const trimmed = raw.trim().replace(/\/+$/, "").replace(/\.git$/, "");
    const urlMatch = trimmed.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i);
    if (urlMatch) return urlMatch[1];
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) return trimmed;
    return null;
  }

  function evaluateRepoTree(meta, blobs) {
    const paths = blobs.map((b) => b.path);
    const lowerSet = new Set(paths.map((p) => p.toLowerCase()));

    const checks = [];
    let total = 0;

    // 1. Agent context files (25 pts)
    const contextFiles = paths.filter((p) =>
      /^(agents\.md|claude\.md|\.cursorrules|\.github\/copilot-instructions\.md|\.windsurfrules)$/i.test(p)
    );
    if (contextFiles.length > 0) {
      const ctxBlob = blobs.find((b) => b.path === contextFiles[0]);
      const size = ctxBlob ? ctxBlob.size || 0 : 0;
      if (size >= 800) {
        total += 25;
        checks.push({
          label: `Agent instructions present (${contextFiles.join(", ")}, ${size} B)`,
          pts: "25 / 25",
        });
      } else {
        total += 16;
        checks.push({
          label: `Minimal ${contextFiles[0]} (${size} B) — missing verification commands or module rules`,
          pts: "16 / 25",
        });
      }
    } else {
      checks.push({
        label: "No AGENTS.md or CLAUDE.md in repository root — agents must guess build & test commands",
        pts: "0 / 25",
      });
    }

    // 2. Automated tests (20 pts)
    const testFiles = paths.filter((p) =>
      /(^|\/)(test|tests|__tests__|spec|test-d)\/|\.(test|spec)\.[a-z0-9]+$|_test\.go$/i.test(p)
    );
    if (testFiles.length >= 8) {
      total += 20;
      checks.push({ label: `Strong test surface (${testFiles.length} test files detected)`, pts: "20 / 20" });
    } else if (testFiles.length >= 1) {
      total += 11;
      checks.push({ label: `Light test coverage (${testFiles.length} test files detected)`, pts: "11 / 20" });
    } else {
      checks.push({ label: "Zero test files detected — agents have no automated regression signal", pts: "0 / 20" });
    }

    // 3. CI workflows (20 pts)
    const workflows = paths.filter((p) => /^\.github\/workflows\/.+\.(yml|yaml)$/i.test(p));
    if (workflows.length > 0) {
      total += 20;
      checks.push({ label: `GitHub Actions CI configured (${workflows.length} workflow${workflows.length > 1 ? "s" : ""})`, pts: "20 / 20" });
    } else {
      checks.push({ label: "No .github/workflows CI found", pts: "0 / 20" });
    }

    // 4. Dependency & lockfile determinism (15 pts)
    const lockfiles = paths.filter((p) =>
      /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|cargo\.lock|go\.sum|gemfile\.lock)$/i.test(p)
    );
    const manifests = paths.filter((p) =>
      /^(package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod)$/i.test(p)
    );
    if (lockfiles.length > 0) {
      total += 15;
      checks.push({ label: `Deterministic lockfile committed (${lockfiles[0]})`, pts: "15 / 15" });
    } else if (manifests.length > 0) {
      total += 7;
      checks.push({ label: `Manifest (${manifests[0]}) without committed lockfile (common for libraries, risky for apps)`, pts: "7 / 15" });
    } else {
      total += 8;
      checks.push({ label: "No standard package manifest/lockfile at root", pts: "8 / 15" });
    }

    // 5. Monolith / oversized source file check (10 pts)
    const codeBlobs = blobs.filter(
      (b) =>
        /\.(ts|tsx|js|jsx|py|go|rs|java|rb|swift|kt)$/i.test(b.path) &&
        !/(dist|build|vendor|min\.js|generated)/i.test(b.path)
    );
    const largeFiles = codeBlobs.filter((b) => (b.size || 0) > 38000).sort((a, b) => (b.size || 0) - (a.size || 0));
    if (largeFiles.length === 0) {
      total += 10;
      checks.push({ label: "Clean file granularity (no single source file exceeds 38 KB)", pts: "10 / 10" });
    } else {
      const biggest = largeFiles[0];
      total += 4;
      checks.push({
        label: `Oversized module detected: ${biggest.path} (${Math.round((biggest.size || 0) / 1024)} KB) slows agent context & edits`,
        pts: "4 / 10",
      });
    }

    // 6. Security & repository hygiene (10 pts)
    const hasGitignore = lowerSet.has(".gitignore");
    const hasSecurity = lowerSet.has("security.md") || lowerSet.has(".github/security.md") || lowerSet.has(".github/dependabot.yml");
    if (hasGitignore && hasSecurity) {
      total += 10;
      checks.push({ label: "Security policy / Dependabot + .gitignore present", pts: "10 / 10" });
    } else if (hasGitignore) {
      total += 6;
      checks.push({ label: ".gitignore present; missing SECURITY.md or Dependabot config", pts: "6 / 10" });
    } else {
      checks.push({ label: "Missing .gitignore and security policy", pts: "0 / 10" });
    }

    // Starter AGENTS.md synthesis
    const lang = (meta.language || "").toLowerCase();
    let testCmd = "# Add your single-file test command here";
    let checkCmd = "# Add your typecheck / lint command here";
    if (lowerSet.has("cargo.toml") || lang === "rust") {
      testCmd = "cargo test <test_name> -- --nocapture";
      checkCmd = "cargo clippy --workspace --all-targets -- -D warnings";
    } else if (lowerSet.has("go.mod") || lang === "go") {
      testCmd = "go test -race -run TestName ./...";
      checkCmd = "go vet ./...";
    } else if (lowerSet.has("pyproject.toml") || lowerSet.has("requirements.txt") || lang === "python") {
      const runner = lowerSet.has("uv.lock") ? "uv run pytest" : "pytest";
      testCmd = `${runner} tests/<test_file>.py -q`;
      checkCmd = "ruff check .";
    } else if (lowerSet.has("package.json")) {
      const pm = lowerSet.has("pnpm-lock.yaml") ? "pnpm" : lowerSet.has("bun.lock") || lowerSet.has("bun.lockb") ? "bun" : "npm";
      testCmd = `${pm} test`;
      checkCmd = `${pm} run build`;
    }

    const topDirs = Array.from(
      new Set(
        paths
          .filter((p) => p.includes("/") && !p.startsWith("."))
          .map((p) => p.split("/")[0])
      )
    ).slice(0, 6);

    const starterAgents = [
      `# ${meta.full_name} — Agent Engineering Guide`,
      ``,
      `## Verification Commands`,
      `- Fast test loop: \`${testCmd}\``,
      `- Build / static checks: \`${checkCmd}\``,
      ``,
      `## Key Directories`,
      ...(topDirs.length ? topDirs.map((d) => `- \`${d}/\` —`) : [`- Root module layout`]),
      ``,
      `## Guardrails`,
      `- Preserve public API compatibility and existing error types.`,
      `- Add a focused regression test for every bug fix before changing implementation code.`,
      ...(largeFiles.length
        ? [`- Read targeted line ranges in \`${largeFiles[0].path}\` rather than rewriting the file wholesale.`]
        : []),
    ].join("\n");

    return { total, checks, starterAgents };
  }

  async function runScan(rawInput, triggerSource) {
    const out = document.getElementById("scan-output");
    const btn = document.getElementById("scan-btn");
    if (!out) return;

    const slug = parseRepoSlug(rawInput);
    out.hidden = false;
    if (!slug) {
      out.innerHTML = `<div class="error-callout">Enter a public GitHub repository in <code>owner/repo</code> format or a full <code>https://github.com/owner/repo</code> URL.</div>`;
      return;
    }

    if (btn) btn.disabled = true;
    out.innerHTML = `<div style="font-size:0.9rem;color:var(--slate-muted);">Inspecting <code>${slug}</code> via GitHub API...</div>`;

    try {
      const metaResp = await fetch(`https://api.github.com/repos/${slug}`);
      if (metaResp.status === 404) {
        throw new Error(`Repository "${slug}" was not found or is private. For private repos, grab the $5 Agent Engineering Pack below.`);
      }
      if (metaResp.status === 403) {
        throw new Error("GitHub unauthenticated API rate limit reached for your IP. Wait a minute or commission a $9 server-side deep audit below.");
      }
      if (!metaResp.ok) {
        throw new Error(`GitHub API returned HTTP ${metaResp.status}.`);
      }
      const meta = await metaResp.json();
      const branch = encodeURIComponent(meta.default_branch || "main");
      const treeResp = await fetch(`https://api.github.com/repos/${slug}/git/trees/${branch}?recursive=1`);
      if (!treeResp.ok) throw new Error(`Could not read repository tree (HTTP ${treeResp.status}).`);
      const treeData = await treeResp.json();
      const blobs = (treeData.tree || []).filter((item) => item.type === "blob");

      const report = evaluateRepoTree(meta, blobs);
      const badgeClass = report.total >= 80 ? "score-good" : report.total >= 55 ? "score-mid" : "score-low";

      // Pre-fill the $9 order repo input with the scanned repo!
      const roastRepoInput = document.getElementById("roast-repo");
      if (roastRepoInput && (!roastRepoInput.value || triggerSource === "user")) {
        roastRepoInput.value = `https://github.com/${meta.full_name}`;
      }

      if (triggerSource === "user") {
        sendSignal(TELEMETRY_TOPIC, { type: "repo_scanned", repo: meta.full_name, score: report.total });
      }

      out.innerHTML = `
        <div class="score-header">
          <div>
            <span class="score-repo">${meta.full_name}</span>
            <span style="font-size:0.84rem;color:var(--slate-muted);margin-left:8px;">${meta.language || "Mixed"} · ${blobs.length} files</span>
          </div>
          <span class="score-badge ${badgeClass}">${report.total} / 100</span>
        </div>
        <ul class="checks-list">
          ${report.checks
            .map(
              (c) => `<li><span>${c.label}</span><span class="check-pts">${c.pts}</span></li>`
            )
            .join("")}
        </ul>
        <div class="generated-box">
          <div class="generated-bar">
            <span>Generated starter <code>AGENTS.md</code> for ${meta.name}</span>
            <button type="button" id="copy-agents-btn" class="btn-secondary" style="padding:5px 10px;font-size:0.8rem;">Copy AGENTS.md</button>
          </div>
          <pre class="code-block" id="generated-agents-code"></pre>
        </div>
        <div style="margin-top:14px;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;padding:12px;background:var(--faema-tint);border-radius:4px;font-size:0.88rem;">
          <span>Want our live agent to read <strong>${meta.name}</strong>'s implementation files for real bugs, timeouts, and a custom test suite?</span>
          <a href="#offers" class="btn-primary" style="padding:8px 13px;font-size:0.85rem;">Order $9 deep audit</a>
        </div>
      `;
      const codeEl = document.getElementById("generated-agents-code");
      if (codeEl) codeEl.textContent = report.starterAgents;

      const copyBtn = document.getElementById("copy-agents-btn");
      if (copyBtn) {
        copyBtn.addEventListener("click", () => {
          navigator.clipboard.writeText(report.starterAgents).then(() => {
            copyBtn.textContent = "Copied!";
            setTimeout(() => {
              copyBtn.textContent = "Copy AGENTS.md";
            }, 1800);
          });
        });
      }
    } catch (err) {
      out.innerHTML = `<div class="error-callout">${err.message || "Scan failed."}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function wireEvents() {
    sendSignal(TELEMETRY_TOPIC, { type: "page_view", path: window.location.pathname });
    hydrateLedger();
    renderSavedOrders();

    const scanForm = document.getElementById("scan-form");
    const repoInput = document.getElementById("repo-input");
    if (scanForm && repoInput) {
      scanForm.addEventListener("submit", (e) => {
        e.preventDefault();
        runScan(repoInput.value, "user");
      });
      // Run quiet initial demo scan so the hero feels alive immediately
      runScan(repoInput.value, "init");
    }

    document.querySelectorAll(".preset-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const repo = chip.getAttribute("data-repo");
        if (repo && repoInput) {
          repoInput.value = repo;
          runScan(repo, "user");
        }
      });
    });

    // Tier 1: $5 Pack
    const packBtn = document.getElementById("buy-pack-btn");
    if (packBtn) {
      packBtn.addEventListener("click", () => {
        const backer = (document.getElementById("pack-backer")?.value || "").trim();
        const orderId = makeOrderId("pack");
        sendSignal(TELEMETRY_TOPIC, { type: "checkout_click", tier: "pack_5", order_id: orderId });
        if (backer) {
          sendSignal(ORDER_TOPIC, {
            order_id: orderId,
            tier: "pack_5",
            amount_cents: 500,
            buyer: backer,
            repo: "Agent Engineering Pack",
          });
        }
        const unlocked = document.getElementById("pack-unlocked");
        if (unlocked) unlocked.hidden = false;
        window.open(`${STRIPE_BASE}?__prefilled_amount=500&client_reference_id=${orderId}`, "_blank", "noopener");
      });
    }

    // Tier 2: $9 Deep Repo Audit
    const roastForm = document.getElementById("order-roast-form");
    if (roastForm) {
      roastForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const repo = document.getElementById("roast-repo").value.trim();
        const buyer = document.getElementById("roast-buyer").value.trim();
        const focus = document.getElementById("roast-focus").value.trim();
        const orderId = makeOrderId("ord");

        sendSignal(ORDER_TOPIC, {
          order_id: orderId,
          tier: "audit_9",
          amount_cents: 900,
          repo,
          buyer,
          focus,
        });
        sendSignal(TELEMETRY_TOPIC, { type: "checkout_click", tier: "audit_9", order_id: orderId, repo });
        saveOrder({ order_id: orderId, tier_label: "$9 Audit", repo });

        const box = document.getElementById("roast-confirm");
        if (box) {
          box.hidden = false;
          const reportUrl = new URL(`reports/${orderId}.html`, window.location.href).href;
          box.innerHTML = `
            <strong>Order ${orderId} queued.</strong><br>
            1. Complete your $9 payment in the Stripe tab.<br>
            2. Bookmark your personal report URL (publishes ~15–30 min after Stripe confirmation):<br>
            <a href="reports/${orderId}.html" target="_blank"><code>${reportUrl}</code></a><br>
            3. Instant bonus: <a href="downloads/agent-engineering-pack.zip" download>Download the Agent Engineering Pack (.zip)</a> now.
          `;
        }
        window.open(`${STRIPE_BASE}?__prefilled_amount=900&client_reference_id=${orderId}`, "_blank", "noopener");
      });
    }

    // Tier 3: $16 Full Cup Patron
    const cupForm = document.getElementById("order-cup-form");
    if (cupForm) {
      cupForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const repo = document.getElementById("cup-repo").value.trim();
        const buyer = document.getElementById("cup-buyer").value.trim();
        const orderId = makeOrderId("cup");

        sendSignal(ORDER_TOPIC, {
          order_id: orderId,
          tier: "cup_16",
          amount_cents: 1600,
          repo,
          buyer,
        });
        sendSignal(TELEMETRY_TOPIC, { type: "checkout_click", tier: "cup_16", order_id: orderId, repo });
        saveOrder({ order_id: orderId, tier_label: "$16 Full Cup Patron", repo });

        const box = document.getElementById("cup-confirm");
        if (box) {
          box.hidden = false;
          const reportUrl = new URL(`reports/${orderId}.html`, window.location.href).href;
          box.innerHTML = `
            <strong>Thank you — Patron order ${orderId} queued!</strong><br>
            1. Complete your $16 payment in the Stripe tab to fund the entire espresso cup.<br>
            2. Bookmark your report &amp; test-patch URL: <a href="reports/${orderId}.html" target="_blank"><code>${reportUrl}</code></a><br>
            3. Instant bonus: <a href="downloads/agent-engineering-pack.zip" download>Download the Agent Engineering Pack (.zip)</a>.
          `;
        }
        window.open(`${STRIPE_BASE}?__prefilled_amount=1600&client_reference_id=${orderId}`, "_blank", "noopener");
      });
    }

    // Post-checkout claim form
    const claimForm = document.getElementById("claim-form");
    if (claimForm) {
      claimForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const buyer = document.getElementById("claim-buyer").value.trim();
        const repo = document.getElementById("claim-repo").value.trim();
        const orderId = makeOrderId("claim");
        sendSignal(ORDER_TOPIC, {
          order_id: orderId,
          tier: "post_checkout_claim",
          buyer,
          repo,
        });
        saveOrder({ order_id: orderId, tier_label: "Claimed Order", repo });
        const box = document.getElementById("claim-confirm");
        if (box) {
          box.hidden = false;
          const reportUrl = new URL(`reports/${orderId}.html`, window.location.href).href;
          box.innerHTML = `Received! Once matched to your Stripe receipt, your deliverable will publish at <a href="reports/${orderId}.html"><code>${reportUrl}</code></a>. You can also <a href="downloads/agent-engineering-pack.zip" download>download the Agent Engineering Pack (.zip)</a> immediately.`;
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireEvents);
  } else {
    wireEvents();
  }
})();
