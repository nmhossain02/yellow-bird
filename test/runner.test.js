import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrantIssuer } from "../src/services/grants.js";
import { SimulatedRunner } from "../src/services/runner.js";
import { FileStore } from "../src/services/store.js";

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "yellowbird-runner-"));
  const store = new FileStore(join(directory, "state.json"));
  await store.initialize();
  const runner = new SimulatedRunner({
    store,
    grantIssuer: new GrantIssuer("runner-test-secret"),
    stageDelayMs: 1
  });
  return {
    store,
    runner,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

test("balanced simulation completes with evidence and a repaired execution mechanic", async () => {
  const { store, runner, cleanup } = await harness();
  cleanups.push(cleanup);

  const created = await runner.createRun({
    projectId: "prj_feather",
    targetId: "tgt_local",
    profile: "balanced",
    networkProfile: "target-and-declared-tools"
  });
  await runner.start(created.id);

  const state = store.snapshot();
  const run = state.runs.find((candidate) => candidate.id === created.id);
  assert.equal(run.status, "completed");
  assert.equal(run.coverage.total, 4);
  assert.equal(run.coverage.failed, 2);
  assert.equal(run.coverage.passed, 2);
  assert.equal(run.findingIds.length, 2);
  assert.equal(run.scenarioResults.some((result) => result.healed), true);
  assert.equal(
    run.scenarioResults.find((result) => result.healed).repair.expectedResultChanged,
    false
  );
});

test("missing capability becomes a skipped coverage gap rather than a pass", async () => {
  const { store, runner, cleanup } = await harness();
  cleanups.push(cleanup);

  const created = await runner.createRun({
    projectId: "prj_feather",
    targetId: "tgt_local",
    profile: "balanced",
    networkProfile: "target-only",
    requestedCapabilities: ["http.read"]
  });
  await runner.start(created.id);

  const run = store.snapshot().runs.find((candidate) => candidate.id === created.id);
  assert.ok(run.coverage.skipped >= 2);
  assert.ok(run.coverageGaps.some((gap) => gap.capability === "browser.navigate"));
  assert.equal(run.coverage.passed + run.coverage.failed + run.coverage.skipped, run.coverage.total);
});
