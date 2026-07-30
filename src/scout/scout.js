import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

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

function markdownEscape(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function buildMarkdown(report) {
  const findingRows = report.findings.length
    ? report.findings
        .map(
          (finding) =>
            `| ${markdownEscape(finding.severity)} | ${markdownEscape(finding.title)} | ${markdownEscape(finding.evidence)} |`
        )
        .join("\n")
    : "| — | No asserted failures observed | — |";

  return `# YellowBird scout report

- Run: \`${report.run.id}\`
- Outcome: **${report.outcome}**
- Target: \`${report.target.url}\`
- Authorization: ${report.target.authorization.method}, ${report.target.authorization.scope}
- Intent: ${report.intent}
- Started: ${report.run.startedAt}
- Duration: ${report.run.durationMs} ms

## Findings

| Severity | Finding | Evidence |
| --- | --- | --- |
${findingRows}

## Observations

- HTTP status: ${report.observations.status ?? "unavailable"}
- Page title: ${report.observations.title || "(empty)"}
- Interactive elements inventoried: ${report.observations.interactiveElements.length}
- Console errors: ${report.observations.consoleErrors.length}
- Uncaught page errors: ${report.observations.pageErrors.length}
- Failed same-origin requests: ${report.observations.failedRequests.length}
- Blocked cross-origin requests: ${report.observations.blockedRequests.length}

## Coverage gaps

${report.coverageGaps.map((gap) => `- ${gap}`).join("\n")}

## Reproduction

1. Install dependencies with \`bun install\`.
2. Install Chromium with \`bun run setup:browsers\`.
3. Ensure the target is available at \`${report.target.url}\`.
4. Run \`bunx playwright test --config ${report.artifacts.playwrightConfig}\`.

The generated regression contains only explicit, deterministic assertions. Review it before
committing it to the product repository.
`;
}

function quoteForJavaScript(value) {
  return JSON.stringify(value);
}

function buildRegression(options) {
  const lines = [
    'import { test, expect } from "@playwright/test";',
    "",
    `test(${quoteForJavaScript(`YellowBird scout: ${options.intent}`)}, async ({ page }) => {`,
    "  const consoleErrors = [];",
    '  page.on("console", (message) => {',
    '    if (message.type() === "error") consoleErrors.push(message.text());',
    "  });",
    "",
    `  const response = await page.goto(${quoteForJavaScript(options.target)}, { waitUntil: "domcontentloaded" });`,
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
  if (!options.ignoreConsoleErrors) {
    lines.push("  expect(consoleErrors).toEqual([]);");
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

export async function runScout(input) {
  const authorization = authorizeScoutTarget(input.target);
  const runId = `scout_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const outputDirectory = resolve(
    input.outputDirectory || join(".yellowbird", "scout", runId)
  );
  const options = {
    target: authorization.target,
    intent: input.intent || "Verify that the initial page is healthy",
    expectedStatus: Number(input.expectedStatus ?? 200),
    expectedTitle: input.expectedTitle || null,
    expectedTexts: input.expectedTexts || [],
    ignoreConsoleErrors: Boolean(input.ignoreConsoleErrors),
    headed: Boolean(input.headed),
    timeoutMs: Number(input.timeoutMs ?? 15_000)
  };

  if (!Number.isInteger(options.expectedStatus) || options.expectedStatus < 100) {
    throw new Error("expected status must be a valid HTTP status code");
  }

  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);

  const startedAt = new Date();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const blockedRequests = [];
  const serverErrors = [];
  let navigationError = null;
  let status = null;
  let title = "";
  let bodyText = "";
  let interactiveElements = [];

  const browser = await chromium.launch({ headless: !options.headed });
  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs);

    const targetUrl = new URL(options.target);
    await page.routeWebSocket(
      (socketUrl) => {
        const expectedProtocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
        const expectedPort =
          targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80");
        const socketPort =
          socketUrl.port || (socketUrl.protocol === "wss:" ? "443" : "80");
        return (
          socketUrl.protocol !== expectedProtocol ||
          socketUrl.hostname !== targetUrl.hostname ||
          socketPort !== expectedPort
        );
      },
      async (socket) => {
        blockedRequests.push({
          method: "WEBSOCKET",
          resourceType: "websocket",
          url: socket.url()
        });
        await socket.close({
          code: 1008,
          reason: "Blocked by YellowBird exact-origin policy"
        });
      }
    );

    await page.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      let requestOrigin;
      try {
        requestOrigin = new URL(requestUrl).origin;
      } catch {
        requestOrigin = "";
      }

      if (
        requestOrigin === authorization.origin ||
        requestUrl.startsWith("data:") ||
        requestUrl.startsWith("blob:")
      ) {
        await route.continue();
        return;
      }

      blockedRequests.push({
        method: route.request().method(),
        resourceType: route.request().resourceType(),
        url: requestUrl
      });
      await route.abort("blockedbyclient");
    });

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push({ text: message.text(), location: message.location() });
      }
    });
    page.on("pageerror", (error) => pageErrors.push({ message: error.message }));
    page.on("requestfailed", (request) => {
      const requestUrl = request.url();
      if (
        requestUrl.startsWith(authorization.origin) &&
        !blockedRequests.some((blocked) => blocked.url === requestUrl)
      ) {
        failedRequests.push({
          method: request.method(),
          url: requestUrl,
          reason: request.failure()?.errorText || "unknown"
        });
      }
    });
    page.on("response", (response) => {
      if (
        response.url().startsWith(authorization.origin) &&
        response.status() >= 400
      ) {
        serverErrors.push({ status: response.status(), url: response.url() });
      }
    });

    try {
      const response = await page.goto(options.target, {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs
      });
      status = response?.status() ?? null;
      await page.waitForTimeout(250);
    } catch (error) {
      navigationError = error.message;
    }

    title = await page.title().catch(() => "");
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
    bodyText = snapshot.bodyText;
    interactiveElements = snapshot.interactiveElements;
    await page.screenshot({
      path: join(outputDirectory, "page.png"),
      fullPage: true
    });
  } finally {
    await browser.close();
  }

  const findings = [];
  if (navigationError) {
    findings.push({
      id: "navigation-failed",
      severity: "high",
      title: "Initial navigation failed",
      evidence: navigationError
    });
  } else if (status !== options.expectedStatus) {
    findings.push({
      id: "unexpected-status",
      severity: status && status >= 500 ? "high" : "medium",
      title: `Expected HTTP ${options.expectedStatus}, received ${status}`,
      evidence: options.target
    });
  }
  if (options.expectedTitle && title !== options.expectedTitle) {
    findings.push({
      id: "title-mismatch",
      severity: "medium",
      title: "Page title did not match the owner assertion",
      evidence: `expected ${JSON.stringify(options.expectedTitle)}, received ${JSON.stringify(title)}`
    });
  }
  for (const text of options.expectedTexts) {
    if (!bodyText.includes(text)) {
      findings.push({
        id: "missing-text",
        severity: "medium",
        title: "Expected page text was not present",
        evidence: JSON.stringify(text)
      });
    }
  }
  if (!options.ignoreConsoleErrors && consoleErrors.length) {
    findings.push({
      id: "console-errors",
      severity: "medium",
      title: `${consoleErrors.length} browser console error(s) observed`,
      evidence: consoleErrors.map((entry) => entry.text).join("; ").slice(0, 500)
    });
  }
  if (pageErrors.length) {
    findings.push({
      id: "page-errors",
      severity: "high",
      title: `${pageErrors.length} uncaught page exception(s) observed`,
      evidence: pageErrors.map((entry) => entry.message).join("; ").slice(0, 500)
    });
  }
  if (failedRequests.length) {
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
  if (subresourceServerErrors.length) {
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

  const coverageGaps = [
    "This alpha inspected only the initial page load; it did not autonomously exercise workflows.",
    "No model or agent made pass/fail decisions. Findings come from explicit assertions and runtime signals."
  ];
  if (interactiveElements.length) {
    coverageGaps.push(
      `${interactiveElements.length} interactive element(s) were inventoried but not exercised.`
    );
  }
  if (blockedRequests.length) {
    coverageGaps.push(
      `${blockedRequests.length} cross-origin request(s) were blocked by the exact-origin network policy.`
    );
  }

  const report = {
    schema: "yellowbird.scout-evidence.v1",
    outcome: findings.length ? "attention" : "clear",
    intent: options.intent,
    run: {
      id: runId,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime()
    },
    target: {
      url: options.target,
      origin: authorization.origin,
      authorization: authorization.authorization
    },
    assertions: {
      expectedStatus: options.expectedStatus,
      expectedTitle: options.expectedTitle,
      expectedTexts: options.expectedTexts,
      consoleErrorsAllowed: options.ignoreConsoleErrors
    },
    findings,
    observations: {
      status,
      title,
      interactiveElements,
      consoleErrors,
      pageErrors,
      failedRequests,
      blockedRequests,
      serverErrors
    },
    coverageGaps,
    artifacts: {
      evidence: join(outputDirectory, "evidence.json"),
      report: join(outputDirectory, "report.md"),
      screenshot: join(outputDirectory, "page.png"),
      regression: join(outputDirectory, "regression.spec.js"),
      playwrightConfig: join(outputDirectory, "playwright.config.js")
    },
    provenance: {
      runner: "yellowbird-local-scout",
      runtime: process.versions.bun
        ? `Bun ${process.versions.bun}`
        : `Node ${process.versions.node}`,
      browser: "Playwright Chromium",
      agenticEngine: null
    }
  };

  await Promise.all([
    writeFile(
      report.artifacts.evidence,
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 }
    ),
    writeFile(report.artifacts.report, buildMarkdown(report), { mode: 0o600 }),
    writeFile(report.artifacts.regression, buildRegression(options), {
      mode: 0o600
    }),
    writeFile(report.artifacts.playwrightConfig, buildPlaywrightConfig(), {
      mode: 0o600
    })
  ]);
  await Promise.all(
    Object.values(report.artifacts).map((path) => chmod(path, 0o600))
  );

  return report;
}
