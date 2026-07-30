import { test } from "bun:test";
import assert from "node:assert/strict";
import { createSeedState } from "../src/domain/catalog.js";
import { GrantIssuer } from "../src/services/grants.js";
import { evaluateRunRequest } from "../src/services/policy.js";

test("a Run Grant is signed, target-bound, and verifiable", () => {
  const state = createSeedState();
  const target = state.targets[0];
  const decision = evaluateRunRequest({
    policy: state.policies[0],
    target,
    requestedCapabilities: ["browser.navigate", "http.read"],
    networkProfile: "target-only"
  });
  const issuer = new GrantIssuer("test-secret");
  const grant = issuer.issue({
    principal: state.principal,
    project: state.projects[0],
    target,
    runId: "run_test",
    policyDecision: decision
  });
  const verification = issuer.verify(grant.token);

  assert.equal(verification.valid, true);
  assert.equal(verification.payload.run_id, "run_test");
  assert.equal(verification.payload.target_id, target.id);
  assert.deepEqual(verification.payload.capabilities, ["browser.navigate", "http.read"]);
  assert.ok(verification.payload.cnf.jkt);
});

test("a modified Run Grant is rejected", () => {
  const issuer = new GrantIssuer("test-secret");
  assert.deepEqual(issuer.verify("header.payload.signature"), {
    valid: false,
    reason: "invalid_signature"
  });
});
