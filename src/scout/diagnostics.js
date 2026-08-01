const TERMINAL_SEQUENCE_PATTERN =
  /\u001b(?:\][\s\S]*?(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][\s\S]*?\u001b\\|[@-_])/g;
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function cleanDiagnosticText(value) {
  return String(value || "")
    .replace(TERMINAL_SEQUENCE_PATTERN, "")
    .replace(CONTROL_CHARACTER_PATTERN, "")
    .trim();
}

function redactUrlValues(value) {
  return value.replace(/https?:\/\/[^\s"'<>]+/g, (candidate) => {
    const trailing = candidate.match(/[),.;:]+$/)?.[0] || "";
    const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
    return `${diagnosticUrl(url).url}${trailing}`;
  });
}

export function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    const parameterNames = [...new Set(url.searchParams.keys())];
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return {
      url: url.href,
      ...(parameterNames.length ? { queryParameterNames: parameterNames } : {})
    };
  } catch {
    return { url: "unparseable" };
  }
}

export function createDiagnosticRecorder(onEvent, context = {}) {
  const events = [];
  let sequence = 0;
  const record = (level, event, message, data = {}) => {
    const entry = {
      schema: "yellowbird.diagnostic-event.v1",
      sequence: (sequence += 1),
      timestamp: new Date().toISOString(),
      level,
      component: "local-scout",
      ...context,
      event,
      message,
      data
    };
    events.push(entry);
    onEvent?.(entry);
    return entry;
  };
  return { events, record };
}

async function probe(url, timeoutMs) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    return {
      reachable: true,
      status: response.status,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      reachable: false,
      error: cleanDiagnosticText(error.message),
      durationMs: Date.now() - startedAt
    };
  }
}

function httpAlternative(requested) {
  const candidate = new URL(requested.href);
  const effectivePort =
    requested.port || (requested.protocol === "https:" ? "443" : "");
  candidate.protocol = "http:";
  if (effectivePort) {
    candidate.port = effectivePort;
  }
  return candidate;
}

export async function resolveLoopbackScheme(target, timeoutMs, record) {
  const requested = new URL(target);
  record("debug", "target.probe.started", "Probing the requested target", {
    ...diagnosticUrl(requested.href),
    method: "HEAD"
  });
  const requestedProbe = await probe(requested.href, timeoutMs);
  record(
    requestedProbe.reachable ? "info" : "warn",
    "target.probe.completed",
    requestedProbe.reachable
      ? "The requested target accepted an HTTP connection"
      : "The requested target did not accept the probe",
    { ...diagnosticUrl(requested.href), ...requestedProbe }
  );

  if (requestedProbe.reachable || requested.protocol !== "https:") {
    return { effectiveTarget: requested.href, requestedProbe, repairs: [] };
  }

  const candidate = httpAlternative(requested);
  record(
    "debug",
    "target.scheme_probe.started",
    "Probing HTTP because the loopback HTTPS probe failed",
    diagnosticUrl(candidate.href)
  );
  const candidateProbe = await probe(candidate.href, timeoutMs);
  record(
    candidateProbe.reachable ? "info" : "warn",
    "target.scheme_probe.completed",
    candidateProbe.reachable
      ? "The HTTP alternative accepted a connection"
      : "The HTTP alternative did not accept a connection",
    { ...diagnosticUrl(candidate.href), ...candidateProbe }
  );

  if (!candidateProbe.reachable) {
    return { effectiveTarget: requested.href, requestedProbe, repairs: [] };
  }

  const repair = {
    code: "loopback-scheme-repaired",
    field: "target.url",
    from: requested.href,
    to: candidate.href,
    rationale:
      "The requested HTTPS endpoint rejected the transport probe while the same loopback host and port responded over HTTP.",
    expectedResultChanged: false
  };
  record(
    "warn",
    "target.scheme_repaired",
    "Repaired the loopback target scheme from HTTPS to HTTP",
    {
      code: repair.code,
      field: repair.field,
      from: diagnosticUrl(repair.from).url,
      to: diagnosticUrl(repair.to).url,
      expectedResultChanged: repair.expectedResultChanged
    }
  );
  return {
    effectiveTarget: candidate.href,
    requestedProbe,
    candidateProbe,
    repairs: [repair]
  };
}

export function diagnoseNavigationError(error, target) {
  const detail = redactUrlValues(cleanDiagnosticText(error));
  const lower = detail.toLowerCase();
  if (lower.includes("err_ssl_protocol_error")) {
    const suggestedTarget = diagnosticUrl(
      httpAlternative(new URL(target)).href
    ).url;
    return {
      code: "target-tls-protocol-mismatch",
      message: "The target did not complete an HTTPS handshake.",
      remediation: `Confirm the service uses TLS, or try ${suggestedTarget}.`,
      detail
    };
  }
  if (lower.includes("err_cert_authority_invalid")) {
    return {
      code: "target-certificate-untrusted",
      message: "The target presented a certificate Chromium does not trust.",
      remediation:
        "Install a trusted local certificate or add an explicit certificate policy; YellowBird does not silently ignore TLS errors.",
      detail
    };
  }
  if (lower.includes("err_connection_refused")) {
    return {
      code: "target-connection-refused",
      message: "No service accepted a connection at the target address.",
      remediation: "Start the product and confirm its host and port, then rerun the scout.",
      detail
    };
  }
  if (lower.includes("err_name_not_resolved")) {
    return {
      code: "target-name-unresolved",
      message: "The target hostname could not be resolved.",
      remediation: "Correct the hostname or update local name resolution before rerunning.",
      detail
    };
  }
  if (lower.includes("timeout")) {
    return {
      code: "target-navigation-timeout",
      message: "The target did not finish its initial navigation before the timeout.",
      remediation: "Check product startup health or rerun with a larger timeout.",
      detail
    };
  }
  return {
    code: "target-navigation-failed",
    message: "The initial browser navigation did not complete.",
    remediation: "Review diagnostics.jsonl and verify the target URL and product health.",
    detail
  };
}

export function diagnoseBrowserLaunchError(error) {
  const detail = redactUrlValues(cleanDiagnosticText(error));
  const lower = detail.toLowerCase();
  if (
    lower.includes("executable doesn't exist") ||
    lower.includes("executable does not exist") ||
    lower.includes("browser was not found")
  ) {
    return {
      code: "browser-executable-missing",
      message: "The Playwright Chromium executable is unavailable.",
      remediation: "Install Chromium with `bun run setup:browsers`, then rerun the scout.",
      detail
    };
  }
  if (
    lower.includes("host system is missing dependencies") ||
    lower.includes("error while loading shared libraries") ||
    lower.includes("missing dependencies to run browsers")
  ) {
    return {
      code: "browser-host-dependencies-missing",
      message: "Chromium cannot start because required host dependencies are unavailable.",
      remediation:
        "Install the Playwright Chromium host dependencies for this operating system, then rerun the scout.",
      detail
    };
  }
  return {
    code: "browser-launch-failed",
    message: "Playwright Chromium could not be launched.",
    remediation:
      "Review diagnostics.jsonl, confirm Chromium can start on this host, then rerun the scout.",
    detail
  };
}
