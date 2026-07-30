import { test } from "bun:test";
import assert from "node:assert/strict";
import { createSeedState } from "../src/domain/catalog.js";
import { evaluateRunRequest, PolicyError } from "../src/services/policy.js";

test("policy grants the intersection and reports denied capabilities", () => {
  const state = createSeedState();
  const decision = evaluateRunRequest({
    policy: state.policies[0],
    target: state.targets[0],
    requestedCapabilities: ["http.read", "public_internet.read", "not.real"],
    networkProfile: "target-only"
  });

  assert.deepEqual(decision.grantedCapabilities, ["http.read"]);
  assert.deepEqual(decision.deniedCapabilities, ["public_internet.read", "not.real"]);
  assert.match(decision.policyDigest, /^sha256:[a-f0-9]{64}$/);
});

test("an unverified target fails closed", () => {
  const state = createSeedState();
  assert.throws(
    () =>
      evaluateRunRequest({
        policy: state.policies[0],
        target: state.targets[1],
        requestedCapabilities: ["http.read"],
        networkProfile: "target-only"
      }),
    (error) => error instanceof PolicyError && error.code === "target_unverified"
  );
});

test("production requires explicit approval", () => {
  const state = createSeedState();
  const target = structuredClone(state.targets[0]);
  target.environment = "production";

  assert.throws(
    () =>
      evaluateRunRequest({
        policy: state.policies[0],
        target,
        requestedCapabilities: ["http.read"],
        networkProfile: "target-only"
      }),
    (error) => error.code === "production_approval_required"
  );
});
