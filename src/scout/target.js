const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function targetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function authorizeScoutTarget(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw targetError(
      "invalid-target-url",
      "scout target must be an absolute http(s) URL"
    );
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    throw targetError(
      "invalid-target-protocol",
      "scout target must use http or https"
    );
  }
  if (target.username || target.password) {
    throw targetError(
      "target-credentials",
      "credentials must not be embedded in the target URL"
    );
  }
  if (!LOOPBACK_HOSTS.has(target.hostname)) {
    throw targetError(
      "target-not-loopback",
      "this alpha only authorizes loopback targets (localhost, 127.0.0.1, or ::1)"
    );
  }

  return {
    target: target.href,
    origin: target.origin,
    authorization: {
      method: "local-loopback-attestation",
      scope: "exact-origin",
      rationale:
        "The operator running YellowBird already controls access to this local machine."
    }
  };
}
