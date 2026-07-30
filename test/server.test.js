import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

test("server exposes the dashboard and an end-to-end run API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yellowbird-server-"));
  const running = await startServer({
    port: 0,
    dataPath: join(directory, "state.json"),
    signingSecret: "server-test-secret",
    stageDelayMs: 1
  });
  cleanups.push(async () => {
    await new Promise((resolve) => running.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://${running.host}:${running.port}`;

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Yellow Bird/);

  const bootstrap = await fetch(`${origin}/api/bootstrap`).then((response) => response.json());
  assert.equal(bootstrap.product.engine, "simulated");
  assert.equal(bootstrap.product.engineStrategy, "kimi-and-open-weight-first");
  assert.equal(bootstrap.projects[0].id, "prj_feather");
  assert.deepEqual(
    bootstrap.engineProfiles.map(({ id }) => id),
    ["eng_simulated", "eng_kimi_hosted", "eng_open_weight_endpoint", "eng_local_cli"]
  );
  assert.equal(bootstrap.engineProfiles[1].model, "kimi-k3");
  assert.equal(bootstrap.engineProfiles[2].dataBoundary, "customer-controlled");

  const response = await fetch(`${origin}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "prj_feather",
      targetId: "tgt_local",
      profile: "deterministic",
      networkProfile: "target-only",
      requestedCapabilities: ["browser.navigate", "http.read", "http.write", "test_data.create"]
    })
  });
  assert.equal(response.status, 202);
  const { run } = await response.json();
  assert.equal(run.profile, "deterministic");
  assert.equal(run.grant.token, undefined);
  assert.ok(run.grant.tokenPreview);

  await running.runner.start(run.id);
  const detail = await fetch(`${origin}/api/runs/${run.id}`).then((result) => result.json());
  assert.equal(detail.run.status, "completed");
  assert.equal(detail.run.coverage.total, 2);
});

test("active testing of an unverified target is rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yellowbird-server-"));
  const running = await startServer({
    port: 0,
    dataPath: join(directory, "state.json"),
    signingSecret: "server-test-secret",
    stageDelayMs: 1
  });
  cleanups.push(async () => {
    await new Promise((resolve) => running.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const response = await fetch(`http://${running.host}:${running.port}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "prj_feather",
      targetId: "tgt_staging",
      profile: "balanced",
      networkProfile: "target-only"
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.error.code, "target_unverified");
});
