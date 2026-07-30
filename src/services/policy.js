import { createHash } from "node:crypto";

export class PolicyError extends Error {
  constructor(message, statusCode = 422, code = "policy_rejected") {
    super(message);
    this.name = "PolicyError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function evaluateRunRequest({ policy, target, requestedCapabilities, networkProfile, approved = false }) {
  if (!target) throw new PolicyError("The selected target does not exist", 404, "target_not_found");
  if (target.proof?.status !== "verified") {
    throw new PolicyError(
      `Target “${target.name}” must be verified before active testing`,
      409,
      "target_unverified"
    );
  }

  if (!policy.networkProfiles.includes(networkProfile)) {
    throw new PolicyError(
      `Network profile “${networkProfile}” is not allowed by policy`,
      403,
      "network_profile_denied"
    );
  }

  if (target.environment === "production" && policy.productionRequiresApproval && !approved) {
    throw new PolicyError(
      "Production runs require an explicit approval",
      403,
      "production_approval_required"
    );
  }

  const uniqueRequested = [...new Set(requestedCapabilities || [])];
  const targetCapabilities = new Set(target.capabilities || []);
  const allowed = new Set(policy.allowedCapabilities || []);
  const deniedByPolicy = new Set(policy.deniedCapabilities || []);

  const grantedCapabilities = uniqueRequested.filter(
    (capability) => allowed.has(capability) && targetCapabilities.has(capability) && !deniedByPolicy.has(capability)
  );
  const deniedCapabilities = uniqueRequested.filter((capability) => !grantedCapabilities.includes(capability));

  const resolved = {
    policyId: policy.id,
    policyRevision: policy.revision,
    targetId: target.id,
    environment: target.environment,
    assurance: target.proof.assurance,
    networkProfile,
    requestedCapabilities: uniqueRequested,
    grantedCapabilities,
    deniedCapabilities,
    limits: {
      maxRunSeconds: policy.maxRunSeconds,
      maxRequests: policy.maxRequests,
      evidenceRetentionDays: policy.evidenceRetentionDays
    }
  };

  const digest = createHash("sha256").update(JSON.stringify(resolved)).digest("hex");

  return {
    ...resolved,
    policyDigest: `sha256:${digest}`
  };
}

export function capabilitiesMissingForScenario(scenario, grantedCapabilities) {
  const granted = new Set(grantedCapabilities);
  return scenario.requiredCapabilities.filter((capability) => !granted.has(capability));
}
