const view = document.querySelector("#view");
const pageTitle = document.querySelector("#page-title");
const sectionKicker = document.querySelector("#section-kicker");
const runDialog = document.querySelector("#run-dialog");
const runFormContent = document.querySelector("#run-form-content");
const runForm = document.querySelector("#run-form");
const detailDialog = document.querySelector("#detail-dialog");
const detailContent = document.querySelector("#detail-content");
const toastRegion = document.querySelector("#toast-region");

let state = null;
let refreshInFlight = false;
const activeStatuses = new Set(["queued", "authorizing", "adapting", "running", "analyzing"]);

const html = String.raw;

function escape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message || `Request failed (${response.status})`);
    error.code = payload.error?.code;
    throw error;
  }
  return payload;
}

function route() {
  const [section = "overview", id] = location.hash.replace(/^#/, "").split("/");
  return { section: section || "overview", id };
}

function status(value) {
  return `<span class="status ${escape(value)}">${escape(value)}</span>`;
}

function relativeTime(value) {
  if (!value) return "—";
  const delta = Date.now() - new Date(value).getTime();
  const seconds = Math.max(0, Math.floor(delta / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function duration(milliseconds) {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function scenario(id) {
  return state.scenarios.find((candidate) => candidate.id === id);
}

function project(id) {
  return state.projects.find((candidate) => candidate.id === id);
}

function target(id) {
  return state.targets.find((candidate) => candidate.id === id);
}

function updateShell() {
  const current = route().section;
  document.querySelectorAll("[data-nav]").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === current);
  });

  const openFindings = state.findings.filter((finding) => finding.status === "open").length;
  const activeRuns = state.runs.filter((run) => activeStatuses.has(run.status)).length;
  document.querySelector("#finding-count").textContent = openFindings;
  document.querySelector("#active-run-count").textContent = activeRuns;
}

function setHeading(title, kicker) {
  pageTitle.textContent = title;
  sectionKicker.textContent = kicker;
}

function runRows(runs, limit) {
  const selected = typeof limit === "number" ? runs.slice(0, limit) : runs;
  if (selected.length === 0) {
    return `<tr><td colspan="6">No runs yet.</td></tr>`;
  }

  return selected
    .map((run) => {
      const runTarget = target(run.targetId);
      const findings = run.findingIds?.length || 0;
      return html`
        <tr data-action="view-run" data-run-id="${escape(run.id)}">
          <td><span class="cell-main">${escape(run.id)}</span><span class="cell-sub">${escape(run.trigger)} trigger</span></td>
          <td><span class="cell-main">${escape(runTarget?.name || "Unknown")}</span><span class="cell-sub">${escape(runTarget?.environment)}</span></td>
          <td>${status(run.status)}</td>
          <td><span class="cell-main">${escape(run.profile)}</span><span class="cell-sub">${escape(run.coverage?.total || 0)} scenarios</span></td>
          <td><span class="cell-main">${findings}</span><span class="cell-sub">${findings === 1 ? "finding" : "findings"}</span></td>
          <td><span class="cell-main">${relativeTime(run.createdAt)}</span><span class="cell-sub">${duration(run.durationMs)}</span></td>
        </tr>
      `;
    })
    .join("");
}

function findingRows(findings, limit) {
  const selected = typeof limit === "number" ? findings.slice(0, limit) : findings;
  if (selected.length === 0) return `<div class="empty-state"><p>No findings need attention.</p></div>`;

  return selected
    .map(
      (finding) => html`
        <article class="finding-row" data-action="view-finding" data-finding-id="${escape(finding.id)}">
          <span class="severity-icon ${escape(finding.severity)}">!</span>
          <div>
            <h3>${escape(finding.title)}</h3>
            <p>${escape(finding.summary)}</p>
          </div>
          <span class="confidence">${Math.round(finding.confidence * 100)}%</span>
        </article>
      `
    )
    .join("");
}

function renderOverview() {
  setHeading("Canary overview", "Workspace");
  const completedRuns = state.runs.filter((run) => run.status === "completed");
  const latest = completedRuns[0];
  const openFindings = state.findings.filter((finding) => finding.status === "open");
  const verifiedTargets = state.targets.filter((item) => item.proof.status === "verified").length;
  const resultCount = latest
    ? latest.coverage.passed + latest.coverage.failed
    : 0;
  const passRate = resultCount
    ? Math.round((latest.coverage.passed / resultCount) * 100)
    : 0;

  view.innerHTML = html`
    <div class="hero-grid">
      <section class="hero-card">
        <span class="eyebrow">Feather Shop · ${escape(project("prj_feather")?.repository.revision)}</span>
        <h2>Your product has a bird watching the edges.</h2>
        <p>
          Yellow Bird combines generated checks, agent-guided flows, and bounded exploration.
          This stub runs the entire orchestration path while keeping real code, targets, models,
          and third-party tools disconnected.
        </p>
        <div class="hero-facts">
          <span class="fact"><span>✓</span> Expected results stay immutable</span>
          <span class="fact"><span>✓</span> ${verifiedTargets}/${state.targets.length} targets authorized</span>
          <span class="fact"><span>✓</span> Best-effort gaps reported</span>
        </div>
      </section>
      <aside class="score-card">
        <span class="eyebrow">Current posture</span>
        <h3>Honest simulation</h3>
        <p>The domain and policy flow are functional. Infrastructure boundaries remain explicit stubs.</p>
        <div class="posture-list">
          <div class="posture-item"><span></span><strong>Run grants</strong><small>Signed locally</small></div>
          <div class="posture-item"><span></span><strong>Policy engine</strong><small>Enforced</small></div>
          <div class="posture-item stub"><span></span><strong>Runner isolation</strong><small>Simulated</small></div>
          <div class="posture-item stub"><span></span><strong>Agent engine</strong><small>Kimi/open-model stub</small></div>
          <div class="posture-item stub"><span></span><strong>Target requests</strong><small>Disabled</small></div>
        </div>
      </aside>
    </div>

    <div class="metric-grid">
      <article class="metric-card">
        <span>Open findings</span><strong>${openFindings.length}</strong>
        <small>${openFindings.filter((item) => item.severity === "high").length} high severity</small>
      </article>
      <article class="metric-card">
        <span>Latest pass rate</span><strong>${passRate}%</strong>
        <small>Skipped scenarios excluded</small>
      </article>
      <article class="metric-card">
        <span>Test intents</span><strong>${state.scenarios.length}</strong>
        <small>Across 3 execution modes</small>
      </article>
      <article class="metric-card">
        <span>Repairs accepted</span><strong>${latest?.scenarioResults.filter((result) => result.healed).length || 0}</strong>
        <small>No expected results changed</small>
      </article>
    </div>

    <div class="content-grid">
      <section class="panel">
        <div class="panel-header">
          <div><h2>Recent canary runs</h2><p>Policy-scoped execution across registered targets</p></div>
          <a class="panel-link" href="#runs">View all →</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Run</th><th>Target</th><th>Status</th><th>Profile</th><th>Findings</th><th>Started</th></tr></thead>
            <tbody>${runRows(state.runs, 5)}</tbody>
          </table>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div><h2>Needs attention</h2><p>Evidence-backed, reproducible findings</p></div>
          <a class="panel-link" href="#findings">Triage →</a>
        </div>
        <div class="finding-stack">${findingRows(openFindings, 3)}</div>
      </section>
    </div>
  `;
}

function renderRuns() {
  setHeading("Canary runs", "Execution");
  const active = state.runs.filter((run) => activeStatuses.has(run.status)).length;
  view.innerHTML = html`
    <div class="page-intro">
      <div>
        <h2>Run history</h2>
        <p>Every run carries a target-bound grant, resolved policy digest, capability set, and explicit coverage result.</p>
      </div>
      <span class="status ${active ? "running" : "completed"}">${active ? `${active} active` : "All settled"}</span>
    </div>
    <section class="panel">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Run</th><th>Target</th><th>Status</th><th>Profile</th><th>Findings</th><th>Started</th></tr></thead>
          <tbody>${runRows(state.runs)}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderFindings() {
  setHeading("Findings", "Triage");
  const severityOrder = { high: 0, medium: 1, low: 2 };
  const findings = [...state.findings].sort(
    (left, right) => severityOrder[left.severity] - severityOrder[right.severity]
  );
  view.innerHTML = html`
    <div class="page-intro">
      <div>
        <h2>What the bird found</h2>
        <p>Confidence describes evidence strength, not impact. Open a finding to inspect the recorded proof and minimal reproduction procedure.</p>
      </div>
    </div>
    <div class="card-grid">
      ${findings
        .map(
          (finding) => html`
            <article class="item-card" data-action="view-finding" data-finding-id="${escape(finding.id)}">
              <div class="item-card-header">
                <div>
                  <span class="eyebrow">${escape(finding.severity)} severity</span>
                  <h3>${escape(finding.title)}</h3>
                </div>
                ${status(finding.status)}
              </div>
              <p>${escape(finding.summary)}</p>
              <div class="meta-row">
                <span>Confidence ${Math.round(finding.confidence * 100)}%</span>
                <span>${finding.evidence.length} evidence items</span>
                <span>${finding.reproduction.length} reproduction steps</span>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderTests() {
  setHeading("Test library", "Product intent");
  view.innerHTML = html`
    <div class="page-intro">
      <div>
        <h2>Intent first, execution second</h2>
        <p>
          Every scenario has an owner-controlled intent and expected invariant. Individual steps can be scripted,
          agent-executed, or exploratory without allowing a repair to rewrite what “correct” means.
        </p>
      </div>
    </div>
    <div class="card-grid">
      ${state.scenarios
        .map(
          (item) => html`
            <article class="item-card">
              <div class="item-card-header">
                <div>
                  <span class="eyebrow">${escape(item.category)}</span>
                  <h3>${escape(item.title)}</h3>
                </div>
                ${status(item.mode)}
              </div>
              <p>${escape(item.intent)}</p>
              <div class="meta-row">
                <span class="tag">${item.steps.length} instructions</span>
                <span class="tag">${item.steps.filter((step) => step.executor === "agent").length} agentic</span>
                <span class="tag">${item.requiredCapabilities.length} capabilities</span>
              </div>
              <div class="meta-row">
                <span>Expected</span>
                <code>${escape(item.expected.invariant)}</code>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderTargets() {
  setHeading("Targets", "Authorization");
  view.innerHTML = html`
    <div class="page-intro">
      <div>
        <h2>Registered test surfaces</h2>
        <p>A repository connection authorizes source access, not a deployment. Active testing requires target-specific proof appropriate to the environment.</p>
      </div>
    </div>
    <div class="card-grid">
      ${state.targets
        .map(
          (item) => html`
            <article class="item-card">
              <div class="item-card-header">
                <div>
                  <span class="eyebrow">${escape(item.environment)}</span>
                  <h3>${escape(item.name)}</h3>
                </div>
                ${status(item.proof.status)}
              </div>
              <p class="target-url">${escape(item.url)}</p>
              <div class="meta-row">
                <span>Method: ${escape(item.proof.method)}</span>
                <span>Assurance: ${escape(item.proof.assurance || "none")}</span>
                <span>${item.proof.verifiedAt ? `Verified ${relativeTime(item.proof.verifiedAt)}` : "Awaiting proof"}</span>
              </div>
              ${
                item.proof.status !== "verified"
                  ? `<div class="inline-actions"><button class="primary-button" data-action="verify-target" data-target-id="${escape(item.id)}">Simulate HTTP proof</button></div>`
                  : ""
              }
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderPolicy() {
  setHeading("Policy", "Governance");
  const policy = state.policies[0];
  view.innerHTML = html`
    <div class="page-intro">
      <div>
        <h2>${escape(policy.name)}</h2>
        <p>Repository intent can request access; this organization policy may narrow it. The agent is always the least-authoritative layer.</p>
      </div>
      <span class="tag">Revision ${policy.revision}</span>
    </div>
    <div class="policy-layout">
      <section class="panel">
        <div class="policy-section">
          <h3>Capability catalog</h3>
          <p>Allowed capabilities can still be missing from a target or omitted from an individual Run Grant.</p>
          <div class="capability-list">
            ${state.capabilities
              .map((capability) => {
                const allowed = policy.allowedCapabilities.includes(capability.id);
                return html`
                  <div class="capability-row">
                    <div>
                      <strong>${escape(capability.label)}</strong>
                      <small>${escape(capability.description)}</small>
                    </div>
                    ${allowed ? status("verified") : status("open")}
                  </div>
                `;
              })
              .join("")}
          </div>
        </div>
        <div class="policy-section">
          <h3>Run limits</h3>
          <div class="meta-row">
            <span class="tag">${policy.maxRunSeconds}s wall time</span>
            <span class="tag">${policy.maxRequests} requests</span>
            <span class="tag">${policy.evidenceRetentionDays}d evidence retention</span>
            <span class="tag">Production approval required</span>
          </div>
        </div>
      </section>
      <aside class="panel">
        <div class="panel-header"><div><h2>Recent policy events</h2><p>Immutable narrative</p></div></div>
        <div class="audit-list">
          ${state.auditEvents
            .slice(0, 8)
            .map(
              (event) => html`
                <article class="audit-event">
                  <h3>${escape(event.type)}</h3>
                  <p>${escape(event.message)}</p>
                  <time>${relativeTime(event.createdAt)}</time>
                </article>
              `
            )
            .join("")}
        </div>
      </aside>
    </div>
  `;
}

function render() {
  if (!state) return;
  updateShell();
  const current = route();
  if (current.section === "runs") renderRuns();
  else if (current.section === "findings") renderFindings();
  else if (current.section === "tests") renderTests();
  else if (current.section === "targets") renderTargets();
  else if (current.section === "policy") renderPolicy();
  else renderOverview();

  if (current.section === "runs" && current.id) openRun(current.id);
}

function openRunForm() {
  const policy = state.policies[0];
  const defaultCapabilities = new Set(policy.allowedCapabilities);
  runFormContent.innerHTML = html`
    <div class="form-grid">
      <div class="field">
        <label for="project">Project</label>
        <select id="project" name="projectId">
          ${state.projects.map((item) => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="target">Authorized target</label>
        <select id="target" name="targetId">
          ${state.targets
            .map(
              (item) =>
                `<option value="${escape(item.id)}" ${item.proof.status !== "verified" ? "disabled" : ""}>${escape(item.name)} · ${escape(item.proof.status)}</option>`
            )
            .join("")}
        </select>
      </div>
    </div>
    <fieldset class="field">
      <legend>Run profile</legend>
      <div class="profile-options">
        <label class="profile-option">
          <input type="radio" name="profile" value="balanced" checked />
          <span><strong>Balanced</strong><small>Scripted, hybrid, and bounded exploratory scenarios.</small></span>
        </label>
        <label class="profile-option">
          <input type="radio" name="profile" value="deterministic" />
          <span><strong>Deterministic</strong><small>Generated and maintained scripted scenarios only.</small></span>
        </label>
        <label class="profile-option">
          <input type="radio" name="profile" value="exploratory" />
          <span><strong>Exploratory</strong><small>Hybrid flows and creative boundary exploration.</small></span>
        </label>
      </div>
    </fieldset>
    <div class="field">
      <label for="network">Network profile</label>
      <select id="network" name="networkProfile">
        ${policy.networkProfiles
          .map(
            (item) =>
              `<option value="${escape(item)}" ${item === "target-and-declared-tools" ? "selected" : ""}>${escape(item)}</option>`
          )
          .join("")}
      </select>
    </div>
    <fieldset class="field">
      <legend>Requested capabilities</legend>
      <div class="capability-options">
        ${state.capabilities
          .map(
            (capability) => html`
              <label class="check-option">
                <input
                  type="checkbox"
                  name="capabilities"
                  value="${escape(capability.id)}"
                  ${defaultCapabilities.has(capability.id) ? "checked" : ""}
                />
                <span>
                  <strong>${escape(capability.label)}</strong>
                  <small>${escape(capability.risk)} risk</small>
                </span>
              </label>
            `
          )
          .join("")}
      </div>
    </fieldset>
  `;
  runDialog.showModal();
}

async function submitRun(event) {
  event.preventDefault();
  const form = new FormData(runForm);
  const submit = runForm.querySelector('[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Authorizing…";
  try {
    const payload = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        projectId: form.get("projectId"),
        targetId: form.get("targetId"),
        profile: form.get("profile"),
        trigger: "manual",
        networkProfile: form.get("networkProfile"),
        requestedCapabilities: form.getAll("capabilities")
      })
    });
    runDialog.close();
    await refresh(false);
    location.hash = `runs/${payload.run.id}`;
    toast(`Run ${payload.run.id} authorized with ${payload.run.grantedCapabilities.length} capabilities.`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    submit.disabled = false;
    submit.innerHTML = "Authorize &amp; run <span>→</span>";
  }
}

function scenarioResultRows(run) {
  if (run.scenarioResults.length === 0) {
    return `<p class="cell-sub">Scenarios will appear as the runner reaches execution.</p>`;
  }
  return run.scenarioResults
    .map((result) => {
      const item = scenario(result.scenarioId);
      return html`
        <div class="scenario-result">
          ${status(result.status)}
          <div>
            <h3>${escape(item?.title || result.scenarioId)} ${result.healed ? '<span class="tag">repaired</span>' : ""}</h3>
            <p>${escape(result.observation)}</p>
          </div>
          <small>${duration(result.durationMs)}</small>
        </div>
      `;
    })
    .join("");
}

function openRun(id) {
  const run = state.runs.find((candidate) => candidate.id === id);
  if (!run) return;
  const runTarget = target(run.targetId);
  const canCancel = activeStatuses.has(run.status);
  detailContent.innerHTML = html`
    <div class="modal-header">
      <div>
        <span class="eyebrow">${escape(run.trigger)} · ${escape(run.profile)}</span>
        <h2>${escape(run.id)}</h2>
        <p>${escape(run.stage)} on ${escape(runTarget?.name)}. Grant ${escape(run.grant.tokenPreview)}.</p>
      </div>
      <button class="close-button" data-action="close-detail" aria-label="Close">×</button>
    </div>
    <div class="detail-body">
      <div class="detail-hero">
        <div>
          ${status(run.status)}
          <progress class="progress-shell" max="100" value="${run.progress}">${run.progress}%</progress>
          <p>${escape(run.stage)} · ${run.progress}% complete</p>
        </div>
        ${
          canCancel
            ? `<button class="secondary-button" data-action="cancel-run" data-run-id="${escape(run.id)}">Cancel run</button>`
            : ""
        }
      </div>
      <div class="run-summary-grid">
        <div><span>Passed</span><strong>${run.coverage.passed}</strong></div>
        <div><span>Failed</span><strong>${run.coverage.failed}</strong></div>
        <div><span>Skipped</span><strong>${run.coverage.skipped}</strong></div>
        <div><span>Findings</span><strong>${run.findingIds.length}</strong></div>
      </div>
      <div class="item-card">
        <div class="item-card-header">
          <div><span class="eyebrow">Execution record</span><h3>Scenario results</h3></div>
          <span class="tag">${run.grantedCapabilities.length} granted capabilities</span>
        </div>
        ${scenarioResultRows(run)}
      </div>
      ${
        run.coverageGaps.length
          ? html`
              <div class="item-card">
                <span class="eyebrow">Best-effort gaps</span>
                <h3>Not tested under this grant</h3>
                <div class="meta-row">
                  ${run.coverageGaps.map((gap) => `<span class="tag">${escape(gap.capability)}</span>`).join("")}
                </div>
              </div>
            `
          : ""
      }
    </div>
  `;
  if (!detailDialog.open) detailDialog.showModal();
}

function openFinding(id) {
  const finding = state.findings.find((candidate) => candidate.id === id);
  if (!finding) return;
  detailContent.innerHTML = html`
    <div class="modal-header">
      <div>
        <span class="eyebrow">${escape(finding.severity)} severity · ${Math.round(finding.confidence * 100)}% confidence</span>
        <h2>${escape(finding.title)}</h2>
        <p>${escape(finding.summary)}</p>
      </div>
      <button class="close-button" data-action="close-detail" aria-label="Close">×</button>
    </div>
    <div class="detail-body">
      <div class="detail-hero">
        <div>${status(finding.status)}</div>
        <div class="inline-actions">
          ${
            finding.status === "open"
              ? `<button class="secondary-button" data-action="update-finding" data-finding-id="${escape(finding.id)}" data-status="acknowledged">Acknowledge</button>`
              : ""
          }
          <button class="primary-button" data-action="update-finding" data-finding-id="${escape(finding.id)}" data-status="resolved">Mark resolved</button>
        </div>
      </div>
      <div class="evidence-grid">
        <section>
          <span class="eyebrow">Evidence</span>
          <h3>What Yellow Bird observed</h3>
          <ul class="evidence-list">
            ${finding.evidence
              .map(
                (item) =>
                  `<li><strong>${escape(item.label)}</strong>${escape(item.detail)} <span class="tag">${escape(item.kind)}</span></li>`
              )
              .join("")}
          </ul>
        </section>
        <section>
          <span class="eyebrow">Reproduction</span>
          <h3>Minimal procedure</h3>
          <ol class="repro-list">
            ${finding.reproduction.map((step) => `<li>${escape(step)}</li>`).join("")}
          </ol>
        </section>
      </div>
    </div>
  `;
  if (!detailDialog.open) detailDialog.showModal();
}

function showDoctor() {
  detailContent.innerHTML = html`
    <div class="modal-header">
      <div>
        <span class="eyebrow">Implementation boundary</span>
        <h2>What this stub can honestly claim</h2>
        <p>The interfaces are shaped for production replacements. The current adapters stay deliberately inert.</p>
      </div>
      <button class="close-button" data-action="close-detail" aria-label="Close">×</button>
    </div>
    <div class="detail-body">
      <div class="capability-list">
        <div class="capability-row"><div><strong>Policy and Run Grants</strong><small>Functional local implementations with persisted audit events.</small></div>${status("verified")}</div>
        <div class="capability-row"><div><strong>Runner</strong><small>Lifecycle and results are simulated. No customer code executes.</small></div>${status("pending")}</div>
        <div class="capability-row"><div><strong>Target authorization</strong><small>Proof records are persisted; network challenges are not performed.</small></div>${status("pending")}</div>
        <div class="capability-row"><div><strong>Agent engine</strong><small>Fixture observations stand in for model decisions.</small></div>${status("pending")}</div>
        <div class="capability-row"><div><strong>Authentication</strong><small>A fixed local-owner principal replaces OIDC and workload identity.</small></div>${status("pending")}</div>
        <div class="capability-row"><div><strong>Evidence</strong><small>Deterministic demo fixtures; never derived from the configured target.</small></div>${status("pending")}</div>
      </div>
    </div>
  `;
  detailDialog.showModal();
}

async function verifyTarget(id) {
  try {
    const payload = await api(`/api/targets/${encodeURIComponent(id)}/verify`, {
      method: "POST",
      body: JSON.stringify({ method: "http-challenge", assurance: "origin" })
    });
    await refresh();
    toast(`${payload.target.name} marked verified by the simulated challenge adapter.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function cancelRun(id) {
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
    await refresh(false);
    openRun(id);
    toast(`Run ${id} cancelled.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function updateFinding(id, findingStatus) {
  try {
    await api(`/api/findings/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: findingStatus })
    });
    await refresh(false);
    openFinding(id);
    render();
    toast(`Finding marked ${findingStatus}.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function resetDemo() {
  if (!window.confirm("Reset local demonstration projects, runs, and findings?")) return;
  try {
    await api("/api/demo/reset", { method: "POST", body: "{}" });
    detailDialog.close();
    await refresh();
    toast("Demonstration data reset.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function toast(message, kind = "") {
  const element = document.createElement("div");
  element.className = `toast ${kind}`;
  element.textContent = message;
  toastRegion.append(element);
  setTimeout(() => element.remove(), 4300);
}

async function refresh(shouldRender = true) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    state = await api("/api/bootstrap");
    if (shouldRender) render();
  } catch (error) {
    view.innerHTML = `<div class="empty-state"><h2>Could not reach Yellow Bird</h2><p>${escape(error.message)}</p></div>`;
  } finally {
    refreshInFlight = false;
  }
}

document.addEventListener("click", async (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) return;
  const action = actionTarget.dataset.action;
  if (action === "new-run") openRunForm();
  else if (action === "close-run") runDialog.close();
  else if (action === "close-detail") {
    detailDialog.close();
    const current = route();
    if (current.section === "runs" && current.id) location.hash = "runs";
  } else if (action === "view-run") {
    location.hash = `runs/${actionTarget.dataset.runId}`;
  } else if (action === "view-finding") {
    openFinding(actionTarget.dataset.findingId);
  } else if (action === "verify-target") {
    await verifyTarget(actionTarget.dataset.targetId);
  } else if (action === "cancel-run") {
    await cancelRun(actionTarget.dataset.runId);
  } else if (action === "update-finding") {
    await updateFinding(actionTarget.dataset.findingId, actionTarget.dataset.status);
  } else if (action === "doctor") showDoctor();
  else if (action === "reset") await resetDemo();
});

runForm.addEventListener("submit", submitRun);
window.addEventListener("hashchange", render);

await refresh();

setInterval(async () => {
  if (!state?.runs.some((run) => activeStatuses.has(run.status))) return;
  await refresh(false);
  render();
  const current = route();
  if (detailDialog.open && current.section === "runs" && current.id) openRun(current.id);
}, 900);
