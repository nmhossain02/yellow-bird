import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export class GrantIssuer {
  constructor(secret = process.env.YELLOWBIRD_SIGNING_SECRET || randomBytes(32).toString("hex")) {
    this.secret = secret;
  }

  issue({ principal, project, target, runId, policyDecision, ttlSeconds = 3600 }) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + ttlSeconds;
    const { publicKey } = generateKeyPairSync("ed25519");
    const runnerKey = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    const runnerKeyThumbprint = createHash("sha256").update(runnerKey).digest("base64url");

    const header = { alg: "HS256", typ: "yb-run-grant+jwt", kid: "local-stub" };
    const payload = {
      iss: "yellowbird-local",
      sub: principal.id,
      aud: ["yellowbird-runner", "yellowbird-capability-broker", "yellowbird-egress-gateway"],
      jti: randomUUID(),
      iat: issuedAt,
      nbf: issuedAt,
      exp: expiresAt,
      run_id: runId,
      project_id: project.id,
      target_id: target.id,
      environment: target.environment,
      assurance: target.proof.assurance,
      capabilities: policyDecision.grantedCapabilities,
      network_profile: policyDecision.networkProfile,
      policy_digest: policyDecision.policyDigest,
      cnf: { jkt: runnerKeyThumbprint }
    };

    const unsigned = `${encode(header)}.${encode(payload)}`;
    const signature = createHmac("sha256", this.secret).update(unsigned).digest("base64url");
    const token = `${unsigned}.${signature}`;

    return {
      id: payload.jti,
      token,
      tokenPreview: `${token.slice(0, 22)}…${token.slice(-10)}`,
      issuedAt: new Date(issuedAt * 1000).toISOString(),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      assurance: target.proof.assurance,
      policyDigest: policyDecision.policyDigest,
      runnerKeyThumbprint
    };
  }

  verify(token) {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false, reason: "malformed" };
    const unsigned = `${parts[0]}.${parts[1]}`;
    const expected = Buffer.from(
      createHmac("sha256", this.secret).update(unsigned).digest("base64url")
    );
    const received = Buffer.from(parts[2]);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      return { valid: false, reason: "invalid_signature" };
    }

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload.exp <= Math.floor(Date.now() / 1000)) return { valid: false, reason: "expired", payload };
    return { valid: true, payload };
  }
}
