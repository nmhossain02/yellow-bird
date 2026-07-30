import { randomUUID } from "node:crypto";
import { capabilitiesMissingForScenario, evaluateRunRequest, PolicyError } from "./policy.js";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const timestamp = () => new Date().toISOString();
const shortId = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;

const profileModes = {
  balanced: new Set(["scripted", "hybrid", "exploratory"]),
  deterministic: new Set(["scripted"]),
  exploratory: new Set(["hybrid", "exploratory"])
};

function scenarioObservation(scenario) {
  switch (scenario.fixture) {
    case "duplicate-order":
      return {
        status: "failed",
        healed: false,
        observation: "Expected one order and one charge; observed two order records from one idempotency key.",
        durationMs: 8400
      };
    case "healed-selector":
      return {
        status: "passed",
        healed: true,
        observation: "The signup link moved. The executor repaired navigation using the accessible name; the invariant was unchanged.",
        repair: {
          kind: "execution-mechanic",
          before: "a[href='/signup']",
          after: "role=link[name='Create account']",
          expectedResultChanged: false
        },
        durationMs: 12100
      };
    case "tenant-leak":
      return {
        status: "failed",
        healed: false,
        observation: "An adjacent invoice identifier returned a fixture belonging to another tenant.",
        durationMs: 9300
      };
    default:
      return {
        status: "passed",
        healed: false,
        observation: "All generated contract assertions held for the sampled responses.",
        durationMs: 3100
      };
  }
}

function createFinding(run, scenario) {
  const common = {
    id: shortId("fnd"),
    runId: run.id,
    projectId: run.projectId,
    scenarioId: scenario.id,
    status: "open",
    createdAt: timestamp()
  };

  if (scenario.fixture === "tenant-leak") {
    return {
      ...common,
      title: "Cross-tenant invoice accessible by identifier",
      summary: "A member session retrieved an invoice fixture owned by a different tenant after changing the identifier.",
      severity: "high",
      confidence: 0.91,
      evidence: [
        { kind: "request", label: "GET /api/invoices/inv_2049", detail: "Authenticated as the bluebird test tenant" },
        { kind: "response", label: "200 OK", detail: "Body contains the sunfinch tenant fixture" },
        { kind: "assertion", label: "Ownership mismatch", detail: "response.tenant_id != session.tenant_id" }
      ],
      reproduction: [
        "Sign in as the run-owned member for tenant bluebird.",
        "Open an invoice belonging to the current tenant and note its identifier format.",
        "Request `/api/invoices/inv_2049` using the same authenticated session.",
        "Observe a 200 response containing another tenant's fixture; expected 403 or 404."
      ]
    };
  }

  return {
    ...common,
    title: "Repeated checkout creates a duplicate order",
    summary: "Two near-simultaneous submissions with the same idempotency key created separate order records.",
    severity: "medium",
    confidence: 0.84,
    evidence: [
      { kind: "trace", label: "Checkout pair", detail: "Requests separated by 43 ms with an identical idempotency key" },
      { kind: "database", label: "Order delta", detail: "Expected +1 order; observed +2 orders" }
    ],
    reproduction: [
      "Create a cart containing one in-stock item.",
      "Submit checkout twice within 100 ms using the same idempotency key.",
      "Query the run-owned customer's recent orders.",
      "Observe two order records; expected exactly one."
    ]
  };
}

export class SimulatedRunner {
  constructor({ store, grantIssuer, stageDelayMs = 450 }) {
    this.store = store;
    this.grantIssuer = grantIssuer;
    this.stageDelayMs = stageDelayMs;
    this.active = new Map();
  }

  async createRun(request) {
    const state = this.store.snapshot();
    const project = state.projects.find((candidate) => candidate.id === request.projectId);
    if (!project) throw new PolicyError("The selected project does not exist", 404, "project_not_found");

    const target = state.targets.find(
      (candidate) => candidate.id === request.targetId && candidate.projectId === project.id
    );
    const policy = state.policies[0];
    const profile = request.profile || "balanced";
    if (!profileModes[profile]) throw new PolicyError(`Unknown run profile “${profile}”`, 422, "invalid_profile");

    const requestedCapabilities =
      request.requestedCapabilities?.length > 0
        ? request.requestedCapabilities
        : policy.allowedCapabilities;
    const networkProfile = request.networkProfile || "target-only";

    const decision = evaluateRunRequest({
      policy,
      target,
      requestedCapabilities,
      networkProfile,
      approved: request.approved === true
    });

    const selectedScenarios = state.scenarios.filter(
      (scenario) => scenario.projectId === project.id && profileModes[profile].has(scenario.mode)
    );
    const runId = shortId("run");
    const grant = this.grantIssuer.issue({
      principal: state.principal,
      project,
      target,
      runId,
      policyDecision: decision,
      ttlSeconds: Math.min(policy.maxRunSeconds, 3600)
    });

    const run = {
      id: runId,
      projectId: project.id,
      targetId: target.id,
      trigger: request.trigger || "manual",
      profile,
      networkProfile,
      status: "queued",
      outcome: null,
      progress: 4,
      stage: "Queued",
      requestedCapabilities: decision.requestedCapabilities,
      grantedCapabilities: decision.grantedCapabilities,
      deniedCapabilities: decision.deniedCapabilities,
      scenarioIds: selectedScenarios.map((scenario) => scenario.id),
      scenarioResults: [],
      findingIds: [],
      coverageGaps: decision.deniedCapabilities.map((capability) => ({
        capability,
        reason: "Denied or unavailable under the resolved policy"
      })),
      coverage: {
        total: selectedScenarios.length,
        passed: 0,
        failed: 0,
        skipped: 0,
        untested: selectedScenarios.length
      },
      createdAt: timestamp(),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      grant
    };

    await this.store.mutate((mutable) => {
      mutable.runs.unshift(run);
      mutable.auditEvents.unshift({
        id: shortId("evt"),
        type: "run.authorized",
        actor: mutable.principal.id,
        message: `Authorized ${run.id} for ${target.name} with ${decision.grantedCapabilities.length} capabilities.`,
        runId: run.id,
        createdAt: timestamp()
      });
    });

    this.start(run.id);
    return this.publicRun(run);
  }

  start(runId) {
    if (this.active.has(runId)) return this.active.get(runId);
    const execution = this.execute(runId).finally(() => this.active.delete(runId));
    this.active.set(runId, execution);
    return execution;
  }

  async execute(runId) {
    const startedAt = Date.now();
    const stages = [
      ["authorizing", "Validating run grant", 12],
      ["adapting", "Adapting to target", 25],
      ["running", "Executing canary scenarios", 42]
    ];

    for (const [status, stage, progress] of stages) {
      if (await this.isCancelled(runId)) return;
      await this.updateRun(runId, {
        status,
        stage,
        progress,
        ...(status === "authorizing" ? { startedAt: timestamp() } : {})
      });
      await wait(this.stageDelayMs);
    }

    const snapshot = this.store.snapshot();
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    if (!run) return;
    const scenarios = run.scenarioIds
      .map((id) => snapshot.scenarios.find((scenario) => scenario.id === id))
      .filter(Boolean);

    for (let index = 0; index < scenarios.length; index += 1) {
      if (await this.isCancelled(runId)) return;
      const scenario = scenarios[index];
      const missingCapabilities = capabilitiesMissingForScenario(scenario, run.grantedCapabilities);
      const progress = 42 + Math.round(((index + 1) / Math.max(scenarios.length, 1)) * 38);

      if (missingCapabilities.length > 0) {
        await this.store.mutate((mutable) => {
          const current = mutable.runs.find((candidate) => candidate.id === runId);
          current.progress = progress;
          current.stage = `Skipped: ${scenario.title}`;
          current.scenarioResults.push({
            scenarioId: scenario.id,
            status: "skipped",
            healed: false,
            durationMs: 0,
            observation: `Could not run without: ${missingCapabilities.join(", ")}`,
            missingCapabilities
          });
          for (const capability of missingCapabilities) {
            if (!current.coverageGaps.some((gap) => gap.capability === capability)) {
              current.coverageGaps.push({
                capability,
                scenarioId: scenario.id,
                reason: `Required by “${scenario.title}”`
              });
            }
          }
          this.recalculateCoverage(current);
        });
      } else {
        const result = scenarioObservation(scenario);
        await this.store.mutate((mutable) => {
          const current = mutable.runs.find((candidate) => candidate.id === runId);
          current.progress = progress;
          current.stage = `Executed: ${scenario.title}`;
          current.scenarioResults.push({ scenarioId: scenario.id, ...result });

          if (result.status === "failed") {
            const finding = createFinding(current, scenario);
            mutable.findings.unshift(finding);
            current.findingIds.push(finding.id);
          }

          if (result.healed) {
            mutable.auditEvents.unshift({
              id: shortId("evt"),
              type: "test.execution_repaired",
              actor: "simulated-agent",
              runId,
              message: `Repaired execution mechanics for “${scenario.title}”; expected result unchanged.`,
              createdAt: timestamp()
            });
          }
          this.recalculateCoverage(current);
        });
      }

      await wait(Math.max(100, Math.floor(this.stageDelayMs * 0.65)));
    }

    await this.updateRun(runId, { status: "analyzing", stage: "Validating evidence", progress: 89 });
    await wait(this.stageDelayMs);

    await this.store.mutate((mutable) => {
      const current = mutable.runs.find((candidate) => candidate.id === runId);
      if (!current || current.status === "cancelled") return;
      current.status = "completed";
      current.stage = "Complete";
      current.progress = 100;
      current.outcome = current.findingIds.length > 0 ? "attention" : "clear";
      current.completedAt = timestamp();
      current.durationMs = Date.now() - startedAt;
      this.recalculateCoverage(current);
      mutable.auditEvents.unshift({
        id: shortId("evt"),
        type: "run.completed",
        actor: "simulated-runner",
        runId,
        message: `${runId} completed with ${current.findingIds.length} findings and ${current.coverage.skipped} skipped scenarios.`,
        createdAt: timestamp()
      });
    });
  }

  async cancel(runId) {
    let cancelled = false;
    await this.store.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (!run) throw new PolicyError("Run not found", 404, "run_not_found");
      if (["completed", "cancelled"].includes(run.status)) return;
      run.status = "cancelled";
      run.stage = "Cancelled";
      run.outcome = "cancelled";
      run.completedAt = timestamp();
      cancelled = true;
      state.auditEvents.unshift({
        id: shortId("evt"),
        type: "run.cancelled",
        actor: state.principal.id,
        runId,
        message: `Cancelled ${runId}.`,
        createdAt: timestamp()
      });
    });
    return cancelled;
  }

  async isCancelled(runId) {
    return this.store.snapshot().runs.find((candidate) => candidate.id === runId)?.status === "cancelled";
  }

  async updateRun(runId, patch) {
    await this.store.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (!run) throw new PolicyError("Run not found", 404, "run_not_found");
      if (run.status === "cancelled") return;
      Object.assign(run, patch);
    });
  }

  recalculateCoverage(run) {
    const counts = { passed: 0, failed: 0, skipped: 0 };
    for (const result of run.scenarioResults) {
      if (Object.hasOwn(counts, result.status)) counts[result.status] += 1;
    }
    run.coverage = {
      total: run.scenarioIds.length,
      ...counts,
      untested: Math.max(0, run.scenarioIds.length - run.scenarioResults.length)
    };
  }

  publicRun(run) {
    const clone = structuredClone(run);
    if (clone.grant) delete clone.grant.token;
    return clone;
  }
}
