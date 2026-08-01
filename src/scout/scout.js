import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  cleanDiagnosticText,
  createDiagnosticRecorder,
  diagnoseBrowserLaunchError,
  diagnoseNavigationError,
  diagnosticUrl,
  resolveLoopbackScheme,
  sanitizeDiagnosticText
} from "./diagnostics.js";
import {
  resolveAgentEngine,
  validateAgentEngineConfig
} from "./engine.js";
import {
  exploreIntentWithEngine,
  isAgentUrlAllowed,
  PROHIBITED_AGENT_ACTION_PATTERN
} from "./explorer.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const STEP_CAPABILITIES = {
  click: "browser.click",
  fill: "browser.fill",
  expectText: "browser.read",
  expectVisible: "browser.read"
};
const SUPPORTED_STEP_ACTIONS = new Set(Object.keys(STEP_CAPABILITIES));
const AGENT_NAVIGATION_SETTLEMENT_MS = 150;
const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = require("@playwright/test/package.json").version;

export function authorizeScoutTarget(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error("scout target must be an absolute http(s) URL");
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("scout target must use http or https");
  }
  if (target.username || target.password) {
    throw new Error("credentials must not be embedded in the target URL");
  }
  if (!LOOPBACK_HOSTS.has(target.hostname)) {
    throw new Error(
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

export function validateWorkflow(input = {}) {
  if (input.permissions !== undefined && !Array.isArray(input.permissions)) {
    throw new Error("workflow permissions must be an array");
  }
  const permissions = new Set(
    input.permissions || ["browser.navigate", "browser.read"]
  );
  const steps = input.steps || [];

  if (!Array.isArray(steps)) {
    throw new Error("workflow steps must be an array");
  }
  for (const baselineCapability of ["browser.navigate", "browser.read"]) {
    if (!permissions.has(baselineCapability)) {
      throw new Error(
        `workflow requires declared capability ${baselineCapability}`
      );
    }
  }

  const ids = new Set();
  const normalizedSteps = steps.map((step, index) => {
    if (!step || typeof step !== "object") {
      throw new Error(`workflow step ${index + 1} must be an object`);
    }
    const id = step.id || `step-${index + 1}`;
    if (ids.has(id)) throw new Error(`workflow step id must be unique: ${id}`);
    ids.add(id);

    if (!SUPPORTED_STEP_ACTIONS.has(step.action)) {
      throw new Error(`unsupported workflow action: ${step.action}`);
    }
    if (typeof step.selector !== "string" || !step.selector.trim()) {
      throw new Error(`workflow step ${id} requires a selector`);
    }

    const capability = STEP_CAPABILITIES[step.action];
    if (!permissions.has(capability)) {
      throw new Error(
        `workflow step ${id} requires undeclared capability ${capability}`
      );
    }

    if (step.action === "fill") {
      const hasLiteralValue = typeof step.value === "string";
      const hasEnvironmentValue =
        typeof step.valueFromEnv === "string" && step.valueFromEnv.length > 0;
      if (hasLiteralValue === hasEnvironmentValue) {
        throw new Error(
          `fill step ${id} requires exactly one of value or valueFromEnv`
        );
      }
      if (hasEnvironmentValue && process.env[step.valueFromEnv] === undefined) {
        throw new Error(
          `fill step ${id} requires environment variable ${step.valueFromEnv}`
        );
      }
    }
    if (
      step.action === "expectText" &&
      (typeof step.text !== "string" || !step.text)
    ) {
      throw new Error(`expectText step ${id} requires text`);
    }

    return {
      id,
      action: step.action,
      selector: step.selector,
      text: step.text,
      value: step.value,
      valueFromEnv: step.valueFromEnv,
      capability
    };
  });

  return {
    permissions: [...permissions],
    steps: normalizedSteps
  };
}

function markdownEscape(value) {
  return cleanDiagnosticText(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(/([`*_[\]{}<>#|])/g, "\\$1")
    .replaceAll(/\s+/g, " ");
}

function diagnosticsJsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function buildMarkdown(report) {
  const findingRows = report.findings.length
    ? report.findings
        .map(
          (finding) =>
            `| ${markdownEscape(finding.severity)} | ${markdownEscape(finding.title)} | ${markdownEscape(finding.evidence)} |`
        )
        .join("\n")
    : "| - | No asserted failures observed within the tested scope | - |";
  const workflowRows = report.observations.workflowSteps.length
    ? report.observations.workflowSteps
        .map(
          (step) =>
            `| ${markdownEscape(step.id)} | ${markdownEscape(step.action)} | ${markdownEscape(step.status)} | ${markdownEscape(step.evidence || "-")} |`
        )
        .join("\n")
    : "| - | - | No workflow declared | - |";
  const diagnosticRows = report.invalidTestMechanics.length
    ? report.invalidTestMechanics
        .map(
          (issue) =>
            `| ${markdownEscape(issue.id)} | ${markdownEscape(issue.title)} | ${markdownEscape(issue.remediation)} |`
        )
        .join("\n")
    : "| - | No test-mechanics issues observed | - |";
  const repairRows = report.target.repairs.length
    ? report.target.repairs
        .map(
          (repair) =>
            `| ${markdownEscape(repair.code)} | ${markdownEscape(repair.from)} | ${markdownEscape(repair.to)} | ${repair.expectedResultChanged ? "yes" : "no"} |`
        )
        .join("\n")
    : "| - | - | - | - |";
  const exploration = report.observations.exploration;
  const explorationRows = exploration.steps.length
    ? exploration.steps
        .map(
          (step) =>
            `| ${markdownEscape(step.id)} | ${markdownEscape(step.status)} | ${markdownEscape(step.title || step.url)} | ${markdownEscape(step.evidence)} |`
        )
        .join("\n")
    : "| - | - | No agent navigation executed | - |";

  return `# YellowBird scout report

- Run: \`${report.run.id}\`
- Outcome: **${report.outcome}**
- Target: \`${report.target.url}\`
- Requested target: \`${report.target.requestedUrl}\`
- Authorization: ${report.target.authorization.method}, ${report.target.authorization.scope}
- Intent: ${report.intent}
- Started: ${report.run.startedAt}
- Duration: ${report.run.durationMs} ms

## Findings

| Severity | Finding | Evidence |
| --- | --- | --- |
${findingRows}

## Diagnostics

| Code | Test-mechanics issue | Remediation |
| --- | --- | --- |
${diagnosticRows}

| Repair | From | To | Expected result changed? |
| --- | --- | --- | --- |
${repairRows}

Structured event log: \`${report.artifacts.diagnostics}\`

## Workflow

Declared capabilities: ${report.permissions.map((permission) => `\`${permission}\``).join(", ")}

| Step | Action | Status | Evidence |
| --- | --- | --- | --- |
${workflowRows}

## Intent exploration

- Requested: ${exploration.requested ? "yes" : "no"}
- Mode: ${exploration.mode}
- Status: ${exploration.status}
- Coverage: ${exploration.coverage}
- Coverage authority: ${exploration.verification ? `${exploration.verification.authority} (${exploration.verification.profile}, ${exploration.verification.satisfied ? "satisfied" : "unsatisfied"})` : "unverified model advisory (cannot authorize covered coverage)"}
- Engine: ${markdownEscape(exploration.engine || "not used")}
- Coverage summary: ${markdownEscape(exploration.summary || "none")}

Coverage summaries and model proposals are not product-failure evidence. A named
YellowBird-observed profile lists its completion criteria in machine-readable evidence.

| Step | Status | Page | Evidence |
| --- | --- | --- | --- |
${explorationRows}

## Observations

- HTTP status: ${report.observations.status ?? "unavailable"}
- Page title: ${report.observations.title || "(empty)"}
- Interactive elements inventoried: ${report.observations.interactiveElements.length}
- Console errors: ${report.observations.consoleErrors.length}
- Uncaught page errors: ${report.observations.pageErrors.length}
- Failed same-origin requests: ${report.observations.failedRequests.length}
- Blocked policy requests: ${report.observations.blockedRequests.length}

## Coverage gaps

${report.coverageGaps.map((gap) => `- ${gap}`).join("\n")}

## Reproduction

1. Run \`bun install --cwd ${JSON.stringify(dirname(report.artifacts.replayPackage))}\`.
2. Run \`bun run --cwd ${JSON.stringify(dirname(report.artifacts.replayPackage))} setup:browsers\`.
3. Ensure the target is available at \`${report.target.url}\`.
4. Run \`bun run --cwd ${JSON.stringify(dirname(report.artifacts.replayPackage))} test\`.

The generated regression contains explicit assertions and accepted read-only navigation
steps. It does not require the planning model. Review it before committing it to the product
repository.
`;
}

function quoteForJavaScript(value) {
  return JSON.stringify(value);
}

function evidenceUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return "unparseable";
  }
}

function buildRegression(options, explorationSteps = []) {
  const replaySteps = explorationSteps.filter(
    (candidate) =>
      candidate.status !== "invalid" ||
      (candidate.action === "visit" && candidate.navigationAttempted)
  );
  const lines = [
    'import { randomUUID } from "node:crypto";',
    'import { test, expect } from "@playwright/test";',
    "",
    `test(${quoteForJavaScript(`YellowBird scout: ${options.intent}`)}, async ({ page }) => {`,
    "  const consoleErrors = [];",
    "  const pageErrors = [];",
    "  const failedRequests = [];",
    "  const serverErrors = [];",
    "  const yellowbirdGuardControlName = `__yellowbird_${randomUUID().replaceAll(\"-\", \"\")}`;",
    "  const yellowbirdGuardControlToken = randomUUID();",
    "  const yellowbirdGuardPrefix = `__yellowbird_guard__${randomUUID()}:`;",
    "  const yellowbirdFetchBindingName = `__yellowbird_${randomUUID().replaceAll(\"-\", \"\")}`;",
    "  const yellowbirdFetchBindingToken = randomUUID();",
    "  const yellowbirdFetchOccurrencePrefix = `${randomUUID()}:`;",
    "  const yellowbirdFetchOccurrenceHeader = `x-yellowbird-${randomUUID().replaceAll(\"-\", \"\")}`;",
    "  const yellowbirdFetchFailurePrefix = `__yellowbird_fetch_failure__${randomUUID()}:`;",
    "  let yellowbirdFetchOccurrenceSequence = 0;",
    "  const yellowbirdBlockedFetchOccurrences = new Set();",
    "  const yellowbirdBlockedRequests = new WeakSet();",
    "  const yellowbirdFetchOccurrencesByRequest = new WeakMap();",
    "  const yellowbirdBlockedConsoleOccurrences = new Map();",
    "  const yellowbirdMarkBlockedConsoleOccurrence = url => {",
    "    const pending = yellowbirdBlockedConsoleOccurrences.get(url) || [];",
    "    pending.push(Date.now());",
    "    yellowbirdBlockedConsoleOccurrences.set(url, pending);",
    "  };",
    "  const yellowbirdConsumeBlockedConsoleOccurrence = url => {",
    "    const now = Date.now();",
    "    const pending = (yellowbirdBlockedConsoleOccurrences.get(url) || [])",
    "      .filter(timestamp => now - timestamp <= 2000);",
    "    const matched = pending.shift() !== undefined;",
    "    if (pending.length) yellowbirdBlockedConsoleOccurrences.set(url, pending);",
    "    else yellowbirdBlockedConsoleOccurrences.delete(url);",
    "    return matched;",
    "  };",
    "  let yellowbirdAgentViolation = null;",
    "  page.context().on(\"page\", relatedPage => {",
    "    if (relatedPage !== page)",
    '      yellowbirdAgentViolation ||= { kind: "related-page-created", url: "redacted" };',
    "  });",
    "  page.on(\"worker\", () => {",
    '    yellowbirdAgentViolation ||= { kind: "related-worker-created", url: "redacted" };',
    "  });",
    "  const yellowbirdParseFetchFailure = detail => {",
    "    const text = String(detail || \"\");",
    "    const markerIndex = text.indexOf(yellowbirdFetchFailurePrefix);",
    "    if (markerIndex < 0) return null;",
    "    try {",
    "      const failure = JSON.parse(text.slice(markerIndex + yellowbirdFetchFailurePrefix.length));",
    '      return typeof failure?.id === "string" && typeof failure?.url === "string" ? failure : null;',
    "    } catch { return null; }",
    "  };",
    "  await page.context().exposeBinding(yellowbirdFetchBindingName, (_source, candidateToken, occurrence) => {",
    "    if (candidateToken !== yellowbirdFetchBindingToken ||",
    '        typeof occurrence?.url !== "string") return null;',
    "    yellowbirdFetchOccurrenceSequence += 1;",
    "    const occurrenceId = `${yellowbirdFetchOccurrencePrefix}${yellowbirdFetchOccurrenceSequence}`;",
    "    if (occurrence.policyRejected === true)",
    "      yellowbirdBlockedFetchOccurrences.add(occurrenceId);",
    "    return occurrenceId;",
    "  });",
    '  page.on("console", (message) => {',
    "    const text = message.text();",
    "    if (text.startsWith(yellowbirdGuardPrefix)) {",
    "      try { yellowbirdAgentViolation ||= JSON.parse(text.slice(yellowbirdGuardPrefix.length)); } catch {}",
    "      return;",
    "    }",
    '    if (message.type() === "error") {',
    "      const fetchFailure = yellowbirdParseFetchFailure(text);",
    "      if (!fetchFailure && /ERR_BLOCKED_BY_CLIENT/i.test(text) &&",
    "          yellowbirdConsumeBlockedConsoleOccurrence(message.location()?.url)) return;",
    "      consoleErrors.push({",
    "        text: fetchFailure?.message || text,",
    "        fetchFailureId: fetchFailure?.id || null,",
    "        fetchFailureUrl: fetchFailure?.url || null,",
    "        location: message.location()",
    "      });",
    "    }",
    "  });",
    '  page.on("pageerror", error => {',
    "    const fetchFailure = yellowbirdParseFetchFailure(error.message);",
    "    pageErrors.push({",
    "      message: fetchFailure?.message || error.message,",
    "      fetchFailureId: fetchFailure?.id || null,",
    "      fetchFailureUrl: fetchFailure?.url || null",
    "    });",
    "  });",
    "",
    `  const yellowbirdTarget = new URL(${quoteForJavaScript(options.target)});`,
    "  const yellowbirdTargetRequestUrl = new URL(yellowbirdTarget);",
    '  yellowbirdTargetRequestUrl.hash = "";',
    `  const yellowbirdAgentMode = ${options.exploreIntent};`,
    "  const yellowbirdBlockedUrls = new Set();",
    "  const yellowbirdSameOrigin = value => {",
    "    try { return new URL(value).origin === yellowbirdTarget.origin; }",
    "    catch { return false; }",
    "  };",
    '  page.on("requestfailed", request => {',
    "    if (yellowbirdSameOrigin(request.url()) && !yellowbirdBlockedRequests.has(request))",
    "      failedRequests.push({ method: request.method(), url: request.url(), reason: request.failure()?.errorText || \"unknown\" });",
    "  });",
    '  page.on("response", response => {',
    "    if (yellowbirdSameOrigin(response.url()) && response.status() >= 400)",
    "      serverErrors.push({ status: response.status(), url: response.url() });",
    "  });",
    "  let yellowbirdAgentAction = yellowbirdAgentMode ? {",
    '    action: "visit",',
    "    requestedUrl: yellowbirdTargetRequestUrl.href,",
    "    navigationStarted: false,",
    "    navigationRequests: new Set(),",
    "    navigationWindowOpen: true",
    "  } : null;",
    `  const yellowbirdUnsafeRequest = new RegExp(${quoteForJavaScript(PROHIBITED_AGENT_ACTION_PATTERN)}, "i");`,
    "  const yellowbirdDecodeAgentText = value => {",
    "    let decoded = String(value ?? \"\");",
    "    const maximumPasses = decoded.length + 1;",
    "    for (let count = 0; count < maximumPasses; count += 1) {",
    "      let next;",
    "      try { next = decodeURIComponent(decoded); } catch { return null; }",
    "      if (next === decoded) return decoded;",
    "      decoded = next;",
    "    }",
    "    return null;",
    "  };",
    "  const yellowbirdCanonicalizeAgentText = value => String(value ?? \"\")",
    '    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")',
    '    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")',
    '    .replaceAll(/([A-Za-z])([0-9])/g, "$1 $2")',
    '    .replaceAll(/([0-9])([A-Za-z])/g, "$1 $2");',
    "  const yellowbirdDecodeAgentUrlText = url => {",
    "    const components = [",
    "      yellowbirdDecodeAgentText(url.pathname),",
    '      yellowbirdDecodeAgentText(url.search.replaceAll("+", " ")),',
    "      yellowbirdDecodeAgentText(url.hash)",
    "    ];",
    "    return components.some(component => component === null) ? null : components.join(\"\");",
    "  };",
    "  const yellowbirdAgentUrlAllowed = value => {",
    "    try {",
    "      const url = new URL(value);",
    "      const decoded = yellowbirdDecodeAgentUrlText(url);",
    '      return ["http:", "https:"].includes(url.protocol) &&',
    "        url.origin === yellowbirdTarget.origin && !url.username && !url.password &&",
    "        decoded !== null && !yellowbirdUnsafeRequest.test(yellowbirdCanonicalizeAgentText(decoded));",
    "    } catch { return false; }",
    "  };",
    "  await page.context().addInitScript(({ authorizedOrigin, controlName, controlToken, fetchBindingName, fetchBindingToken, fetchFailurePrefix, fetchOccurrenceHeader, fetchOccurrencePrefix, guardPrefix, prohibitedPattern, startActive }) => {",
    "    const prohibited = new RegExp(prohibitedPattern, \"i\");",
    "    const canonicalizeSemanticText = value => String(value ?? \"\")",
    '      .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")',
    '      .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")',
    '      .replaceAll(/([A-Za-z])([0-9])/g, "$1 $2")',
    '      .replaceAll(/([0-9])([A-Za-z])/g, "$1 $2");',
    "    const decodeText = value => {",
    "      let decoded = String(value ?? \"\");",
    "      const maximumPasses = decoded.length + 1;",
    "      for (let count = 0; count < maximumPasses; count += 1) {",
    "        let next;",
    "        try { next = decodeURIComponent(decoded); } catch { return null; }",
    "        if (next === decoded) return decoded;",
    "        decoded = next;",
    "      }",
    "      return null;",
    "    };",
    "    const decodeUrlText = url => {",
    "      const components = [",
    "        decodeText(url.pathname),",
    '        decodeText(url.search.replaceAll("+", " ")),',
    "        decodeText(url.hash)",
    "      ];",
    "      return components.some(component => component === null) ? null : components.join(\"\");",
    "    };",
    "    const urlAllowed = value => {",
    "      try {",
    "        const url = new URL(value, globalThis.location.href);",
    "        const decoded = decodeUrlText(url);",
    '        return ["http:", "https:"].includes(url.protocol) &&',
    "          url.origin === authorizedOrigin && !url.username && !url.password &&",
    "          decoded !== null && !prohibited.test(canonicalizeSemanticText(decoded));",
    "      } catch { return false; }",
    "    };",
    "    const active = Boolean(startActive);",
    '    let action = startActive ? "visit" : null;',
    "    const emit = globalThis.console.debug.bind(globalThis.console);",
    "    Object.defineProperty(globalThis, controlName, {",
    "      configurable: false,",
    "      writable: false,",
    "      value: (candidateToken, nextAction) => {",
    "        if (candidateToken !== controlToken) return false;",
    '        if (!["idle", "visit", "fill", "select", "click"].includes(nextAction)) return false;',
    "        action = nextAction;",
    "        return true;",
    "      }",
    "    });",
    "    const blocked = (kind, url = globalThis.location.href) => {",
    "      if (!active) return false;",
    "      emit(`${guardPrefix}${JSON.stringify({ kind, url })}`);",
    "      return true;",
    "    };",
    "    const observeCurrentUrl = () => {",
    '      if (active && !urlAllowed(globalThis.location.href)) blocked("prohibited-navigation");',
    "    };",
    "    const originalFetch = globalThis.fetch.bind(globalThis);",
    "    const recordFetchOccurrence = globalThis[fetchBindingName].bind(globalThis);",
    "    globalThis.fetch = async function (input, init) {",
    "      let requestUrl = null;",
    "      let occurrenceId = null;",
    "      let requestInput = input;",
    "      let requestInit = init;",
    "      let request = null;",
    "      try {",
    "        request = new Request(input, init);",
    "        requestUrl = request.url;",
    "      } catch {}",
    "      if (active && request) {",
    '        const localResource = requestUrl.startsWith("data:") || requestUrl.startsWith("blob:");',
    '        const policyRejected = !localResource && (!["GET", "HEAD"].includes(request.method) ||',
    '          !urlAllowed(requestUrl) || action !== "visit");',
    "        occurrenceId = await recordFetchOccurrence(fetchBindingToken, { url: requestUrl, policyRejected });",
    '        if (typeof occurrenceId === "string" && occurrenceId.startsWith(fetchOccurrencePrefix)) {',
    "          if (!policyRejected) {",
    "            const headers = new Headers(request.headers);",
    "            headers.set(fetchOccurrenceHeader, occurrenceId);",
    "            requestInput = new Request(request, { headers });",
    "            requestInit = undefined;",
    "          }",
    "        } else occurrenceId = null;",
    "      }",
    "      try {",
    "        return await originalFetch(requestInput, requestInit);",
    "      } catch (error) {",
    "        if (!active || !requestUrl || !occurrenceId) throw error;",
    '        const message = error instanceof Error ? error.message : String(error || "Failed to fetch");',
    "        throw new TypeError(`${fetchFailurePrefix}${JSON.stringify({ id: occurrenceId, url: requestUrl, message })}`);",
    "      }",
    "    };",
    '    globalThis.addEventListener("submit", event => {',
    '      if (!blocked("form-submission")) return;',
    "      event.preventDefault();",
    "      event.stopImmediatePropagation();",
    "    }, true);",
    '    for (const method of ["submit", "requestSubmit"]) {',
    "      const original = HTMLFormElement.prototype[method];",
    '      if (typeof original !== "function") continue;',
    "      Object.defineProperty(HTMLFormElement.prototype, method, {",
    "        configurable: false,",
    "        writable: false,",
    "        value: function (...args) {",
    '          if (blocked("form-submission")) return undefined;',
    "          return original.apply(this, args);",
    "        }",
    "      });",
    "    }",
    '    for (const method of ["pushState", "replaceState"]) {',
    "      const original = History.prototype[method];",
    "      Object.defineProperty(History.prototype, method, {",
    "        configurable: false,",
    "        writable: false,",
    "        value: function (...args) {",
    '          if (active && action !== "visit") { blocked("non-visit-navigation"); return undefined; }',
    "          const nextUrl = args[2] === undefined ? globalThis.location.href : new URL(args[2], globalThis.location.href).href;",
    '          if (active && !urlAllowed(nextUrl)) { blocked("prohibited-navigation", nextUrl); return undefined; }',
    "          return original.apply(this, args);",
    "        }",
    "      });",
    "    }",
    '    globalThis.addEventListener("hashchange", observeCurrentUrl);',
    '    globalThis.addEventListener("popstate", observeCurrentUrl);',
    `  }, { authorizedOrigin: yellowbirdTarget.origin, controlName: yellowbirdGuardControlName, controlToken: yellowbirdGuardControlToken, fetchBindingName: yellowbirdFetchBindingName, fetchBindingToken: yellowbirdFetchBindingToken, fetchFailurePrefix: yellowbirdFetchFailurePrefix, fetchOccurrenceHeader: yellowbirdFetchOccurrenceHeader, fetchOccurrencePrefix: yellowbirdFetchOccurrencePrefix, guardPrefix: yellowbirdGuardPrefix, prohibitedPattern: ${quoteForJavaScript(PROHIBITED_AGENT_ACTION_PATTERN)}, startActive: ${options.exploreIntent} });`,
    "  const yellowbirdRecordBlockedRequest = (request, ...additionalUrls) => {",
    "    const redirectChain = [];",
    "    for (let current = request; current; current = current.redirectedFrom())",
    "      redirectChain.unshift(current.url());",
    "    for (const url of [...redirectChain, ...additionalUrls])",
    "      yellowbirdBlockedUrls.add(url);",
    "    const occurrence = yellowbirdFetchOccurrencesByRequest.get(request);",
    "    if (typeof occurrence === \"string\" && occurrence.startsWith(yellowbirdFetchOccurrencePrefix))",
    "      yellowbirdBlockedFetchOccurrences.add(occurrence);",
    "    yellowbirdBlockedRequests.add(request);",
    "    yellowbirdMarkBlockedConsoleOccurrence(request.url());",
    "  };",
    "  if (yellowbirdAgentMode) {",
    "  const yellowbirdCdpRequests = new Map();",
    "  const yellowbirdCdp = await page.context().newCDPSession(page);",
    '  yellowbirdCdp.on("Fetch.requestPaused", async event => {',
    "    try {",
    "      if (event.responseErrorReason !== undefined) {",
    "        try {",
    '          await yellowbirdCdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: event.responseErrorReason });',
    "        } catch (error) {",
    "          if (!/Invalid InterceptionId/i.test(String(error?.message || error))) throw error;",
    "        }",
    "        return;",
    "      }",
    "      if (event.responseStatusCode !== undefined) {",
    "        const requestState = yellowbirdCdpRequests.get(event.requestId);",
    "        const location = event.responseHeaders?.find(header => header.name.toLowerCase() === \"location\")?.value;",
    "        if ([301, 302, 303, 307, 308].includes(event.responseStatusCode) && location && yellowbirdAgentMode) {",
    "          let redirectUrl = location;",
    "          let redirectAllowed = false;",
    "          try {",
    "            redirectUrl = new URL(location, event.request.url).href;",
    "            redirectAllowed = requestState?.allowed &&",
    "              yellowbirdAgentAction?.action === \"visit\" &&",
    "              yellowbirdAgentAction.navigationWindowOpen &&",
    '              ["GET", "HEAD"].includes(event.request.method) &&',
    "              yellowbirdAgentUrlAllowed(redirectUrl);",
          "          } catch {}",
          "          if (!redirectAllowed) {",
          "            for (const url of [...(requestState?.urls || [event.request.url]), redirectUrl])",
    "              yellowbirdBlockedUrls.add(url);",
    "            yellowbirdMarkBlockedConsoleOccurrence(event.request.url);",
    "            if (requestState?.occurrence)",
    "              yellowbirdBlockedFetchOccurrences.add(requestState.occurrence);",
          '            await yellowbirdCdp.send("Fetch.fulfillRequest", {',
          "              requestId: event.requestId, responseCode: 200,",
          '              responseHeaders: [{ name: "content-type", value: "text/plain; charset=utf-8" }, { name: "cache-control", value: "no-store" }],',
          '              body: Buffer.from("Blocked by YellowBird").toString("base64")',
          "            });",
    "            return;",
    "          }",
    "        }",
    '        await yellowbirdCdp.send("Fetch.continueResponse", { requestId: event.requestId });',
    "        return;",
    "      }",
    "      const parent = event.redirectedRequestId ? yellowbirdCdpRequests.get(event.redirectedRequestId) : null;",
    "      const occurrenceHeader = Object.entries(event.request.headers)",
    "        .find(([name]) => name.toLowerCase() === yellowbirdFetchOccurrenceHeader)?.[1];",
    "      const occurrence = parent?.occurrence ||",
    '        (typeof occurrenceHeader === "string" && occurrenceHeader.startsWith(yellowbirdFetchOccurrencePrefix)',
    "          ? occurrenceHeader : null);",
    "      const requestState = {",
    "        occurrence,",
    "        urls: [...(parent?.urls || []), event.request.url],",
    "        allowed: true",
    "      };",
    "      yellowbirdCdpRequests.set(event.requestId, requestState);",
    "      const continueRequest = { requestId: event.requestId, interceptResponse: true };",
    "      // Keep the private occurrence header until the Playwright route sees it.",
    "      // The route strips it before the request reaches the product.",
    '      await yellowbirdCdp.send("Fetch.continueRequest", continueRequest);',
    "    } catch (error) {",
    "      if (!/Target closed|Session closed/i.test(String(error?.message || error)))",
    '        yellowbirdAgentViolation ||= { kind: "network-guard-failed", url: event.request.url };',
    "    }",
    "  });",
    '  await yellowbirdCdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });',
    "  }",
    '  await page.context().route("**/*", async (route) => {',
    "    const request = route.request();",
    "    const requestUrl = request.url();",
    "    const requestMethod = request.method();",
    "    const requestHeaders = request.headers();",
    "    const occurrenceCandidate = requestHeaders[yellowbirdFetchOccurrenceHeader];",
    "    const redirectedOccurrence = request.redirectedFrom()",
    "      ? yellowbirdFetchOccurrencesByRequest.get(request.redirectedFrom()) : null;",
    "    const occurrence = typeof occurrenceCandidate === \"string\" &&",
    "      occurrenceCandidate.startsWith(yellowbirdFetchOccurrencePrefix)",
    "        ? occurrenceCandidate : redirectedOccurrence;",
    "    if (occurrence) yellowbirdFetchOccurrencesByRequest.set(request, occurrence);",
    "    const forwardedHeaders = { ...requestHeaders };",
    "    delete forwardedHeaders[yellowbirdFetchOccurrenceHeader];",
    '    const localResource = requestUrl.startsWith("data:") || requestUrl.startsWith("blob:");',
    '    if (localResource && (!yellowbirdAgentMode || request.resourceType() !== "document"))',
    "      return route.continue(typeof occurrence === \"string\" ? { headers: forwardedHeaders } : undefined);",
    "    let allowed = false;",
    "    try {",
    "      const parsedRequestUrl = new URL(requestUrl);",
    "      const safeAgentUrl = yellowbirdAgentUrlAllowed(requestUrl);",
    "      let safeAgentAction = false;",
    "      if (yellowbirdAgentAction) {",
    '        if (yellowbirdAgentAction.action !== "visit") {',
    "          safeAgentAction = false;",
    '        } else if (request.resourceType() === "document") {',
    "          const redirectedFrom = request.redirectedFrom();",
    "          if (!yellowbirdAgentAction.navigationStarted) {",
    "            safeAgentAction = requestUrl === yellowbirdAgentAction.requestedUrl;",
    "          } else {",
    "            safeAgentAction = Boolean(redirectedFrom) &&",
    "              yellowbirdAgentAction.navigationRequests.has(redirectedFrom);",
    "          }",
    "          if (safeAgentAction) {",
    "            yellowbirdAgentAction.navigationStarted = true;",
    "            yellowbirdAgentAction.navigationRequests.add(request);",
    "          }",
    "        } else safeAgentAction = yellowbirdAgentAction.navigationWindowOpen;",
    "      }",
    "      allowed = parsedRequestUrl.origin === yellowbirdTarget.origin &&",
    '        (!yellowbirdAgentMode || (["GET", "HEAD"].includes(requestMethod) && safeAgentUrl && safeAgentAction));',
    "    } catch {}",
    "    if (allowed) return route.continue(typeof occurrence === \"string\" ? { headers: forwardedHeaders } : undefined);",
    "    yellowbirdRecordBlockedRequest(request);",
    '    return route.abort("blockedbyclient");',
    "  });",
    "  const yellowbirdSocketProtocol = yellowbirdTarget.protocol === \"https:\" ? \"wss:\" : \"ws:\";",
    "  const yellowbirdSocketPort = yellowbirdTarget.port || (yellowbirdTarget.protocol === \"https:\" ? \"443\" : \"80\");",
    '  await page.context().routeWebSocket("**/*", socket => {',
    "    const url = new URL(socket.url());",
    "    const socketPort = url.port || (url.protocol === \"wss:\" ? \"443\" : \"80\");",
    "    const sameOrigin = url.protocol === yellowbirdSocketProtocol &&",
    "      url.hostname === yellowbirdTarget.hostname && socketPort === yellowbirdSocketPort;",
    "    if (!sameOrigin || yellowbirdAgentAction) {",
    "      yellowbirdBlockedUrls.add(socket.url());",
    "      return socket.close({ code: 1008, reason: \"Blocked by YellowBird exact-origin policy\" });",
    "    }",
    "    const server = socket.connectToServer();",
    "    socket.onMessage(message => {",
    "      if (yellowbirdAgentAction)",
    "        return socket.close({ code: 1008, reason: \"Blocked by YellowBird read-only agent policy\" });",
    "      server.send(message);",
    "    });",
    "  });",
    "  const yellowbirdActivateAgentGuard = async action => {",
    "    const accepted = await page.evaluate(({ action, controlName, controlToken }) =>",
    "      globalThis[controlName]?.(controlToken, action),",
    "      { action, controlName: yellowbirdGuardControlName, controlToken: yellowbirdGuardControlToken }",
    "    );",
    '    if (!accepted) throw new Error("YellowBird replay guard rejected an authenticated transition");',
    "  };",
    "  const yellowbirdBeginAgentAction = async (action, requestedUrl = null) => {",
    "    yellowbirdAgentAction = {",
    "      action,",
    "      requestedUrl,",
    "      navigationStarted: false,",
    "      navigationRequests: new Set(),",
    '      navigationWindowOpen: action === "visit"',
    "    };",
    "    await yellowbirdActivateAgentGuard(action);",
    "  };",
    "  const yellowbirdFinishAgentNavigation = async () => {",
    "    if (yellowbirdAgentAction) {",
    '      yellowbirdAgentAction.action = "idle";',
    "      yellowbirdAgentAction.requestedUrl = null;",
    "      yellowbirdAgentAction.navigationStarted = false;",
    "      yellowbirdAgentAction.navigationRequests.clear();",
    "      yellowbirdAgentAction.navigationWindowOpen = false;",
    "    }",
    '    await yellowbirdActivateAgentGuard("idle");',
    "  };",
    "  const yellowbirdRunAgentAction = async (action, requestedUrl, operation) => {",
    "    let actionFailure = null;",
    "    try {",
    "      await yellowbirdBeginAgentAction(action, requestedUrl);",
    "      return await operation();",
    "    } catch (error) {",
    "      actionFailure = error;",
    "      throw error;",
    "    } finally {",
    "      try {",
    "        await yellowbirdFinishAgentNavigation();",
    "      } catch (error) {",
    "        if (!actionFailure) throw error;",
    "      }",
    "    }",
    "  };",
    "  const yellowbirdAssertAgentGuard = async () => {",
    "    expect(yellowbirdAgentUrlAllowed(page.url())).toBe(true);",
    "    expect(yellowbirdAgentViolation).toBeNull();",
    "  };",
    "",
    "  let response;",
    ...(options.exploreIntent
      ? [
          "  let yellowbirdInitialNavigationFailure = null;",
          "  try {",
          `    response = await page.goto(yellowbirdTarget.href, { waitUntil: "domcontentloaded" });`,
          `  await page.waitForTimeout(${AGENT_NAVIGATION_SETTLEMENT_MS});`,
          "  } catch (error) {",
          "    yellowbirdInitialNavigationFailure = error;",
          "    throw error;",
          "  } finally {",
          "    try {",
          "      await yellowbirdFinishAgentNavigation();",
          "    } catch (error) {",
          "      if (!yellowbirdInitialNavigationFailure) throw error;",
          "    }",
          "  }",
          "  await page.waitForTimeout(100);",
          "  await yellowbirdAssertAgentGuard();"
        ]
      : [
          `  response = await page.goto(yellowbirdTarget.href, { waitUntil: "domcontentloaded" });`
        ]),
    `  expect(response?.status()).toBe(${options.expectedStatus});`
  ];

  if (options.expectedTitle) {
    lines.push(
      `  await expect(page).toHaveTitle(${quoteForJavaScript(options.expectedTitle)});`
    );
  }
  for (const text of options.expectedTexts) {
    lines.push(
      `  await expect(page.locator("body")).toContainText(${quoteForJavaScript(text)});`
    );
  }
  options.steps.forEach((step, index) => {
    const locator = `page.locator(${quoteForJavaScript(step.selector)})`;
    if (step.action === "click") {
      lines.push(`  await ${locator}.click();`);
    } else if (step.action === "fill" && step.valueFromEnv) {
      const variable = `yellowbirdValue${index + 1}`;
      lines.push(
        `  const ${variable} = process.env[${quoteForJavaScript(step.valueFromEnv)}];`,
        `  expect(${variable}, ${quoteForJavaScript(`Missing environment variable ${step.valueFromEnv}`)}).toBeTruthy();`,
        `  await ${locator}.fill(${variable});`
      );
    } else if (step.action === "fill") {
      lines.push(`  await ${locator}.fill(${quoteForJavaScript(step.value)});`);
    } else if (step.action === "expectText") {
      lines.push(
        `  await expect(${locator}).toContainText(${quoteForJavaScript(step.text)});`
      );
    } else if (step.action === "expectVisible") {
      lines.push(`  await expect(${locator}).toBeVisible();`);
    }
  });
  replaySteps.forEach((step, index) => {
    if (step.action === "visit") {
      const response = `yellowbirdAgentResponse${index + 1}`;
      lines.push(
        `  const ${response} = await yellowbirdRunAgentAction("visit", ${quoteForJavaScript(step.requestedUrl)}, async () => {`,
        `    const actionResponse = await page.goto(${quoteForJavaScript(step.requestedUrl)}, { waitUntil: "domcontentloaded" });`,
        `    await page.waitForTimeout(${AGENT_NAVIGATION_SETTLEMENT_MS});`,
        "    return actionResponse;",
        "  });"
      );
      if (step.status !== "invalid") {
        lines.push(
          `  await expect(page).toHaveURL(${quoteForJavaScript(step.url)});`
        );
      }
      lines.push(
        "  await page.waitForTimeout(100);",
        "  await yellowbirdAssertAgentGuard();"
      );
      if (Number.isInteger(step.httpStatus)) {
        lines.push(
          `  expect(${response}?.status()).toBeLessThan(400);`
        );
      }
      return;
    }
    lines.push(
      `  await yellowbirdRunAgentAction(${quoteForJavaScript(step.action)}, ${quoteForJavaScript(step.requestedUrl)}, async () => {`
    );
    if (
      !step.locator ||
      !Number.isInteger(step.locator.ordinal) ||
      !Number.isInteger(step.locator.matchCount) ||
      step.locator.ordinal < 0 ||
      step.locator.matchCount <= step.locator.ordinal
    ) {
      throw new Error(`agent replay step ${step.id} has no verified locator`);
    }
    const locator =
      step.locator?.kind === "css"
        ? `page.locator(${quoteForJavaScript(step.locator.selector)})`
        : `page.getByRole(${quoteForJavaScript(step.locator?.role)}, { name: ${quoteForJavaScript(step.locator?.name)}, exact: true })`;
    const locatorVariable = `yellowbirdAgentLocator${index + 1}`;
    lines.push(
      `  const ${locatorVariable} = ${locator};`,
      `  await expect(${locatorVariable}).toHaveCount(${step.locator.matchCount});`
    );
    const selectedLocator = `${locatorVariable}.nth(${step.locator.ordinal})`;
    if (step.action === "fill") {
      lines.push(
        `  await ${selectedLocator}.fill(${quoteForJavaScript(step.value)});`
      );
    } else if (step.action === "select") {
      lines.push(
        `  await ${selectedLocator}.selectOption(${quoteForJavaScript(step.value)});`
      );
    } else if (step.action === "click") {
      lines.push(`  await ${selectedLocator}.click();`);
    }
    lines.push(
      "  });",
      "  await page.waitForTimeout(250);",
      "  await yellowbirdAssertAgentGuard();"
    );
  });
  if (!options.ignoreConsoleErrors) {
    lines.push(
      "  const yellowbirdProductConsoleErrors = consoleErrors.filter(entry =>",
      "    !(entry.fetchFailureId && yellowbirdBlockedFetchOccurrences.has(entry.fetchFailureId))",
      "  );",
      "  expect(yellowbirdProductConsoleErrors).toEqual([]);"
    );
  }
  lines.push(
    "  const yellowbirdProductPageErrors = pageErrors.filter(entry =>",
    "    !(entry.fetchFailureId && yellowbirdBlockedFetchOccurrences.has(entry.fetchFailureId))",
    "  );",
    "  expect(yellowbirdProductPageErrors).toEqual([]);",
    "  expect(failedRequests).toEqual([]);",
    "  const yellowbirdSubresourceServerErrors = serverErrors.filter(entry => entry.url !== yellowbirdTarget.href);",
    "  expect(yellowbirdSubresourceServerErrors).toEqual([]);"
  );
  lines.push("});", "");
  return lines.join("\n");
}

function buildPlaywrightConfig() {
  return `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "regression.spec.js",
  reporter: "line",
  use: {
    serviceWorkers: "block"
  }
});
`;
}

function buildReplayPackage() {
  return `${JSON.stringify(
    {
      private: true,
      type: "module",
      scripts: {
        "setup:browsers": "playwright install chromium",
        test: "playwright test --config playwright.config.js"
      },
      devDependencies: {
        "@playwright/test": PLAYWRIGHT_VERSION
      }
    },
    null,
    2
  )}\n`;
}

async function finalizeRun(state) {
  const {
    authorization,
    blockedRequests,
    consoleErrors,
    diagnosticEvents,
    failedRequests,
    interactiveElements,
    invalidWorkflowSteps,
    options,
    outputDirectory,
    pageErrors,
    record,
    reportPath,
    requestedAuthorization,
    runId,
    serverErrors,
    startedAt,
    targetResolution,
    workflowFindings,
    workflowSteps
  } = state;
  const blockedAgentEffects = blockedRequests.filter((request) =>
    request.reason?.startsWith("agent-")
  );
  if (
    options.exploreIntent &&
    blockedAgentEffects.length > 0 &&
    state.exploration.issue?.id !== "agent-model-transition"
  ) {
    state.exploration.status = "inconclusive";
    state.exploration.coverage = state.exploration.steps.some(
      (step) => step.status === "passed"
    )
      ? "partial"
      : "blocked";
    state.exploration.issue = {
      id: "agent-effect-blocked",
      classification: "test-mechanics",
      title: "An agent interaction attempted an unauthorized effect.",
      evidence: `${blockedAgentEffects.length} unauthorized request, navigation, submission, or message(s) blocked`,
      remediation: "Use an owner-declared scenario if this effect must be exercised."
    };
  }
  if (options.exploreIntent && state.operationalIssues.length) {
    const networkGuardIssue = state.operationalIssues.find(
      (issue) => issue.id === "browser-network-guard-failed"
    );
    const relatedTargetIssue = state.operationalIssues.find(
      (issue) => issue.id === "browser-related-target-created"
    );
    const screenshotCaptureIssue = state.operationalIssues.find(
      (issue) => issue.id === "browser-screenshot-capture-failed"
    );
    const browserCloseIssue = state.operationalIssues.find(
      (issue) => issue.id === "browser-close-failed"
    );
    const browserOperationIssue = state.operationalIssues.find(
      (issue) => issue.id === "browser-operation-failed"
    );
    state.exploration.status = "inconclusive";
    state.exploration.coverage = state.exploration.steps.some(
      (step) => step.status === "passed"
    )
      ? "partial"
      : "blocked";
    state.exploration.summary = networkGuardIssue
      ? "Intent coverage could not be trusted because a browser safety guard failed."
      : relatedTargetIssue
        ? "Intent coverage could not be trusted because a related browser target was created."
        : screenshotCaptureIssue
          ? "Intent coverage was inconclusive because visual evidence capture failed."
          : browserCloseIssue
            ? "Intent coverage was inconclusive because browser cleanup could not be confirmed."
            : browserOperationIssue
              ? "Intent coverage was inconclusive because browser execution stopped before evidence collection completed."
              : "Intent coverage could not begin because browser setup did not complete.";
    state.exploration.issue ||= state.operationalIssues[0];
  }
  const findings = [];
  const setupIssues = [];
  if (!state.browserLaunch.successful) {
    setupIssues.push({
      id: state.browserLaunch.diagnostic.code,
      classification: "test-mechanics",
      title: state.browserLaunch.diagnostic.message,
      evidence: state.browserLaunch.diagnostic.detail,
      remediation: state.browserLaunch.diagnostic.remediation
    });
  } else if (state.networkGuardReady && state.navigationError) {
    setupIssues.push({
      id: state.navigationDiagnostic.code,
      classification: "test-mechanics",
      title: state.navigationDiagnostic.message,
      evidence: state.navigationDiagnostic.detail,
      remediation: state.navigationDiagnostic.remediation
    });
  } else if (
    state.networkGuardReady &&
    state.status !== options.expectedStatus
  ) {
    findings.push({
      id: "unexpected-status",
      severity: state.status && state.status >= 500 ? "high" : "medium",
      title: `Expected HTTP ${options.expectedStatus}, received ${state.status}`,
      evidence: options.target
    });
  }
  if (state.exploration.issue) {
    setupIssues.push(state.exploration.issue);
  }
  setupIssues.push(
    ...state.operationalIssues.filter(
      (issue) => issue !== state.exploration.issue
    )
  );

  const productEvaluated =
    state.browserLaunch.successful &&
    state.networkGuardReady &&
    !state.navigationError;
  if (
    productEvaluated &&
    options.expectedTitle &&
    state.assertionTitle !== options.expectedTitle
  ) {
    findings.push({
      id: "title-mismatch",
      severity: "medium",
      title: "Page title did not match the owner assertion",
      evidence: `expected ${JSON.stringify(options.expectedTitle)}, received ${JSON.stringify(state.assertionTitle)}`
    });
  }
  for (const text of productEvaluated ? options.expectedTexts : []) {
    if (!state.assertionBodyText.includes(text)) {
      findings.push({
        id: "missing-text",
        severity: "medium",
        title: "Expected page text was not present",
        evidence: JSON.stringify(text)
      });
    }
  }
  const productConsoleErrors = consoleErrors;
  if (
    productEvaluated &&
    !options.ignoreConsoleErrors &&
    productConsoleErrors.length
  ) {
    findings.push({
      id: "console-errors",
      severity: "medium",
      title: `${productConsoleErrors.length} browser console error(s) observed`,
      evidence: productConsoleErrors
        .map((entry) => entry.text)
        .join("; ")
        .slice(0, 500)
    });
  }
  if (productEvaluated && pageErrors.length) {
    findings.push({
      id: "page-errors",
      severity: "high",
      title: `${pageErrors.length} uncaught page exception(s) observed`,
      evidence: pageErrors.map((entry) => entry.message).join("; ").slice(0, 500)
    });
  }
  if (productEvaluated && failedRequests.length) {
    findings.push({
      id: "failed-requests",
      severity: "medium",
      title: `${failedRequests.length} same-origin request(s) failed`,
      evidence: failedRequests.map((entry) => entry.url).join("; ").slice(0, 500)
    });
  }
  const subresourceServerErrors = serverErrors.filter(
    (entry) => entry.url !== options.target
  );
  if (productEvaluated && subresourceServerErrors.length) {
    findings.push({
      id: "http-errors",
      severity: subresourceServerErrors.some((entry) => entry.status >= 500)
        ? "high"
        : "medium",
      title: `${subresourceServerErrors.length} same-origin request(s) returned HTTP errors`,
      evidence: subresourceServerErrors
        .map((entry) => `${entry.status} ${entry.url}`)
        .join("; ")
        .slice(0, 500)
    });
  }
  findings.push(...workflowFindings);

  const coverageGaps = [
    "No model or agent made pass/fail decisions. Findings come from explicit assertions and runtime signals."
  ];
  if (options.steps.length) {
    coverageGaps.push(
      `Only the ${options.steps.length} owner-declared workflow step(s) were exercised; YellowBird did not explore beyond them.`
    );
  } else if (options.exploreIntent) {
    if (state.exploration.status === "completed") {
      coverageGaps.push(
        `The agent exercised ${state.exploration.steps.length} bounded safe same-origin interaction step(s); form submission, mutation, authentication, and cross-origin behavior were not authorized.`
      );
    } else {
      coverageGaps.push(
        "The requested intent was not fully exercised; consult the intent-exploration status and remediation."
      );
    }
  } else {
    coverageGaps.push(
      "This alpha inspected only the initial page load; it did not autonomously exercise workflows."
    );
  }
  if (interactiveElements.length) {
    coverageGaps.push(
      `${interactiveElements.length} interactive element(s) were inventoried; undeclared interactions were not exercised.`
    );
  }
  if (invalidWorkflowSteps.length) {
    coverageGaps.push(
      `${invalidWorkflowSteps.length} workflow action(s) were invalid. YellowBird did not attempt selector healing.`
    );
  }
  if (
    state.operationalIssues.some(
      (issue) => issue.id === "browser-screenshot-capture-failed"
    )
  ) {
    coverageGaps.push(
      "Visual evidence was unavailable because browser screenshot capture failed."
    );
  }
  if (
    state.operationalIssues.some((issue) => issue.id === "browser-close-failed")
  ) {
    coverageGaps.push(
      "Browser cleanup could not be confirmed after product evaluation."
    );
  }
  if (
    state.operationalIssues.some(
      (issue) => issue.id === "browser-operation-failed"
    )
  ) {
    coverageGaps.push(
      "Browser execution stopped before all requested evidence could be collected."
    );
  }
  if (!productEvaluated) {
    const browserContextFailed = state.operationalIssues.some(
      (issue) => issue.id === "browser-context-creation-failed"
    );
    coverageGaps.push(
      browserContextFailed
        ? "The product was not evaluated because an isolated browser context could not be created."
        : state.browserLaunch.successful
          ? "The product was not evaluated because initial navigation did not complete."
          : "The product was not evaluated because the browser was unavailable."
    );
  }
  const blockedCrossOrigin = blockedRequests.filter(
    (request) => request.reason === "cross-origin"
  );
  if (blockedCrossOrigin.length) {
    coverageGaps.push(
      `${blockedCrossOrigin.length} cross-origin request(s) were blocked by the exact-origin network policy.`
    );
  }
  if (blockedAgentEffects.length) {
    coverageGaps.push(
      `${blockedAgentEffects.length} unauthorized effect(s) were blocked during agent exploration.`
    );
  }

  const outcome = findings.length
    ? "attention"
    : setupIssues.length || invalidWorkflowSteps.length
      ? "inconclusive"
      : "clear";
  record("info", "run.completed", `Scout completed with outcome ${outcome}`, {
    outcome,
    findingCount: findings.length,
    setupIssueCount: setupIssues.length,
    invalidWorkflowStepCount: invalidWorkflowSteps.length
  });
  const report = {
    schema: "yellowbird.scout-evidence.v2",
    outcome,
    intent: options.intent,
    permissions: options.permissions,
    run: {
      id: runId,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime()
    },
    target: {
      requestedUrl: requestedAuthorization.target,
      url: options.target,
      origin: authorization.origin,
      authorization: authorization.authorization,
      repairs: targetResolution.repairs
    },
    assertions: {
      expectedStatus: options.expectedStatus,
      expectedTitle: options.expectedTitle,
      expectedTexts: options.expectedTexts,
      consoleErrorsAllowed: options.ignoreConsoleErrors
    },
    findings,
    invalidTestMechanics: [
      ...setupIssues,
      ...invalidWorkflowSteps.map((step) => ({
        id: step.id,
        classification: "test-mechanics",
        title: `Workflow action was invalid: ${step.id}`,
        evidence: step.evidence,
        remediation:
          "Confirm the selector and declared capability. Selector healing was not attempted."
      }))
    ],
    observations: {
      status: state.status,
      title: state.title,
      browser: {
        launch: {
          successful: state.browserLaunch.successful,
          diagnostic: state.browserLaunch.diagnostic
        }
      },
      navigation: {
        completed: productEvaluated,
        status: state.browserLaunch.successful
          ? !state.networkGuardReady
            ? "skipped"
            : state.navigationError
              ? "failed"
              : "completed"
          : "skipped",
        reason: !state.browserLaunch.successful
          ? "browser-unavailable"
          : state.operationalIssues.some(
                (issue) => issue.id === "browser-context-creation-failed"
              )
            ? "browser-context-unavailable"
            : !state.networkGuardReady
              ? "network-guard-unavailable"
              : null,
        diagnostic: state.navigationDiagnostic
      },
      interactiveElements,
      consoleErrors,
      pageErrors,
      failedRequests,
      blockedRequests,
      serverErrors,
      workflowSteps,
      exploration: state.exploration
    },
    coverageGaps,
    artifacts: {
      evidence: join(outputDirectory, "evidence.json"),
      report: reportPath,
      screenshot: state.screenshotCaptured
        ? join(outputDirectory, "page.png")
        : null,
      regression: join(outputDirectory, "regression.spec.js"),
      playwrightConfig: join(outputDirectory, "playwright.config.js"),
      replayPackage: join(outputDirectory, "package.json"),
      diagnostics: join(outputDirectory, "diagnostics.jsonl")
    },
    provenance: {
      runner: "yellowbird-local-scout",
      runtime: process.versions.bun
        ? `Bun ${process.versions.bun}`
        : `Node ${process.versions.node}`,
      browser: "Playwright Chromium",
      agenticEngine: state.exploration.engine,
      ...(state.exploration.provenance
        ? { engine: state.exploration.provenance }
        : {})
    }
  };

  const writtenArtifacts = [
    report.artifacts.evidence,
    report.artifacts.report,
    report.artifacts.regression,
    report.artifacts.playwrightConfig,
    report.artifacts.replayPackage,
    report.artifacts.diagnostics
  ];
  await Promise.all([
    writeFile(
      report.artifacts.evidence,
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 }
    ),
    writeFile(report.artifacts.report, buildMarkdown(report), { mode: 0o600 }),
    writeFile(
      report.artifacts.regression,
      buildRegression(options, state.exploration.steps),
      {
        mode: 0o600
      }
    ),
    writeFile(report.artifacts.playwrightConfig, buildPlaywrightConfig(), {
      mode: 0o600
    }),
    writeFile(report.artifacts.replayPackage, buildReplayPackage(), {
      mode: 0o600
    }),
    writeFile(report.artifacts.diagnostics, diagnosticsJsonl(diagnosticEvents), {
      mode: 0o600
    })
  ]);
  if (report.artifacts.screenshot) writtenArtifacts.push(report.artifacts.screenshot);
  await Promise.all(writtenArtifacts.map((path) => chmod(path, 0o600)));
  return report;
}

export function createScoutRunner({
  launchBrowser,
  resolveEngine = resolveAgentEngine
} = {}) {
  if (typeof launchBrowser !== "function") {
    throw new TypeError("createScoutRunner requires a launchBrowser function");
  }
  if (typeof resolveEngine !== "function") {
    throw new TypeError("createScoutRunner requires a resolveEngine function");
  }
  return async function runScoutWithBrowser(input) {
    const requestedAuthorization = authorizeScoutTarget(input.target);
    const workflow = validateWorkflow({
      permissions: input.permissions,
      steps: input.steps
    });
  if (
    input.intent !== undefined &&
    (typeof input.intent !== "string" || !input.intent.trim())
  ) {
    throw new Error("scout intent must be a non-empty string");
  }
  const hasExplicitIntent = typeof input.intent === "string";
  const exploreIntent =
    input.exploreIntent === undefined
      ? workflow.steps.length === 0 && hasExplicitIntent
      : Boolean(input.exploreIntent);
  if (exploreIntent && workflow.steps.length) {
    throw new Error(
      "intent exploration cannot be combined with declared workflow steps"
    );
  }
  const maxAgentSteps = Number(input.maxAgentSteps ?? 4);
  if (!Number.isInteger(maxAgentSteps) || maxAgentSteps < 1 || maxAgentSteps > 20) {
    throw new Error("max agent steps must be an integer from 1 to 20");
  }
  const runId = `scout_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const outputDirectory = resolve(
    input.outputDirectory || join(".yellowbird", "scout", runId)
  );
  const reportPath = resolve(input.reportPath || join(outputDirectory, "report.md"));
  const timeoutMs = Number(input.timeoutMs ?? 15_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeout must be a positive number of milliseconds");
  }

  const expectedStatus = Number(input.expectedStatus ?? 200);
  if (
    !Number.isInteger(expectedStatus) ||
    expectedStatus < 100 ||
    expectedStatus > 599
  ) {
    throw new Error("expected status must be a valid HTTP status code");
  }
  if (exploreIntent) {
    validateAgentEngineConfig({
      baseUrl: input.engineBaseUrl,
      model: input.engineModel,
      timeoutMs: Math.max(timeoutMs, 120_000)
    });
  }

  const startedAt = new Date();
  const { events: diagnosticEvents, record } = createDiagnosticRecorder(
    input.onDiagnostic,
    { runId }
  );
  record("info", "run.started", "YellowBird scout started", {
    runId,
    ...diagnosticUrl(requestedAuthorization.target)
  });
  const targetResolution = await resolveLoopbackScheme(
    requestedAuthorization.target,
    Math.max(100, Math.min(timeoutMs, 2_000)),
    record,
    exploreIntent
      ? (candidate) => {
          const candidateUrl = new URL(candidate);
          if (!isAgentUrlAllowed(candidateUrl.href, candidateUrl.origin)) {
            throw new Error(
              "intent exploration target contains a prohibited action"
            );
          }
        }
      : undefined
  );
  const authorization = authorizeScoutTarget(targetResolution.effectiveTarget);
  record("info", "target.authorized", "Authorized the effective loopback target", {
    origin: authorization.origin,
    method: authorization.authorization.method,
    scope: authorization.authorization.scope
  });
  const options = {
    target: authorization.target,
    intent: hasExplicitIntent
      ? input.intent.trim()
      : "Verify that the initial page is healthy",
    expectedStatus,
    expectedTitle: input.expectedTitle || null,
    expectedTexts: input.expectedTexts || [],
    permissions: workflow.permissions,
    steps: workflow.steps,
    exploreIntent,
    maxAgentSteps,
    engineBaseUrl: input.engineBaseUrl,
    engineModel: input.engineModel,
    ignoreConsoleErrors: Boolean(input.ignoreConsoleErrors),
    headed: Boolean(input.headed),
    timeoutMs
  };

  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);

  const state = {
    requestedAuthorization,
    targetResolution,
    authorization,
    options,
    runId,
    outputDirectory,
    reportPath,
    startedAt,
    diagnosticEvents,
    record,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    blockedRequests: [],
    serverErrors: [],
    workflowSteps: [],
    workflowFindings: [],
    invalidWorkflowSteps: [],
    operationalIssues: [],
    exploration: {
      requested: exploreIntent,
      mode: exploreIntent ? "agent-safe-interaction" : "not-requested",
      status: exploreIntent ? "pending" : "not-requested",
      coverage: exploreIntent ? "pending" : "not-requested",
      summary: "",
      steps: [],
      pages: [],
      verification: null,
      engine: null,
      capabilities: null,
      provenance: null,
      issue: null
    },
    browserLaunch: { successful: false, diagnostic: null },
    networkGuardReady: false,
    navigationError: null,
    navigationDiagnostic: null,
    status: null,
    assertionTitle: "",
    assertionBodyText: "",
    title: "",
    bodyText: "",
    interactiveElements: [],
    screenshotCaptured: false
  };
  const {
    blockedRequests,
    consoleErrors,
    failedRequests,
    invalidWorkflowSteps,
    pageErrors,
    serverErrors,
    workflowFindings,
    workflowSteps
  } = state;
  const noteNetworkGuardFailure = (error, stage) => {
    const detail = sanitizeDiagnosticText(error?.message || error);
    if (
      !state.operationalIssues.some(
        (issue) => issue.id === "browser-network-guard-failed"
      )
    ) {
      state.operationalIssues.push({
        id: "browser-network-guard-failed",
        classification: "test-mechanics",
        title: "The browser network safety guard failed.",
        evidence: detail,
        remediation:
          "Rerun the scout. If the guard fails again, report the diagnostics and use an owner-declared scenario."
      });
    }
    record(
      "error",
      "browser.network-guard.failed",
      "The browser network safety guard failed",
      { detail, stage }
    );
  };
  const initializeNetworkGuard = async (stage, operation) => {
    try {
      return { successful: true, value: await operation() };
    } catch (error) {
      noteNetworkGuardFailure(error, stage);
      return { successful: false, value: null };
    }
  };
  const noteScreenshotCaptureFailure = (error) => {
    const detail = sanitizeDiagnosticText(error?.message || error);
    state.operationalIssues.push({
      id: "browser-screenshot-capture-failed",
      classification: "test-mechanics",
      title: "YellowBird could not capture visual evidence.",
      evidence: detail,
      remediation:
        "Rerun the scout. If screenshot capture fails again, inspect the browser diagnostics."
    });
    record(
      "error",
      "browser.screenshot.failed",
      "Browser screenshot capture failed",
      { detail }
    );
  };
  const noteBrowserCloseFailure = (error) => {
    const detail = sanitizeDiagnosticText(error?.message || error);
    if (
      !state.operationalIssues.some(
        (issue) => issue.id === "browser-close-failed"
      )
    ) {
      state.operationalIssues.push({
        id: "browser-close-failed",
        classification: "test-mechanics",
        title: "YellowBird could not confirm browser cleanup.",
        evidence: detail,
        remediation:
          "Rerun the scout. If browser cleanup fails again, inspect the diagnostics and stop any orphaned browser process."
      });
    }
    record(
      "error",
      "browser.close.failed",
      "Playwright Chromium cleanup failed",
      { detail }
    );
  };
  const noteBrowserOperationFailure = (error) => {
    const detail = sanitizeDiagnosticText(error?.message || error);
    state.operationalIssues.push({
      id: "browser-operation-failed",
      classification: "test-mechanics",
      title: "YellowBird could not complete browser execution.",
      evidence: detail,
      remediation:
        "Rerun the scout. If browser execution fails again, inspect the browser and action-policy diagnostics."
    });
    record(
      "error",
      "browser.operation.failed",
      "Browser execution stopped before evidence collection completed",
      { detail }
    );
  };

  record("debug", "browser.launch.started", "Launching Playwright Chromium", {
    headed: options.headed
  });
  let browser;
  try {
    browser = await launchBrowser({
      headless: !options.headed,
      timeout: options.timeoutMs
    });
    state.browserLaunch.successful = true;
    record("info", "browser.launch.completed", "Playwright Chromium launched");
  } catch (error) {
    state.browserLaunch.diagnostic = diagnoseBrowserLaunchError(
      error?.message || error
    );
    record(
      "error",
      "browser.launch.failed",
      state.browserLaunch.diagnostic.message,
      state.browserLaunch.diagnostic
    );
    for (const step of options.steps) {
      workflowSteps.push({
        id: step.id,
        action: step.action,
        status: "skipped",
        evidence: "Browser unavailable",
        reason: "browser-unavailable",
        durationMs: 0
      });
    }
    if (options.exploreIntent) {
      state.exploration.status = "skipped";
      state.exploration.coverage = "blocked";
      state.exploration.summary =
        "Intent exploration was skipped because the browser was unavailable.";
    }
    return finalizeRun(state);
  }
  async function executeBrowserRun() {
    let context;
    try {
      context = await browser.newContext({
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 }
      });
    } catch (error) {
      const detail = sanitizeDiagnosticText(error?.message || error);
      const issue = {
        id: "browser-context-creation-failed",
        classification: "test-mechanics",
        title: "YellowBird could not create an isolated browser context.",
        evidence: detail,
        remediation:
          "Rerun the scout. If browser context creation fails again, inspect the diagnostics and verify the Playwright installation."
      };
      state.operationalIssues.push(issue);
      record(
        "error",
        "browser.context.failed",
        "The isolated browser context could not be created",
        { detail }
      );
      for (const step of options.steps) {
        workflowSteps.push({
          id: step.id,
          action: step.action,
          status: "skipped",
          evidence: "Browser context unavailable",
          reason: "browser-context-unavailable",
          durationMs: 0
        });
      }
      if (options.exploreIntent) {
        state.exploration.status = "skipped";
        state.exploration.coverage = "blocked";
        state.exploration.summary =
          "Intent exploration was skipped because browser setup did not complete.";
        state.exploration.issue = issue;
      }
      return;
    }
    const targetUrl = new URL(options.target);
    const targetRequestUrl = new URL(targetUrl);
    targetRequestUrl.hash = "";
    let agentNetworkPolicyActive = options.exploreIntent;
    let agentActionContext = options.exploreIntent
      ? {
          action: "visit",
          requestedUrl: targetRequestUrl.href,
          navigationStarted: false,
          navigationRequests: new Set(),
          navigationWindowOpen: true
        }
      : null;
    const agentGuardControlName = `__yellowbird_${randomUUID().replaceAll("-", "")}`;
    const agentGuardControlToken = randomUUID();
    const agentGuardPrefix = `__yellowbird_guard__${randomUUID()}:`;
    const agentFetchBindingName = `__yellowbird_${randomUUID().replaceAll("-", "")}`;
    const agentFetchBindingToken = randomUUID();
    const agentFetchOccurrencePrefix = `${randomUUID()}:`;
    const agentFetchOccurrenceHeader =
      `x-yellowbird-${randomUUID().replaceAll("-", "")}`;
    const agentFetchFailurePrefix = `__yellowbird_fetch_failure__${randomUUID()}:`;
    let agentFetchOccurrenceSequence = 0;
    const blockedAgentFetchOccurrences = new Set();
    const agentFetchRequests = new Map();
    const agentFetchOccurrencesByRequest = new WeakMap();
    const blockedPlaywrightRequests = new WeakSet();
    const blockedConsoleOccurrences = new Map();
    const agentGuardAttempts = [];
    const observedAgentGuardAttempts = new Set();
    const bindingGuard = await initializeNetworkGuard(
      "fetch-binding",
      () =>
        context.exposeBinding(
          agentFetchBindingName,
          (_source, candidateToken, occurrence) => {
            if (
              candidateToken !== agentFetchBindingToken ||
              typeof occurrence?.url !== "string"
            ) {
              return null;
            }
            agentFetchOccurrenceSequence += 1;
            const occurrenceId =
              `${agentFetchOccurrencePrefix}${agentFetchOccurrenceSequence}`;
            if (occurrence.policyRejected === true) {
              blockedAgentFetchOccurrences.add(occurrenceId);
            }
            return occurrenceId;
          }
        )
    );
    if (!bindingGuard.successful) return;
    const redirectedRequestUrls = (request) => {
      const urls = [];
      for (let current = request; current; current = current.redirectedFrom()) {
        urls.unshift(evidenceUrl(current.url()));
      }
      return urls;
    };
    const markBlockedConsoleOccurrence = (url) => {
      const pending = blockedConsoleOccurrences.get(url) || [];
      pending.push(Date.now());
      blockedConsoleOccurrences.set(url, pending);
    };
    const consumeBlockedConsoleOccurrence = (url) => {
      const now = Date.now();
      const pending = (blockedConsoleOccurrences.get(url) || []).filter(
        (timestamp) => now - timestamp <= 2_000
      );
      const matched = pending.shift() !== undefined;
      if (pending.length) blockedConsoleOccurrences.set(url, pending);
      else blockedConsoleOccurrences.delete(url);
      return matched;
    };
    const addBlockedRequest = (request, interceptedRequest = null) => {
      if (interceptedRequest) {
        markBlockedConsoleOccurrence(interceptedRequest.url());
        blockedPlaywrightRequests.add(interceptedRequest);
        const occurrence = agentFetchOccurrencesByRequest.get(interceptedRequest);
        if (occurrence) blockedAgentFetchOccurrences.add(occurrence);
      }
      const redirectChain = [
        ...(interceptedRequest
          ? redirectedRequestUrls(interceptedRequest)
          : []),
        request.requestUrl,
        request.url
      ].filter(Boolean);
      blockedRequests.push({
        ...request,
        redirectChain: [...new Set(redirectChain)]
      });
    };
    const parseAgentFetchFailure = (detail) => {
      const text = String(detail || "");
      const markerIndex = text.indexOf(agentFetchFailurePrefix);
      if (markerIndex < 0) return null;
      try {
        const failure = JSON.parse(
          text.slice(markerIndex + agentFetchFailurePrefix.length)
        );
        return typeof failure?.id === "string" &&
          typeof failure?.url === "string"
          ? failure
          : null;
      } catch {
        return null;
      }
    };
    const enqueueAgentGuardAttempt = (attempt) => {
      if (
        !attempt ||
        typeof attempt.kind !== "string" ||
        typeof attempt.url !== "string"
      ) {
        return;
      }
      const key = `${attempt.kind}\n${attempt.url}`;
      if (observedAgentGuardAttempts.has(key)) return;
      observedAgentGuardAttempts.add(key);
      agentGuardAttempts.push(attempt);
    };
    const websocketGuard = await initializeNetworkGuard(
      "websocket-policy",
      () => context.routeWebSocket("**/*", async (socket) => {
      try {
      const socketUrl = new URL(socket.url());
      const expectedProtocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
      const expectedPort =
        targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80");
      const socketPort =
        socketUrl.port || (socketUrl.protocol === "wss:" ? "443" : "80");
      const sameOrigin =
        socketUrl.protocol === expectedProtocol &&
        socketUrl.hostname === targetUrl.hostname &&
        socketPort === expectedPort;
      const agentSocketUrl = new URL(socketUrl.href);
      agentSocketUrl.protocol = targetUrl.protocol;
      const agentSocketAllowed = isAgentUrlAllowed(
        agentSocketUrl.href,
        authorization.origin
      );
      if (!sameOrigin || agentNetworkPolicyActive) {
        const reason = !sameOrigin
          ? agentNetworkPolicyActive
            ? "agent-cross-origin"
            : "cross-origin"
          : agentSocketAllowed
            ? "agent-websocket"
            : "agent-prohibited-url";
        addBlockedRequest({
          method: "WEBSOCKET",
          resourceType: "websocket",
          url: evidenceUrl(socket.url()),
          reason
        });
        record("warn", "network.websocket.blocked", "Blocked a WebSocket outside policy", {
          ...diagnosticUrl(socket.url()),
          reason
        });
        await socket.close({
          code: 1008,
          reason: "Blocked by YellowBird exact-origin policy"
        });
        return;
      }
      const serverSocket = socket.connectToServer();
      socket.onMessage(async (message) => {
        if (!agentNetworkPolicyActive) {
          serverSocket.send(message);
          return;
        }
        addBlockedRequest({
          method: "WEBSOCKET",
          resourceType: "websocket",
          url: evidenceUrl(socket.url()),
          reason: "agent-websocket-message"
        });
        record(
          "warn",
          "network.websocket.blocked",
          "Blocked a WebSocket message during agent exploration",
          { ...diagnosticUrl(socket.url()), reason: "agent-websocket-message" }
        );
        await socket.close({
          code: 1008,
          reason: "Blocked by YellowBird read-only agent policy"
        });
      });
      } catch (error) {
        noteNetworkGuardFailure(error, "websocket-policy-runtime");
        await socket.close({
          code: 1011,
          reason: "YellowBird network guard failed"
        }).catch(() => {});
      }
      })
    );
    if (!websocketGuard.successful) return;

    const requestGuard = await initializeNetworkGuard(
      "request-policy",
      () => context.route("**/*", async (route) => {
      try {
      const requestUrl = route.request().url();
      const requestMethod = route.request().method();
      const requestHeaders = route.request().headers();
      const occurrenceCandidate = requestHeaders[agentFetchOccurrenceHeader];
      const redirectedOccurrence = route.request().redirectedFrom()
        ? agentFetchOccurrencesByRequest.get(route.request().redirectedFrom())
        : null;
      const fetchOccurrence =
        typeof occurrenceCandidate === "string" &&
        occurrenceCandidate.startsWith(agentFetchOccurrencePrefix)
          ? occurrenceCandidate
          : redirectedOccurrence;
      const forwardedHeaders = { ...requestHeaders };
      delete forwardedHeaders[agentFetchOccurrenceHeader];
      if (fetchOccurrence) {
        agentFetchRequests.set(fetchOccurrence, route.request());
        agentFetchOccurrencesByRequest.set(route.request(), fetchOccurrence);
      }
      let requestOrigin;
      try {
        requestOrigin = new URL(requestUrl).origin;
      } catch {
        requestOrigin = "";
      }

      const localResource =
        requestUrl.startsWith("data:") || requestUrl.startsWith("blob:");
      const sameOrigin = requestOrigin === authorization.origin;
      const agentReadAllowed = ["GET", "HEAD"].includes(requestMethod);
      const agentUrlAllowed = isAgentUrlAllowed(
        requestUrl,
        authorization.origin
      );
      let agentActionAllowed = false;
      if (agentNetworkPolicyActive && agentActionContext && !localResource) {
        if (agentActionContext.action !== "visit") {
          agentActionAllowed = false;
        } else if (route.request().resourceType() === "document") {
          const redirectedFrom = route.request().redirectedFrom();
          if (!agentActionContext.navigationStarted) {
            agentActionAllowed = requestUrl === agentActionContext.requestedUrl;
          } else {
            agentActionAllowed =
              Boolean(redirectedFrom) &&
              agentActionContext.navigationRequests.has(redirectedFrom);
          }
          if (agentActionAllowed) {
            agentActionContext.navigationStarted = true;
            agentActionContext.navigationRequests.add(route.request());
          }
        } else {
          agentActionAllowed = agentActionContext.navigationWindowOpen;
        }
      }
      if (
        (localResource &&
          (!agentNetworkPolicyActive ||
            route.request().resourceType() !== "document")) ||
        (sameOrigin &&
          (!agentNetworkPolicyActive ||
            (agentReadAllowed && agentUrlAllowed && agentActionAllowed)))
      ) {
        await route.continue(
          fetchOccurrence ? { headers: forwardedHeaders } : undefined
        );
        return;
      }

      let reason = "agent-non-read-method";
      if (!sameOrigin) {
        reason = agentNetworkPolicyActive
          ? "agent-cross-origin"
          : "cross-origin";
      } else if (agentReadAllowed && !agentUrlAllowed) {
        reason = "agent-prohibited-url";
      } else if (agentReadAllowed && agentActionContext?.action === "visit") {
        reason =
          route.request().resourceType() === "document"
            ? "agent-navigation-outside-visit"
            : "agent-active-request";
      } else if (agentReadAllowed) {
        reason = "agent-non-visit-request";
      }
      addBlockedRequest(
        {
          method: requestMethod,
          resourceType: route.request().resourceType(),
          url: evidenceUrl(requestUrl),
          reason
        },
        route.request()
      );
      record("warn", "network.request.blocked", "Blocked a request outside policy", {
        method: requestMethod,
        resourceType: route.request().resourceType(),
        reason,
        ...diagnosticUrl(requestUrl)
      });
      await route.abort("blockedbyclient");
      } catch (error) {
        if (!/Target closed|Session closed/i.test(String(error?.message || error))) {
          noteNetworkGuardFailure(error, "request-policy-runtime");
        }
        await route.abort("failed").catch(() => {});
      }
      })
    );
    if (!requestGuard.successful) return;

    const pageGuard = await initializeNetworkGuard(
      "page-policy",
      () => context.addInitScript(({
      authorizedOrigin,
      controlName,
      controlToken,
      fetchBindingName,
      fetchBindingToken,
      fetchFailurePrefix,
      fetchOccurrenceHeader,
      fetchOccurrencePrefix,
      guardPrefix,
      prohibitedPattern,
      startActive
    }) => {
      const prohibited = new RegExp(prohibitedPattern, "i");
      const canonicalizeSemanticText = (value) =>
        String(value ?? "")
          .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
          .replaceAll(/([A-Za-z])([0-9])/g, "$1 $2")
          .replaceAll(/([0-9])([A-Za-z])/g, "$1 $2");
      const decodeText = (value) => {
        let decoded = String(value ?? "");
        const maximumPasses = decoded.length + 1;
        for (let count = 0; count < maximumPasses; count += 1) {
          let next;
          try {
            next = decodeURIComponent(decoded);
          } catch {
            return null;
          }
          if (next === decoded) return decoded;
          decoded = next;
        }
        return null;
      };
      const decodeUrlText = (url) => {
        const components = [
          decodeText(url.pathname),
          decodeText(url.search.replaceAll("+", " ")),
          decodeText(url.hash)
        ];
        return components.some((component) => component === null)
          ? null
          : components.join("");
      };
      const urlAllowed = (value) => {
        try {
          const url = new URL(value, globalThis.location.href);
          const decoded = decodeUrlText(url);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            url.origin === authorizedOrigin &&
            !url.username &&
            !url.password &&
            decoded !== null &&
            !prohibited.test(canonicalizeSemanticText(decoded))
          );
        } catch {
          return false;
        }
      };
      const active = Boolean(startActive);
      let action = startActive ? "visit" : null;
      const emit = globalThis.console.debug.bind(globalThis.console);
      Object.defineProperty(globalThis, controlName, {
        configurable: false,
        writable: false,
        value: (candidateToken, nextAction) => {
          if (candidateToken !== controlToken) return false;
          if (!["idle", "visit", "fill", "select", "click"].includes(nextAction)) {
            return false;
          }
          action = nextAction;
          return true;
        }
      });
      const blocked = (kind, url = globalThis.location.href) => {
        if (!active) return false;
        emit(`${guardPrefix}${JSON.stringify({ kind, url })}`);
        return true;
      };
      const observeCurrentUrl = () => {
        if (active && !urlAllowed(globalThis.location.href)) {
          blocked("prohibited-navigation");
        }
      };
      const originalFetch = globalThis.fetch.bind(globalThis);
      const recordFetchOccurrence = globalThis[fetchBindingName].bind(globalThis);
      globalThis.fetch = async function (input, init) {
        let requestUrl = null;
        let occurrenceId = null;
        let requestInput = input;
        let requestInit = init;
        let request = null;
        try {
          request = new Request(input, init);
          requestUrl = request.url;
        } catch {}
        if (active && request) {
          const localResource =
            requestUrl.startsWith("data:") || requestUrl.startsWith("blob:");
          const policyRejected =
            !localResource &&
            (!["GET", "HEAD"].includes(request.method) ||
              !urlAllowed(requestUrl) ||
              action !== "visit");
          occurrenceId = await recordFetchOccurrence(fetchBindingToken, {
            url: requestUrl,
            policyRejected
          });
          if (
            typeof occurrenceId === "string" &&
            occurrenceId.startsWith(fetchOccurrencePrefix)
          ) {
            if (!policyRejected) {
              const headers = new Headers(request.headers);
              headers.set(fetchOccurrenceHeader, occurrenceId);
              requestInput = new Request(request, { headers });
              requestInit = undefined;
            }
          } else {
            occurrenceId = null;
          }
        }
        try {
          return await originalFetch(requestInput, requestInit);
        } catch (error) {
          if (!active || !requestUrl || !occurrenceId) throw error;
          const message =
            error instanceof Error ? error.message : String(error || "Failed to fetch");
          throw new TypeError(
            `${fetchFailurePrefix}${JSON.stringify({ id: occurrenceId, url: requestUrl, message })}`
          );
        }
      };
      globalThis.addEventListener(
        "submit",
        (event) => {
          if (!blocked("form-submission")) return;
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        true
      );
      for (const method of ["submit", "requestSubmit"]) {
        const original = HTMLFormElement.prototype[method];
        if (typeof original !== "function") continue;
        Object.defineProperty(HTMLFormElement.prototype, method, {
          configurable: false,
          writable: false,
          value: function (...args) {
            if (blocked("form-submission")) return undefined;
            return original.apply(this, args);
          }
        });
      }
      for (const method of ["pushState", "replaceState"]) {
        const original = History.prototype[method];
        Object.defineProperty(History.prototype, method, {
          configurable: false,
          writable: false,
          value: function (...args) {
            if (active && action !== "visit") {
              blocked("non-visit-navigation");
              return undefined;
            }
            const nextUrl =
              args[2] === undefined
                ? globalThis.location.href
                : new URL(args[2], globalThis.location.href).href;
            if (active && !urlAllowed(nextUrl)) {
              blocked("prohibited-navigation", nextUrl);
              return undefined;
            }
            return original.apply(this, args);
          }
        });
      }
      globalThis.addEventListener("hashchange", observeCurrentUrl);
      globalThis.addEventListener("popstate", observeCurrentUrl);
    }, {
      authorizedOrigin: authorization.origin,
      controlName: agentGuardControlName,
      controlToken: agentGuardControlToken,
      fetchBindingName: agentFetchBindingName,
      fetchBindingToken: agentFetchBindingToken,
      fetchFailurePrefix: agentFetchFailurePrefix,
      fetchOccurrenceHeader: agentFetchOccurrenceHeader,
      fetchOccurrencePrefix: agentFetchOccurrencePrefix,
      guardPrefix: agentGuardPrefix,
      prohibitedPattern: PROHIBITED_AGENT_ACTION_PATTERN,
      startActive: options.exploreIntent
      })
    );
    if (!pageGuard.successful) return;

    const pageTarget = await initializeNetworkGuard(
      "page-target",
      () => context.newPage()
    );
    if (!pageTarget.successful) return;
    const page = pageTarget.value;
    page.setDefaultTimeout(options.timeoutMs);
    const noteRelatedTarget = (kind) => {
      if (
        !state.operationalIssues.some(
          (issue) => issue.id === "browser-related-target-created"
        )
      ) {
        state.operationalIssues.push({
          id: "browser-related-target-created",
          classification: "test-mechanics",
          title: "A related browser target made intent coverage inconclusive.",
          evidence: kind,
          remediation:
            "Use an owner-declared scenario that does not create popups or workers."
        });
      }
      record(
        "warn",
        "browser.related-target.created",
        "A related browser target was created during intent exploration",
        { kind }
      );
    };
    context.on("page", (relatedPage) => {
      if (options.exploreIntent && relatedPage !== page) {
        noteRelatedTarget("page");
      }
    });
    page.on("worker", () => {
      if (options.exploreIntent) noteRelatedTarget("worker");
    });
    page.on("request", (request) => {
      const occurrence = request.headers()[agentFetchOccurrenceHeader];
      if (
        typeof occurrence === "string" &&
        occurrence.startsWith(agentFetchOccurrencePrefix)
      ) {
        agentFetchRequests.set(occurrence, request);
        agentFetchOccurrencesByRequest.set(request, occurrence);
      }
    });
    if (options.exploreIntent) {
    const agentCdpRequests = new Map();
    const cdpTarget = await initializeNetworkGuard(
      "cdp-session",
      () => context.newCDPSession(page)
    );
    if (!cdpTarget.successful) return;
    const agentCdp = cdpTarget.value;
    agentCdp.on("Fetch.requestPaused", async (event) => {
      try {
        if (event.responseErrorReason !== undefined) {
          try {
            await agentCdp.send("Fetch.failRequest", {
              requestId: event.requestId,
              errorReason: event.responseErrorReason
            });
          } catch (error) {
            if (!/Invalid InterceptionId/i.test(String(error?.message || error))) {
              throw error;
            }
          }
          return;
        }
        if (event.responseStatusCode !== undefined) {
          const requestState = agentCdpRequests.get(event.requestId);
          const location = event.responseHeaders?.find(
            (header) => header.name.toLowerCase() === "location"
          )?.value;
          if (
            [301, 302, 303, 307, 308].includes(event.responseStatusCode) &&
            location &&
            agentNetworkPolicyActive
          ) {
            let redirectUrl = location;
            let redirectAllowed = false;
            try {
              redirectUrl = new URL(location, event.request.url).href;
              redirectAllowed =
                requestState?.allowed &&
                agentActionContext?.action === "visit" &&
                agentActionContext.navigationWindowOpen &&
                ["GET", "HEAD"].includes(event.request.method) &&
                isAgentUrlAllowed(redirectUrl, authorization.origin);
            } catch {}
            if (!redirectAllowed) {
              let redirectOrigin = "";
              try {
                redirectOrigin = new URL(redirectUrl).origin;
              } catch {}
              const reason =
                redirectOrigin && redirectOrigin !== authorization.origin
                  ? "agent-cross-origin"
                  : "agent-prohibited-url";
              if (requestState?.occurrence) {
                blockedAgentFetchOccurrences.add(requestState.occurrence);
                const playwrightRequest = agentFetchRequests.get(
                  requestState.occurrence
                );
                if (playwrightRequest) {
                  blockedPlaywrightRequests.add(playwrightRequest);
                }
              }
              markBlockedConsoleOccurrence(event.request.url);
              const redirectChain = [
                ...(requestState?.urls || [event.request.url]),
                redirectUrl
              ];
              blockedRequests.push({
                method: event.request.method,
                resourceType: event.resourceType.toLowerCase(),
                requestUrl: evidenceUrl(event.request.url),
                url: evidenceUrl(redirectUrl),
                reason,
                redirectChain: [
                  ...new Set(redirectChain.map((url) => evidenceUrl(url)))
                ]
              });
              record(
                "warn",
                "network.request.blocked",
                "Blocked a redirect outside policy",
                {
                  method: event.request.method,
                  resourceType: event.resourceType.toLowerCase(),
                  reason,
                  ...diagnosticUrl(redirectUrl)
                }
              );
              await agentCdp.send("Fetch.fulfillRequest", {
                requestId: event.requestId,
                responseCode: 200,
                responseHeaders: [
                  {
                    name: "content-type",
                    value: "text/plain; charset=utf-8"
                  },
                  { name: "cache-control", value: "no-store" }
                ],
                body: Buffer.from("Blocked by YellowBird").toString("base64")
              });
              return;
            }
          }
          await agentCdp.send("Fetch.continueResponse", {
            requestId: event.requestId
          });
          return;
        }
        const parent = event.redirectedRequestId
          ? agentCdpRequests.get(event.redirectedRequestId)
          : null;
        const occurrenceHeader = Object.entries(event.request.headers).find(
          ([name]) => name.toLowerCase() === agentFetchOccurrenceHeader
        )?.[1];
        const occurrence =
          parent?.occurrence ||
          (typeof occurrenceHeader === "string" &&
          occurrenceHeader.startsWith(agentFetchOccurrencePrefix)
            ? occurrenceHeader
            : null);
        const requestState = {
          occurrence,
          urls: [...(parent?.urls || []), event.request.url],
          allowed: true
        };
        agentCdpRequests.set(event.requestId, requestState);
        const continueRequest = {
          requestId: event.requestId,
          interceptResponse: true
        };
        // Keep the private occurrence header until the Playwright route sees it.
        // The route strips it before the request reaches the product.
        await agentCdp.send("Fetch.continueRequest", continueRequest);
      } catch (error) {
        if (!/Target closed|Session closed/i.test(String(error?.message || error))) {
          noteNetworkGuardFailure(
            error,
            event.responseStatusCode === undefined &&
              event.responseErrorReason === undefined
              ? "cdp-request"
              : "cdp-response"
          );
        }
      }
    });
    const cdpGuard = await initializeNetworkGuard(
      "cdp-fetch",
      () => agentCdp.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }]
      })
    );
    if (!cdpGuard.successful) return;
    }
    state.networkGuardReady = true;
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith(agentGuardPrefix)) {
        try {
          enqueueAgentGuardAttempt(
            JSON.parse(text.slice(agentGuardPrefix.length))
          );
        } catch {}
        return;
      }
      if (message.type() === "error") {
        const fetchFailure = parseAgentFetchFailure(text);
        if (
          fetchFailure &&
          blockedAgentFetchOccurrences.has(fetchFailure.id)
        ) {
          record(
            "debug",
            "browser.console.error.policy-blocked",
            "Correlated a console error with a blocked agent effect",
            diagnosticUrl(fetchFailure.url)
          );
          return;
        }
        if (
          !fetchFailure &&
          /ERR_BLOCKED_BY_CLIENT/i.test(text) &&
          consumeBlockedConsoleOccurrence(message.location().url)
        ) {
          record(
            "debug",
            "browser.console.error.policy-blocked",
            "Correlated a console error with one blocked request",
            diagnosticUrl(message.location().url || options.target)
          );
          return;
        }
        consoleErrors.push({
          text: fetchFailure?.message || text,
          location: message.location()
        });
        record("warn", "browser.console.error", "The page emitted a console error", {
          location: {
            ...diagnosticUrl(message.location().url || options.target),
            lineNumber: message.location().lineNumber,
            columnNumber: message.location().columnNumber
          }
        });
      }
    });
    page.on("pageerror", (error) => {
      const fetchFailure = parseAgentFetchFailure(error.message);
      if (
        fetchFailure &&
        blockedAgentFetchOccurrences.has(fetchFailure.id)
      ) {
        record(
          "debug",
          "browser.page.error.policy-blocked",
          "Correlated a page exception with a blocked agent effect",
          diagnosticUrl(fetchFailure.url)
        );
        return;
      }
      pageErrors.push({ message: fetchFailure?.message || error.message });
      record("error", "browser.page.error", "The page raised an uncaught exception");
    });
    page.on("requestfailed", (request) => {
      const requestUrl = request.url();
      let sameOrigin = false;
      try {
        sameOrigin = new URL(requestUrl).origin === authorization.origin;
      } catch {}
      if (
        sameOrigin &&
        !blockedPlaywrightRequests.has(request)
      ) {
        failedRequests.push({
          method: request.method(),
          url: requestUrl,
          reason: request.failure()?.errorText || "unknown"
        });
        record("warn", "network.request.failed", "A same-origin request failed", {
          method: request.method(),
          ...diagnosticUrl(requestUrl),
          reason: request.failure()?.errorText || "unknown"
        });
      }
    });
    async function collectAgentGuardAttempts() {
      const currentUrl = page.url();
      if (
        agentNetworkPolicyActive &&
        currentUrl !== "about:blank" &&
        !isAgentUrlAllowed(currentUrl, authorization.origin)
      ) {
        enqueueAgentGuardAttempt({
          kind: "prohibited-navigation",
          url: currentUrl
        });
      }
      const attempts = agentGuardAttempts.splice(0);
      for (const attempt of attempts) {
        addBlockedRequest({
          method: "BROWSER",
          resourceType: "document",
          url: evidenceUrl(attempt.url),
          reason: `agent-${attempt.kind}`
        });
        record(
          "warn",
          "browser.action.blocked",
          "Blocked an effect outside agent exploration authority",
          { reason: `agent-${attempt.kind}`, ...diagnosticUrl(attempt.url) }
        );
      }
    }
    async function activateAgentGuard(action) {
      const accepted = await page.evaluate(
        ({ action: nextAction, controlName, controlToken }) =>
          globalThis[controlName]?.(controlToken, nextAction),
        {
          action,
          controlName: agentGuardControlName,
          controlToken: agentGuardControlToken
        }
      );
      if (!accepted) {
        throw new Error(
          "YellowBird browser guard rejected an authenticated transition"
        );
      }
    }
    async function closeAgentNavigationWindow(requireGuard = true) {
      if (agentActionContext) {
        agentActionContext.action = "idle";
        agentActionContext.requestedUrl = null;
        agentActionContext.navigationStarted = false;
        agentActionContext.navigationRequests.clear();
        agentActionContext.navigationWindowOpen = false;
      }
      if (requireGuard) await activateAgentGuard("idle");
    }
    page.on("response", (response) => {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(response.url()).origin === authorization.origin;
      } catch {}
      if (
        sameOrigin &&
        response.status() >= 400
      ) {
        serverErrors.push({ status: response.status(), url: response.url() });
        record("warn", "network.response.error", "A same-origin response returned an HTTP error", {
          status: response.status(),
          ...diagnosticUrl(response.url())
        });
      }
    });

    try {
      record("info", "navigation.started", "Starting initial browser navigation", {
        ...diagnosticUrl(options.target),
        timeoutMs: options.timeoutMs
      });
      const response = await page.goto(options.target, {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs
      });
      state.status = response?.status() ?? null;
      record("info", "navigation.completed", "Initial navigation completed", {
        status: state.status,
        ...diagnosticUrl(page.url())
      });
      await page.waitForTimeout(AGENT_NAVIGATION_SETTLEMENT_MS);
      if (agentNetworkPolicyActive) await closeAgentNavigationWindow();
      state.assertionTitle = await page.title().catch(() => "");
      state.assertionBodyText = await page
        .locator("body")
        .innerText()
        .then((value) => value.slice(0, 20_000))
        .catch(() => "");
    } catch (error) {
      state.navigationError = cleanDiagnosticText(error.message);
      state.navigationDiagnostic = diagnoseNavigationError(
        state.navigationError,
        options.target
      );
      record(
        "error",
        "navigation.failed",
        state.navigationDiagnostic.message,
        state.navigationDiagnostic
      );
    } finally {
      if (agentNetworkPolicyActive) {
        await closeAgentNavigationWindow(false);
        await collectAgentGuardAttempts();
      }
    }

    for (const step of options.steps) {
      const stepStartedAt = Date.now();
      if (state.navigationError) {
        workflowSteps.push({
          id: step.id,
          action: step.action,
          status: "skipped",
          evidence: "Initial navigation did not complete",
          durationMs: 0
        });
        record(
          "warn",
          "workflow.step.skipped",
          "Skipped a workflow step because navigation did not complete",
          { id: step.id, action: step.action }
        );
        continue;
      }

      try {
        const locator = page.locator(step.selector);
        if (step.action === "click") {
          await locator.click();
        } else if (step.action === "fill") {
          const value = step.valueFromEnv
            ? process.env[step.valueFromEnv]
            : step.value;
          await locator.fill(value);
        } else if (step.action === "expectText") {
          const observed = (await locator.textContent()) || "";
          if (!observed.includes(step.text)) {
            throw new Error(
              `expected ${JSON.stringify(step.text)}, observed ${JSON.stringify(observed.slice(0, 300))}`
            );
          }
        } else if (step.action === "expectVisible") {
          if (!(await locator.isVisible())) {
            throw new Error(`selector was not visible: ${step.selector}`);
          }
        }

        workflowSteps.push({
          id: step.id,
          action: step.action,
          status: "passed",
          evidence:
            step.action.startsWith("expect")
              ? "Owner assertion satisfied"
              : "Action completed",
          durationMs: Date.now() - stepStartedAt
        });
        record("info", "workflow.step.completed", "Workflow step completed", {
          id: step.id,
          action: step.action,
          durationMs: Date.now() - stepStartedAt
        });
      } catch (error) {
        const isAssertion = step.action.startsWith("expect");
        const result = {
          id: step.id,
          action: step.action,
          status: isAssertion ? "failed" : "invalid",
          evidence: error.message,
          durationMs: Date.now() - stepStartedAt
        };
        workflowSteps.push(result);
        record(
          isAssertion ? "error" : "warn",
          isAssertion ? "workflow.assertion.failed" : "workflow.action.invalid",
          isAssertion
            ? "An owner-declared workflow assertion failed"
            : "A workflow action could not be executed",
          {
            id: step.id,
            action: step.action,
            detail: cleanDiagnosticText(error.message),
            durationMs: result.durationMs
          }
        );

        if (isAssertion) {
          workflowFindings.push({
            id: `workflow-assertion-${step.id}`,
            severity: "medium",
            title: `Workflow assertion failed: ${step.id}`,
            evidence: error.message
          });
        } else {
          invalidWorkflowSteps.push(result);
        }
      }
    }

    if (options.exploreIntent) {
      if (state.navigationError) {
        state.exploration.status = "skipped";
        state.exploration.coverage = "blocked";
        state.exploration.summary =
          "Intent exploration was skipped because initial navigation failed.";
      } else {
        record("info", "agent.engine.started", "Resolving an agent engine", {
          mode: "safe-same-origin-interaction"
        });
        let resolvedEngine;
        try {
          resolvedEngine = await resolveEngine({
            baseUrl: options.engineBaseUrl,
            model: options.engineModel,
            timeoutMs: Math.max(options.timeoutMs, 120_000)
          });
        } catch {
          resolvedEngine = {
            engine: null,
            capabilities: null,
            diagnostic: {
              id: "agent-engine-resolution-failed",
              classification: "test-mechanics",
              title: "YellowBird could not resolve the configured agent engine.",
              evidence:
                "The engine resolver failed before returning a compatible binding.",
              remediation:
                "Check the engine configuration and runtime, then rerun or provide a deterministic scenario."
            }
          };
        }
        if (!resolvedEngine.engine) {
          state.exploration.status = "inconclusive";
          state.exploration.coverage = "blocked";
          state.exploration.summary =
            "No compatible agent engine was available for the requested intent.";
          state.exploration.issue = resolvedEngine.diagnostic;
          record(
            "error",
            "agent.engine.failed",
            resolvedEngine.diagnostic.title,
            {
              code: resolvedEngine.diagnostic.id,
              detail: resolvedEngine.diagnostic.evidence
            }
          );
        } else {
          const initialProvenance = resolvedEngine.engine.provenance();
          const initialEngineName = `${initialProvenance.adapter}:${initialProvenance.modelReported}`;
          state.exploration.engine = initialEngineName;
          state.exploration.provenance = initialProvenance;
          state.exploration.capabilities = resolvedEngine.capabilities;
          record("info", "agent.engine.ready", "Agent engine is ready", {
            adapter: initialProvenance.adapter,
            endpointClass: initialProvenance.endpointClass,
            model: initialProvenance.modelReported,
            capabilities: resolvedEngine.capabilities
          });
          let exploration;
          agentNetworkPolicyActive = true;
          try {
            exploration = await exploreIntentWithEngine({
              page,
              intent: options.intent,
              authorizedOrigin: authorization.origin,
              engine: resolvedEngine.engine,
              maxSteps: options.maxAgentSteps,
              timeoutMs: options.timeoutMs,
              record,
              actionPolicy: {
                navigationSettlementMs: AGENT_NAVIGATION_SETTLEMENT_MS,
                async begin(action) {
                  await collectAgentGuardAttempts();
                  agentActionContext = {
                    ...action,
                    navigationStarted: false,
                    navigationRequests: new Set(),
                    navigationWindowOpen: action.action === "visit"
                  };
                  await activateAgentGuard(action.action);
                },
                async resume() {
                  await closeAgentNavigationWindow();
                },
                async end() {
                  await closeAgentNavigationWindow();
                  await collectAgentGuardAttempts();
                }
              }
            });
          } finally {
            await closeAgentNavigationWindow(false);
            await collectAgentGuardAttempts();
          }
          const finalProvenance = resolvedEngine.engine.provenance();
          const finalEngineName = `${finalProvenance.adapter}:${finalProvenance.modelReported}`;
          if (
            finalProvenance.modelReported !== initialProvenance.modelReported
          ) {
            exploration = {
              ...exploration,
              status: "inconclusive",
              coverage: "blocked",
              issue: {
                id: "agent-model-transition",
                classification: "test-mechanics",
                title: "The agent engine changed models during exploration.",
                evidence: `${initialProvenance.modelReported} to ${finalProvenance.modelReported}`,
                remediation:
                  "Configure the endpoint to use one stable model for probing and exploration."
              }
            };
            record(
              "error",
              "agent.engine.changed",
              "The agent engine changed models during exploration",
              {
                from: initialProvenance.modelReported,
                to: finalProvenance.modelReported
              }
            );
          }
          state.exploration = {
            ...state.exploration,
            ...exploration,
            requested: true,
            mode: "agent-safe-interaction",
            engine: finalEngineName,
            provenance: finalProvenance,
            capabilities: resolvedEngine.capabilities
          };
        }
      }
    }

    state.title = await page.title().catch(() => "");
    const snapshot = await page
      .evaluate(() => {
        const selector = "a, button, input, select, textarea";
        const elements = [...document.querySelectorAll(selector)].slice(0, 100);
        return {
          bodyText: (document.body?.innerText || "").slice(0, 20_000),
          interactiveElements: elements.map((element) => {
            const label =
              element.getAttribute("aria-label") ||
              element.getAttribute("placeholder") ||
              element.textContent ||
              element.getAttribute("name") ||
              element.tagName;
            return {
              tag: element.tagName.toLowerCase(),
              label: String(label).trim().slice(0, 160),
              href: element.href || null,
              disabled: Boolean(element.disabled)
            };
          })
        };
      })
      .catch(() => ({ bodyText: "", interactiveElements: [] }));
    state.bodyText = snapshot.bodyText;
    state.interactiveElements = snapshot.interactiveElements.map((element) => ({
      ...element,
      href: element.href ? evidenceUrl(element.href) : null
    }));
    screenshot = null;
    try {
      screenshot = await page.screenshot({
        fullPage: true,
        timeout: Math.max(options.timeoutMs, 5_000)
      });
    } catch (error) {
      noteScreenshotCaptureFailure(error);
    }
    await collectAgentGuardAttempts();
  }
  let screenshot = null;
  let browserRunError = null;
  let browserCloseError = null;
  try {
    await executeBrowserRun();
  } catch (error) {
    browserRunError = error;
  } finally {
    try {
      await browser.close();
      record("debug", "browser.closed", "Playwright Chromium closed");
    } catch (error) {
      browserCloseError = error;
    }
  }
  if (browserRunError) noteBrowserOperationFailure(browserRunError);
  if (browserCloseError) noteBrowserCloseFailure(browserCloseError);
  if (screenshot) {
    await writeFile(join(outputDirectory, "page.png"), screenshot, {
      mode: 0o600
    });
    state.screenshotCaptured = true;
  }

  return finalizeRun(state);
  };
}

export const runScout = createScoutRunner({
  launchBrowser: (options) => chromium.launch(options)
});
