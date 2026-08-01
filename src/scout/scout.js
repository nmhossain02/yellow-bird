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
  resolveLoopbackScheme
} from "./diagnostics.js";
import { resolveAgentEngine } from "./engine.js";
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
const AGENT_PASSIVE_RESOURCE_TYPES = new Set([
  "eventsource",
  "font",
  "image",
  "manifest",
  "media",
  "script",
  "stylesheet",
  "texttrack"
]);
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
    (candidate) => candidate.status !== "invalid"
  );
  const lines = [
    'import { test, expect } from "@playwright/test";',
    "",
    `test(${quoteForJavaScript(`YellowBird scout: ${options.intent}`)}, async ({ page }) => {`,
    "  const consoleErrors = [];",
    '  page.on("console", (message) => {',
    '    if (message.type() === "error")',
    "      consoleErrors.push({ text: message.text(), location: message.location() });",
    "  });",
    "",
    `  const yellowbirdTarget = new URL(${quoteForJavaScript(options.target)});`,
    "  const yellowbirdTargetRequestUrl = new URL(yellowbirdTarget);",
    '  yellowbirdTargetRequestUrl.hash = "";',
    `  const yellowbirdAgentMode = ${options.exploreIntent};`,
    "  const yellowbirdBlockedUrls = new Set();",
    "  const yellowbirdBlockedEffectPages = new Set();",
    "  let yellowbirdAgentAction = yellowbirdAgentMode ? {",
    '    action: "visit",',
    "    requestedUrl: yellowbirdTargetRequestUrl.href,",
    "    navigationStarted: false,",
    "    navigationRequests: new Set(),",
    "    passiveResourcesAllowed: true",
    "  } : null;",
    `  const yellowbirdUnsafeRequest = new RegExp(${quoteForJavaScript(PROHIBITED_AGENT_ACTION_PATTERN)}, "i");`,
    '  const yellowbirdPassiveResourceTypes = new Set(["eventsource", "font", "image", "manifest", "media", "script", "stylesheet", "texttrack"]);',
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
    "        decoded !== null && !yellowbirdUnsafeRequest.test(decoded);",
    "    } catch { return false; }",
    "  };",
    "  await page.context().addInitScript(({ authorizedOrigin, prohibitedPattern, startActive }) => {",
    "    const prohibited = new RegExp(prohibitedPattern, \"i\");",
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
    "          decoded !== null && !prohibited.test(decoded);",
    "      } catch { return false; }",
    "    };",
    '    const state = { active: startActive, action: startActive ? "visit" : null, violation: null };',
    '    Object.defineProperty(globalThis, "__yellowbirdAgentReplayGuard", {',
    "      value: state,",
    "      configurable: false",
    "    });",
    "    const blocked = (kind, url = globalThis.location.href) => {",
    "      if (!state.active) return false;",
    "      state.violation ||= { kind, url };",
    "      return true;",
    "    };",
    "    state.observeCurrentUrl = () => {",
    '      if (state.active && !urlAllowed(globalThis.location.href)) blocked("prohibited-navigation");',
    "    };",
    '    globalThis.addEventListener("submit", event => {',
    '      if (!blocked("form-submission")) return;',
    "      event.preventDefault();",
    "      event.stopImmediatePropagation();",
    "    }, true);",
    '    for (const method of ["submit", "requestSubmit"]) {',
    "      const original = HTMLFormElement.prototype[method];",
    '      if (typeof original !== "function") continue;',
    "      HTMLFormElement.prototype[method] = function (...args) {",
    '        if (blocked("form-submission")) return undefined;',
    "        return original.apply(this, args);",
    "      };",
    "    }",
    '    for (const method of ["pushState", "replaceState"]) {',
    "      const original = history[method];",
    "      history[method] = function (...args) {",
    '        if (state.active && state.action !== "visit") { blocked("non-visit-navigation"); return undefined; }',
    "        const nextUrl = args[2] === undefined ? globalThis.location.href : new URL(args[2], globalThis.location.href).href;",
    '        if (state.active && !urlAllowed(nextUrl)) { blocked("prohibited-navigation", nextUrl); return undefined; }',
    "        return original.apply(this, args);",
    "      };",
    "    }",
    '    globalThis.addEventListener("hashchange", state.observeCurrentUrl);',
    '    globalThis.addEventListener("popstate", state.observeCurrentUrl);',
    `  }, { authorizedOrigin: yellowbirdTarget.origin, prohibitedPattern: ${quoteForJavaScript(PROHIBITED_AGENT_ACTION_PATTERN)}, startActive: ${options.exploreIntent} });`,
    '  await page.context().route("**/*", async (route) => {',
    "    const request = route.request();",
    "    const requestUrl = request.url();",
    "    const requestMethod = request.method();",
    '    const localResource = requestUrl.startsWith("data:") || requestUrl.startsWith("blob:");',
    '    if (localResource && (!yellowbirdAgentMode || request.resourceType() !== "document"))',
    "      return route.continue();",
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
    "        } else safeAgentAction = yellowbirdAgentAction.passiveResourcesAllowed && yellowbirdPassiveResourceTypes.has(request.resourceType());",
    "      }",
    "      allowed = parsedRequestUrl.origin === yellowbirdTarget.origin &&",
    '        (!yellowbirdAgentMode || (["GET", "HEAD"].includes(requestMethod) && safeAgentUrl && safeAgentAction));',
    "    } catch {}",
    '    if (allowed && yellowbirdAgentAction?.action === "visit" && request.resourceType() === "document") {',
    "      const response = await route.fetch({ maxRedirects: 0 });",
    '      const location = response.headers()["location"];',
    "      if ([301, 302, 303, 307, 308].includes(response.status()) && location) {",
    "        let redirectUrl = location;",
    "        let safeRedirect = false;",
    "        try {",
    "          const parsedRedirect = new URL(location, requestUrl);",
    "          redirectUrl = parsedRedirect.href;",
    "          safeRedirect = yellowbirdAgentUrlAllowed(parsedRedirect.href);",
    "        } catch {}",
    "        if (!safeRedirect) {",
    "          yellowbirdBlockedUrls.add(requestUrl);",
    "          yellowbirdBlockedUrls.add(redirectUrl);",
    "          yellowbirdBlockedEffectPages.add(page.url());",
    '          return route.abort("blockedbyclient");',
    "        }",
    "      }",
    "      return route.fulfill({ response });",
    "    }",
    "    if (allowed) return route.continue();",
    "    yellowbirdBlockedUrls.add(requestUrl);",
    "    yellowbirdBlockedEffectPages.add(page.url());",
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
    "      yellowbirdBlockedEffectPages.add(page.url());",
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
    "    await page.evaluate(activeAction => {",
    "      const guard = globalThis.__yellowbirdAgentReplayGuard;",
    "      guard.active = true;",
    "      guard.action = activeAction;",
    "    }, action);",
    "  };",
    "  const yellowbirdBeginAgentAction = async (action, requestedUrl = null) => {",
    "    yellowbirdAgentAction = {",
    "      action,",
    "      requestedUrl,",
    "      navigationStarted: false,",
    "      navigationRequests: new Set(),",
    '      passiveResourcesAllowed: action === "visit"',
    "    };",
    "    await yellowbirdActivateAgentGuard(action);",
    "  };",
    "  const yellowbirdFinishAgentNavigation = async () => {",
    "    yellowbirdAgentAction.passiveResourcesAllowed = false;",
    '    await yellowbirdActivateAgentGuard("visit");',
    "  };",
    "  const yellowbirdAssertAgentGuard = async () => {",
    "    const violation = await page.evaluate(() => {",
    "      const guard = globalThis.__yellowbirdAgentReplayGuard;",
    "      guard.observeCurrentUrl();",
    "      return guard.violation;",
    "    });",
    "    expect(violation).toBeNull();",
    "  };",
    "",
    `  const response = await page.goto(yellowbirdTarget.href, { waitUntil: "domcontentloaded" });`,
    ...(options.exploreIntent
      ? [
          `  await page.waitForTimeout(${AGENT_NAVIGATION_SETTLEMENT_MS});`,
          "  await yellowbirdFinishAgentNavigation();",
          "  await page.waitForTimeout(100);",
          "  await yellowbirdAssertAgentGuard();"
        ]
      : []),
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
    lines.push(
      `  await yellowbirdBeginAgentAction(${quoteForJavaScript(step.action)}, ${quoteForJavaScript(step.requestedUrl)});`
    );
    if (step.action === "visit") {
      const response = `yellowbirdAgentResponse${index + 1}`;
      lines.push(
        `  const ${response} = await page.goto(${quoteForJavaScript(step.requestedUrl)}, { waitUntil: "domcontentloaded" });`,
        `  await expect(page).toHaveURL(${quoteForJavaScript(step.url)});`,
        `  await page.waitForTimeout(${AGENT_NAVIGATION_SETTLEMENT_MS});`,
        "  await yellowbirdFinishAgentNavigation();",
        "  await page.waitForTimeout(100);",
        "  await yellowbirdAssertAgentGuard();"
      );
      if (step.httpStatus) {
        lines.push(
          `  expect(${response}?.status()).toBe(${step.httpStatus});`
        );
      }
      return;
    }
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
      "  await page.waitForTimeout(250);",
      "  await yellowbirdAssertAgentGuard();"
    );
  });
  if (!options.ignoreConsoleErrors) {
    lines.push(
      "  const yellowbirdProductConsoleErrors = consoleErrors.filter(entry =>",
      "    !((yellowbirdBlockedUrls.has(entry.location?.url) && /ERR_BLOCKED_BY_CLIENT/i.test(entry.text)) ||",
      "      (yellowbirdBlockedEffectPages.has(entry.location?.url) &&",
      "        /(?:failed to fetch|networkerror|err_blocked_by_client|websocket.*failed)/i.test(entry.text)))",
      "  );",
      "  expect(yellowbirdProductConsoleErrors).toEqual([]);"
    );
  }
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
  } else if (state.navigationError) {
    setupIssues.push({
      id: state.navigationDiagnostic.code,
      classification: "test-mechanics",
      title: state.navigationDiagnostic.message,
      evidence: state.navigationDiagnostic.detail,
      remediation: state.navigationDiagnostic.remediation
    });
  } else if (state.status !== options.expectedStatus) {
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

  const productEvaluated = state.browserLaunch.successful && !state.navigationError;
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
  const policyBlockedUrls = new Set(
    blockedRequests.flatMap((request) =>
      [request.url, request.requestUrl].filter(Boolean)
    )
  );
  const productConsoleErrors = consoleErrors.filter(
    (entry) =>
      !policyBlockedUrls.has(entry.location?.url) ||
      !/ERR_BLOCKED_BY_CLIENT/i.test(entry.text)
  );
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
  if (!productEvaluated) {
    coverageGaps.push(
      state.browserLaunch.successful
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
          ? state.navigationError
            ? "failed"
            : "completed"
          : "skipped",
        reason: state.browserLaunch.successful ? null : "browser-unavailable",
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
    record
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
  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 }
    });
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
          passiveResourcesAllowed: true
        }
      : null;
    let latestAgentEffectBlock = null;
    const addBlockedRequest = (request) => {
      blockedRequests.push(request);
      if (request.reason?.startsWith("agent-")) {
        latestAgentEffectBlock = { request, observedAt: Date.now() };
      }
    };
    const isPolicyCausedBrowserError = (detail) =>
      latestAgentEffectBlock &&
      Date.now() - latestAgentEffectBlock.observedAt <= 1_000 &&
      /(?:failed to fetch|fetch failed|load failed|networkerror|err_blocked_by_client|websocket.*failed)/i.test(
        detail
      );
    await context.routeWebSocket("**/*", async (socket) => {
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
    });

    await context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      const requestMethod = route.request().method();
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
          agentActionAllowed =
            agentActionContext.passiveResourcesAllowed &&
            AGENT_PASSIVE_RESOURCE_TYPES.has(route.request().resourceType());
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
        if (
          agentNetworkPolicyActive &&
          agentActionContext?.action === "visit" &&
          route.request().resourceType() === "document"
        ) {
          const response = await route.fetch({ maxRedirects: 0 });
          const location = response.headers().location;
          if (
            [301, 302, 303, 307, 308].includes(response.status()) &&
            location
          ) {
            let redirectUrl = location;
            let redirectAllowed = false;
            try {
              const parsedRedirect = new URL(location, requestUrl);
              redirectUrl = parsedRedirect.href;
              redirectAllowed = isAgentUrlAllowed(
                redirectUrl,
                authorization.origin
              );
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
              addBlockedRequest({
                method: requestMethod,
                resourceType: route.request().resourceType(),
                requestUrl: evidenceUrl(requestUrl),
                url: evidenceUrl(redirectUrl),
                reason
              });
              record(
                "warn",
                "network.request.blocked",
                "Blocked a redirect outside policy",
                {
                  method: requestMethod,
                  resourceType: route.request().resourceType(),
                  reason,
                  ...diagnosticUrl(redirectUrl)
                }
              );
              await route.abort("blockedbyclient");
              return;
            }
          }
          await route.fulfill({ response });
          return;
        }
        await route.continue();
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
      addBlockedRequest({
        method: requestMethod,
        resourceType: route.request().resourceType(),
        url: evidenceUrl(requestUrl),
        reason
      });
      record("warn", "network.request.blocked", "Blocked a request outside policy", {
        method: requestMethod,
        resourceType: route.request().resourceType(),
        reason,
        ...diagnosticUrl(requestUrl)
      });
      await route.abort("blockedbyclient");
    });

    await context.addInitScript(({ authorizedOrigin, prohibitedPattern, startActive }) => {
      const prohibited = new RegExp(prohibitedPattern, "i");
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
            !prohibited.test(decoded)
          );
        } catch {
          return false;
        }
      };
      const state = {
        active: startActive,
        action: startActive ? "visit" : null,
        attempts: []
      };
      Object.defineProperty(globalThis, "__yellowbirdAgentActionGuard", {
        value: state,
        configurable: false
      });
      const blocked = (kind, url = globalThis.location.href) => {
        if (!state.active) return false;
        state.attempts.push({ kind, url });
        return true;
      };
      state.observeCurrentUrl = () => {
        if (state.active && !urlAllowed(globalThis.location.href)) {
          blocked("prohibited-navigation");
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
        HTMLFormElement.prototype[method] = function (...args) {
          if (blocked("form-submission")) return undefined;
          return original.apply(this, args);
        };
      }
      for (const method of ["pushState", "replaceState"]) {
        const original = history[method];
        history[method] = function (...args) {
          if (state.active && state.action !== "visit") {
            blocked("non-visit-navigation");
            return undefined;
          }
          const nextUrl =
            args[2] === undefined
              ? globalThis.location.href
              : new URL(args[2], globalThis.location.href).href;
          if (state.active && !urlAllowed(nextUrl)) {
            blocked("prohibited-navigation", nextUrl);
            return undefined;
          }
          return original.apply(this, args);
        };
      }
      globalThis.addEventListener("hashchange", state.observeCurrentUrl);
      globalThis.addEventListener("popstate", state.observeCurrentUrl);
    }, {
      authorizedOrigin: authorization.origin,
      prohibitedPattern: PROHIBITED_AGENT_ACTION_PATTERN,
      startActive: options.exploreIntent
    });

    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs);
    page.on("console", (message) => {
      if (message.type() === "error") {
        if (isPolicyCausedBrowserError(message.text())) {
          record(
            "debug",
            "browser.console.error.policy-blocked",
            "Correlated a console error with a blocked agent effect",
            { reason: latestAgentEffectBlock.request.reason }
          );
          return;
        }
        consoleErrors.push({ text: message.text(), location: message.location() });
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
      const detail = `${error.name || ""}: ${error.message || ""}\n${error.stack || ""}`;
      if (isPolicyCausedBrowserError(detail)) {
        record(
          "debug",
          "browser.page.error.policy-blocked",
          "Correlated a page exception with a blocked agent effect",
          { reason: latestAgentEffectBlock.request.reason }
        );
        return;
      }
      pageErrors.push({ message: error.message });
      record("error", "browser.page.error", "The page raised an uncaught exception");
    });
    page.on("requestfailed", (request) => {
      const requestUrl = request.url();
      if (
        requestUrl.startsWith(authorization.origin) &&
        !blockedRequests.some(
          (blocked) =>
            blocked.url === requestUrl || blocked.requestUrl === requestUrl
        )
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
      const attempts = await page
        .evaluate(() => {
          const guard = globalThis.__yellowbirdAgentActionGuard;
          if (!guard) return [];
          guard.observeCurrentUrl();
          const observed = guard.attempts;
          guard.attempts = [];
          return observed;
        })
        .catch(() => []);
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
    async function closeAgentNavigationWindow() {
      if (agentActionContext) {
        agentActionContext.passiveResourcesAllowed = false;
      }
      await page
        .evaluate(() => {
          const guard = globalThis.__yellowbirdAgentActionGuard;
          if (!guard) return;
          guard.active = true;
          guard.action = "visit";
        })
        .catch(() => {});
    }
    page.on("response", (response) => {
      if (
        response.url().startsWith(authorization.origin) &&
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
        await closeAgentNavigationWindow();
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
                    passiveResourcesAllowed: action.action === "visit"
                  };
                  await page.evaluate((activeAction) => {
                    const guard = globalThis.__yellowbirdAgentActionGuard;
                    guard.active = true;
                    guard.action = activeAction;
                  }, action.action);
                },
                async resume() {
                  await closeAgentNavigationWindow();
                },
                async end() {
                  await collectAgentGuardAttempts();
                }
              }
            });
          } finally {
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
    await page.screenshot({
      path: join(outputDirectory, "page.png"),
      fullPage: true,
      timeout: Math.max(options.timeoutMs, 5_000)
    });
    state.screenshotCaptured = true;
    await collectAgentGuardAttempts();
  } finally {
    await browser.close();
    record("debug", "browser.closed", "Playwright Chromium closed");
  }

  return finalizeRun(state);
  };
}

export const runScout = createScoutRunner({
  launchBrowser: (options) => chromium.launch(options)
});
