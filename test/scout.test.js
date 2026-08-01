import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "bun:test";
import {
  authorizeScoutTarget,
  createScoutRunner,
  runScout,
  validateWorkflow
} from "../src/scout/scout.js";
import {
  diagnoseBrowserLaunchError,
  diagnoseNavigationError,
  resolveLoopbackScheme
} from "../src/scout/diagnostics.js";
import { resolveOutputOption } from "../src/scout/output.js";

let server;
let target;
let sharedBrowser;
let mutationRequestCount = 0;
let readMutationRequestCount = 0;
let submissionRequestCount = 0;
let crossOriginRequestCount = 0;

async function runCommand(command, cwd, env) {
  const captureDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-command-output-")
  );
  const stdoutPath = join(captureDirectory, "stdout.txt");
  const stderrPath = join(captureDirectory, "stderr.txt");
  const [stdoutHandle, stderrHandle] = await Promise.all([
    open(stdoutPath, "w"),
    open(stderrPath, "w")
  ]);
  try {
    const child = Bun.spawn({
      cmd: command,
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      stdout: stdoutHandle.fd,
      stderr: stderrHandle.fd
    });
    const exitCode = await child.exited;
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
    const [stdout, stderr] = await Promise.all([
      readFile(stdoutPath, "utf8"),
      readFile(stderrPath, "utf8")
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (stdoutHandle.fd !== -1) await stdoutHandle.close();
    if (stderrHandle.fd !== -1) await stderrHandle.close();
  }
}

function assertConformsToSchema(schema, value, path = "$") {
  if (schema.oneOf) {
    let matchingSchemas = 0;
    for (const candidate of schema.oneOf) {
      try {
        assertConformsToSchema(candidate, value, path);
        matchingSchemas += 1;
      } catch {}
    }
    assert.equal(matchingSchemas, 1, `${path} must match exactly one schema`);
    return;
  }
  if (Object.hasOwn(schema, "const")) {
    assert.deepEqual(value, schema.const, `${path} does not match const`);
  }
  if (schema.enum) {
    assert.ok(schema.enum.includes(value), `${path} is not in enum`);
  }
  if (schema.type) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : Number.isInteger(value)
            ? "integer"
            : typeof value;
    assert.ok(
      expectedTypes.includes(actualType),
      `${path} has type ${actualType}, expected ${expectedTypes.join(" or ")}`
    );
  }
  for (const property of schema.required || []) {
    assert.ok(Object.hasOwn(value, property), `${path}.${property} is required`);
  }
  for (const [property, propertySchema] of Object.entries(
    schema.properties || {}
  )) {
    if (Object.hasOwn(value, property)) {
      assertConformsToSchema(propertySchema, value[property], `${path}.${property}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) =>
      assertConformsToSchema(schema.items, item, `${path}[${index}]`)
    );
  }
}

beforeAll(async () => {
  const { chromium } = await import("@playwright/test");
  sharedBrowser = await chromium.launch({ headless: true, timeout: 15_000 });
  server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/agent-write") {
      mutationRequestCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/agent-read-mutation") {
      readMutationRequestCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/agent-submission") {
      submissionRequestCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/agent-cross-origin-read") {
      crossOriginRequestCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/agent-redirect") {
      response.writeHead(302, { location: "/agent-flow" });
      response.end();
      return;
    }
    if (request.url === "/history-return") {
      response.writeHead(302, { location: "/history-surface" });
      response.end();
      return;
    }
    const failing = request.url === "/failing";
    const agentFlow = request.url?.startsWith("/agent-flow");
    const staticPage = request.url?.startsWith("/static");
    const policyBoundary = request.url?.startsWith("/agent-policy-boundary");
    const safetySurface = request.url?.startsWith("/agent-safety-surface");
    const duplicateFields = request.url?.startsWith("/duplicate-fields");
    const readMutationSurface = request.url?.startsWith(
      "/agent-read-mutation-surface"
    );
    const submissionSurface = request.url?.startsWith(
      "/agent-submission-surface"
    );
    const crossOriginSurface = request.url?.startsWith(
      "/agent-cross-origin-surface"
    );
    const redirectSurface = request.url?.startsWith("/agent-redirect-surface");
    const historySurface = request.url?.startsWith("/history-surface");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (policyBoundary) {
      response.end(`<!doctype html>
        <html>
          <head><title>Policy boundary</title></head>
          <body>
            <a href="/delete-account">Delete account</a>
            <button type="button">Add</button>
            <button id="details" type="button">Inspect details</button>
            <script>
              document.querySelector("#details").addEventListener("click", () => {
                fetch("/agent-write", { method: "POST" }).catch(() => {});
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (safetySurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Agent safety surface</title></head>
          <body>
            <a href="http://localhost:${server.address().port}/agent-flow">External setup</a>
            <a href="/login">Sign in</a>
            <form action="/create-monitor">
              <label>Name <input name="name"></label>
              <label>Password <input name="password" type="password"></label>
              <button type="button">Inspect account</button>
            </form>
            <a href="/agent-flow">Inspect setup</a>
          </body>
        </html>`);
      return;
    }
    if (duplicateFields) {
      response.end(`<!doctype html>
        <html>
          <head><title>Duplicate fields</title></head>
          <body>
            <input name="query" aria-label="Query">
            <input name="query" aria-label="Query">
          </body>
        </html>`);
      return;
    }
    if (readMutationSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Read mutation boundary</title></head>
          <body>
            <button type="button">Erase all</button>
            <button type="button">Continue</button>
            <button id="preview" type="button">View preview</button>
            <script>
              document.querySelector("#preview").addEventListener("click", () => {
                fetch("/agent-read-mutation").catch(() => {});
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (submissionSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Submission boundary</title></head>
          <body>
            <form action="/agent-submission" method="get">
              <button id="preview" type="button">View preview</button>
            </form>
            <script>
              document.querySelector("#preview").addEventListener("click", () => {
                document.querySelector("form").requestSubmit();
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (crossOriginSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Cross-origin boundary</title></head>
          <body>
            <button id="preview" type="button">View preview</button>
            <script>
              document.querySelector("#preview").addEventListener("click", () => {
                fetch("http://localhost:${server.address().port}/agent-cross-origin-read").catch(() => {});
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (redirectSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Redirect surface</title></head>
          <body><a href="/agent-redirect">Setup monitor</a></body>
        </html>`);
      return;
    }
    if (historySurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>History surface</title></head>
          <body>
            <a href="/history-return">Setup route</a>
            <input name="query" aria-label="Query">
            <script>
              document.querySelector("[name=query]").addEventListener("input", () => {
                history.pushState({}, "", "/other");
              });
            </script>
          </body>
        </html>`);
      return;
    }
    response.end(`<!doctype html>
      <html>
        <head><title>${agentFlow ? "Monitor setup" : "Feather Shop"}</title></head>
        <body>
          <h1>${agentFlow ? "Create monitor" : "Feather Shop"}</h1>
          <p>${failing ? "Checkout unavailable" : "Checkout ready"}</p>
          ${staticPage ? "<p>No available workflow controls.</p>" : agentFlow ? '<p>Choose a product URL and monitoring rule.</p>' : '<a href="/agent-flow">New monitor</a>'}
          ${staticPage ? "" : '<input name="email">'}
          ${staticPage ? "" : '<button id="checkout">Buy</button>'}
          <p id="status"></p>
          <script>
            document.querySelector("#checkout")?.addEventListener("click", () => {
              document.querySelector("#status").textContent =
                document.querySelector("[name=email]").value ? "Order ready" : "Email required";
            });
          </script>
          ${failing ? '<script>console.error("checkout failed")</script>' : ""}
        </body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  target = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await sharedBrowser.close();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function launchSharedBrowser() {
  let context;
  return {
    async newContext(options) {
      context = await sharedBrowser.newContext(options);
      return context;
    },
    async close() {
      await context?.close();
    }
  };
}

function createAgentRunner(decide, resolveEngineOverride) {
  return createScoutRunner({
    launchBrowser: launchSharedBrowser,
    resolveEngine:
      resolveEngineOverride ||
      (async () => ({
        capabilities: {
          jsonSchema: "verified",
          toolCalls: "unverified",
          imageInput: "unverified"
        },
        diagnostic: null,
        engine: {
          provenance: () => ({
            adapter: "test-compatible-engine",
            endpointClass: "loopback",
            modelRequested: "planner-fixture",
            modelReported: "planner-fixture",
            capabilityManifestVersion: "yellowbird.engine-capabilities.v1"
          }),
          completeStructured: async (request) => ({
            output: await decide(request)
          })
        }
      }))
  });
}

test("scout authorization is loopback-only", () => {
  assert.equal(authorizeScoutTarget(`${target}/`).authorization.scope, "exact-origin");
  assert.throws(
    () => authorizeScoutTarget("https://example.com"),
    /only authorizes loopback targets/
  );
  assert.throws(
    () => authorizeScoutTarget("file:///tmp/index.html"),
    /must use http or https/
  );
});

test("workflow capabilities must be declared before a run", () => {
  assert.throws(
    () =>
      validateWorkflow({
        permissions: ["browser.navigate", "browser.read"],
        steps: [
          {
            id: "submit",
            action: "click",
            selector: "#checkout"
          }
        ]
      }),
    /requires undeclared capability browser.click/
  );
});

test("browser launch errors have actionable test-mechanics diagnostics", () => {
  assert.equal(
    diagnoseBrowserLaunchError("Executable doesn't exist at /tmp/chromium").code,
    "browser-executable-missing"
  );
  assert.equal(
    diagnoseBrowserLaunchError(
      "Host system is missing dependencies to run browsers"
    ).code,
    "browser-host-dependencies-missing"
  );
  assert.equal(
    diagnoseBrowserLaunchError("spawn failed unexpectedly").code,
    "browser-launch-failed"
  );
});

test("loopback HTTP alternatives preserve implicit HTTPS port 443", async () => {
  const originalFetch = globalThis.fetch;
  const probedUrls = [];
  globalThis.fetch = async (url) => {
    probedUrls.push(String(url));
    if (probedUrls.length === 1) {
      throw new Error("TLS probe failed");
    }
    return new Response(null, { status: 200 });
  };

  try {
    const result = await resolveLoopbackScheme(
      "https://127.0.0.1/path?token=secret",
      100,
      () => {}
    );
    assert.equal(
      result.effectiveTarget,
      "http://127.0.0.1:443/path?token=secret"
    );
    assert.deepEqual(probedUrls, [
      "https://127.0.0.1/path?token=secret",
      "http://127.0.0.1:443/path?token=secret"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TLS remediation redacts credentials and query values", () => {
  const diagnostic = diagnoseNavigationError(
    "page.goto failed with net::ERR_SSL_PROTOCOL_ERROR and console secret-value",
    "https://user:password@127.0.0.1/path?token=not-for-logs"
  );

  assert.equal(diagnostic.code, "target-tls-protocol-mismatch");
  assert.match(diagnostic.remediation, /http:\/\/127\.0\.0\.1:443\/path/);
  assert.doesNotMatch(diagnostic.remediation, /user|password|not-for-logs|token/);
});

test("browser launch failure finalizes an inconclusive run", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-launch-"));
  let launchOptions;
  const runWithUnavailableBrowser = createScoutRunner({
    launchBrowser: async (options) => {
      launchOptions = options;
      throw new Error(
        `Executable doesn't exist at /tmp/chromium for ${target}/?secret=hidden`
      );
    }
  });
  const report = await runWithUnavailableBrowser({
    target,
    expectedTexts: ["Checkout ready"],
    permissions: ["browser.navigate", "browser.read", "browser.click"],
    steps: [{ id: "checkout", action: "click", selector: "#checkout" }],
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.deepEqual(launchOptions, { headless: true, timeout: 15_000 });
  assert.deepEqual(report.findings, []);
  assert.equal(report.invalidTestMechanics[0].id, "browser-executable-missing");
  assert.equal(report.observations.browser.launch.successful, false);
  assert.equal(report.observations.navigation.status, "skipped");
  assert.equal(report.observations.navigation.reason, "browser-unavailable");
  assert.deepEqual(
    report.observations.workflowSteps.map(({ status, reason }) => ({ status, reason })),
    [{ status: "skipped", reason: "browser-unavailable" }]
  );
  assert.ok(
    report.coverageGaps.some((gap) =>
      gap.includes("product was not evaluated because the browser was unavailable")
    )
  );
  assert.equal(report.artifacts.screenshot, null);
  await assert.rejects(stat(join(outputDirectory, "page.png")));
  await Promise.all(
    Object.entries(report.artifacts)
      .filter(([name]) => name !== "screenshot")
      .map(([, path]) => stat(path))
  );

  const events = (await readFile(report.artifacts.diagnostics, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.slice(-2).map((event) => event.event),
    ["browser.launch.failed", "run.completed"]
  );
  assert.doesNotMatch(JSON.stringify(events), /secret=hidden/);
});

test("intent-driven scout executes bounded same-origin navigation", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-agent-"));
  const decisions = [
    {
      action: "act",
      elementRef: "element-1",
      value: null,
      rationale: "Open the monitor setup route to assess the basic flow.",
      coverage: "continue",
      summary: ""
    },
    {
      action: "act",
      elementRef: "element-1",
      value: null,
      rationale: "Exercise a safe form field without submitting data.",
      coverage: "continue",
      summary: ""
    },
    {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "The safe read-only portion of the flow was inspected.",
      coverage: "covered",
      summary: "The initial page and monitor setup route were inspected without mutation."
    }
  ];
  const runWithAgent = createAgentRunner(() => decisions.shift());

  const report = await runWithAgent({
    target,
    intent: "Assess the initial interface and basic user flow",
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.equal(report.observations.exploration.requested, true);
  assert.equal(report.observations.exploration.status, "completed");
  assert.equal(report.observations.exploration.coverage, "covered");
  assert.equal(report.observations.exploration.steps.length, 2);
  assert.equal(report.observations.exploration.steps[0].status, "passed");
  assert.equal(
    report.observations.exploration.steps[0].url,
    `${target}/agent-flow`
  );
  assert.equal(report.observations.exploration.steps[1].action, "fill");
  assert.equal(
    report.observations.exploration.steps[1].value,
    "yellowbird@example.test"
  );
  assert.equal(
    report.provenance.agenticEngine,
    "test-compatible-engine:planner-fixture"
  );
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(regression, new RegExp(`${server.address().port}/agent-flow`));
  assert.match(regression, /yellowbirdAgentResponse1/);
  assert.match(regression, /input\[name=\\"email\\"\]/);
  assert.match(regression, /\.nth\(0\)\.fill/);
  const diagnostics = await readFile(report.artifacts.diagnostics, "utf8");
  assert.match(diagnostics, /"event":"agent.engine.ready"/);
  assert.match(diagnostics, /"event":"agent.action.completed"/);
  assert.match(diagnostics, /"event":"agent.completed"/);
});

test("explicit intent exploration retains an API opt-out", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-opt-out-")
  );
  let planningCalls = 0;
  const report = await createAgentRunner(() => {
    planningCalls += 1;
    return null;
  })({
    target,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: false,
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.equal(report.observations.exploration.requested, false);
  assert.equal(planningCalls, 0);
});

test("partial planner coverage is never promoted to covered", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-partial-")
  );
  const decisions = [
    {
      action: "act",
      elementRef: "element-1",
      value: null,
      rationale: "Inspect settings before billing.",
      coverage: "continue",
      summary: ""
    },
    {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "Billing remains unverified.",
      coverage: "partial",
      summary: "Settings were inspected, but billing was not."
    }
  ];

  const report = await createAgentRunner(() => decisions.shift())({
    target,
    intent: "Assess settings and billing flows",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.exploration.status, "inconclusive");
  assert.equal(report.observations.exploration.coverage, "partial");
});

test("planner coverage cannot authorize clear without an owned profile", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-unverified-coverage-")
  );
  const decisions = [
    {
      action: "act",
      elementRef: "element-1",
      value: null,
      rationale: "Open the supplied setup route.",
      coverage: "continue",
      summary: ""
    },
    {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "The requested route was inspected.",
      coverage: "covered",
      summary:
        "The setup route was covered.\u001b]0;owned\u0007 | <script>alert(1)</script>"
    }
  ];

  const report = await createAgentRunner(() => decisions.shift())({
    target,
    intent: "Assess the monitor setup route",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.exploration.status, "inconclusive");
  assert.equal(report.observations.exploration.coverage, "partial");
  assert.equal(report.observations.exploration.verification, null);
  assert.equal(
    report.observations.exploration.summary,
    "The setup route was covered. | <script>alert(1)</script>"
  );
  const markdown = await readFile(report.artifacts.report, "utf8");
  assert.match(
    markdown,
    /unverified model advisory \(cannot authorize covered coverage\)/
  );
  assert.match(markdown, /\\\| \\<script\\>alert\(1\)\\<\/script\\>/);
});

test("planner finish loops fall back to one unambiguous safe setup visit", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-finish-fallback-")
  );
  const report = await createAgentRunner(() => ({
    action: "finish",
    elementRef: null,
    value: null,
    rationale: "No action is needed.",
    coverage: "partial",
    summary: "The planner remained conservative."
  }))({
    target,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.deepEqual(report.observations.exploration.verification, {
    profile: "initial-interface-basic-flow.v1",
    authority: "yellowbird-observed-criteria",
    satisfied: true,
    criteria: [
      { id: "initial-page-observed", satisfied: true },
      { id: "primary-route-visited", satisfied: true },
      { id: "distinct-destination-observed", satisfied: true },
      { id: "destination-controls-observed", satisfied: true },
      { id: "authorized-actions-passed", satisfied: true }
    ],
    summary:
      "YellowBird observed the initial page, visited a distinct authorized setup route, and inventoried safe controls on the destination."
  });
  assert.deepEqual(
    report.observations.exploration.steps.map(({ action, url, status }) => ({
      action,
      url,
      status
    })),
    [{ action: "visit", url: `${target}/agent-flow`, status: "passed" }]
  );
  assert.match(
    await readFile(report.artifacts.diagnostics, "utf8"),
    /"event":"agent.planning.corrected"/
  );
});

test("owned coverage profile links a distinct destination to its visit", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-linked-coverage-")
  );
  const decisions = [
    {
      action: "act",
      elementRef: "element-1",
      value: null,
      rationale: "Open the setup route.",
      coverage: "continue",
      summary: ""
    },
    {
      action: "act",
      elementRef: "element-2",
      value: null,
      rationale: "Inspect the query field.",
      coverage: "continue",
      summary: ""
    },
    {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "The route returned to the initial page.",
      coverage: "covered",
      summary: "The entire basic flow was covered."
    }
  ];
  const report = await createAgentRunner(() => decisions.shift())({
    target: `${target}/history-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.exploration.verification.satisfied, false);
  assert.equal(
    report.observations.exploration.verification.criteria.find(
      (criterion) => criterion.id === "distinct-destination-observed"
    ).satisfied,
    false
  );
  assert.equal(report.observations.exploration.steps[0].sourceUrl, `${target}/history-surface`);
  assert.equal(report.observations.exploration.steps[0].url, `${target}/history-surface`);
  const markdown = await readFile(report.artifacts.report, "utf8");
  assert.match(
    markdown,
    /yellowbird-observed-criteria \(initial-interface-basic-flow\.v1, unsatisfied\)/
  );
  assert.doesNotMatch(markdown, /model-guided within YellowBird policy/);
});

test("agent replay preserves selected and observed redirect URLs", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-redirect-replay-")
  );
  const decisions = [
    {
      action: "act",
      elementRef: "element-1",
      value: null,
      rationale: "Open the setup route.",
      coverage: "continue",
      summary: ""
    },
    {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "The redirected setup route was observed.",
      coverage: "covered",
      summary: "The setup route was observed."
    }
  ];
  const report = await createAgentRunner(() => decisions.shift())({
    target: `${target}/agent-redirect-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.equal(
    report.observations.exploration.steps[0].requestedUrl,
    `${target}/agent-redirect`
  );
  assert.equal(
    report.observations.exploration.steps[0].url,
    `${target}/agent-flow`
  );
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(regression, /agent-redirect/);
  assert.match(regression, /toHaveURL/);
  assert.match(regression, /agent-flow/);
});

test("mutation-oriented intent remains inconclusive at the safe boundary", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-mutation-")
  );
  const decisions = [
    {
      action: "act",
      elementRef: "element-1",
      value: null,
      rationale: "Open the monitor setup route.",
      coverage: "continue",
      summary: ""
    },
    {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "Submission is outside the authorized profile.",
      coverage: "covered",
      summary: "The setup page was inspected, but no monitor was submitted."
    }
  ];
  const report = await createAgentRunner(() => decisions.shift())({
    target,
    intent: "Assess the monitor flow and submit a monitor",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.findings.length, 0);
  assert.equal(report.observations.exploration.coverage, "partial");
  assert.equal(
    report.invalidTestMechanics[0].id,
    "agent-intent-not-fully-covered"
  );
  assert.match(
    report.coverageGaps.join("\n"),
    /form submission, mutation, authentication, and cross-origin behavior were not authorized|requested intent was not fully exercised/
  );
});

test("a requested flow with no authorized action is inconclusive", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-no-actions-")
  );
  let planningCalls = 0;
  const report = await createAgentRunner(() => {
    planningCalls += 1;
    return {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "Nothing is available.",
      coverage: "covered",
      summary: "The flow was covered."
    };
  })({
    target: `${target}/static`,
    intent: "Assess the basic user flow",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(planningCalls, 0);
  assert.equal(
    report.invalidTestMechanics[0].id,
    "agent-no-authorized-actions"
  );
  assert.equal(report.observations.exploration.coverage, "blocked");
});

test("initial assertions remain aligned with the generated replay", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-assertions-")
  );
  const decisions = [
    {
      action: "act",
      elementRef: "element-1",
      value: null,
      rationale: "Open the setup flow.",
      coverage: "continue",
      summary: ""
    },
    {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "The setup route was observed.",
      coverage: "covered",
      summary: "The landing page and setup route were inspected."
    }
  ];
  const report = await createAgentRunner(() => decisions.shift())({
    target,
    intent: "Assess the initial interface and basic user flow",
    expectedTitle: "Feather Shop",
    expectedTexts: ["Checkout ready"],
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.equal(report.observations.title, "Monitor setup");
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.ok(
    regression.indexOf('toHaveTitle("Feather Shop")') <
      regression.indexOf("yellowbirdAgentResponse1")
  );
});

test("agent cannot select a form-submit control omitted by policy", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-policy-")
  );
  const report = await createAgentRunner(() => ({
    action: "act",
    elementRef: "element-3",
    value: null,
    rationale: "Try to use the submit control.",
    coverage: "continue",
    summary: ""
  }))({
    target,
    intent: "Assess the purchase control",
    exploreIntent: true,
    maxAgentSteps: 1,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.exploration.steps.length, 0);
  assert.equal(report.invalidTestMechanics[0].id, "agent-action-invalid");
  assert.doesNotMatch(report.observations.exploration.summary, /completed/i);
});

test("agent policy omits destructive controls and blocks write requests", async () => {
  mutationRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-write-boundary-")
  );
  const exposedLabels = [];
  let planningCall = 0;
  const report = await createAgentRunner((request) => {
    const plannerInput = JSON.parse(request.messages.at(-1).content);
    exposedLabels.push(
      ...plannerInput.page.availableElements.map((element) => element.label)
    );
    planningCall += 1;
    return planningCall === 1
      ? {
          action: "act",
          elementRef: "element-3",
          value: null,
          rationale: "Inspect the details control.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The details interaction was inspected.",
          coverage: "covered",
          summary: "The details interaction was inspected."
        };
  })({
    target: `${target}/agent-policy-boundary`,
    intent: "Assess the details interaction",
    exploreIntent: true,
    outputDirectory
  });

  assert.deepEqual([...new Set(exposedLabels)], ["Inspect details"]);
  assert.equal(mutationRequestCount, 0);
  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.findings.length, 0);
  assert.equal(report.observations.exploration.coverage, "partial");
  assert.equal(report.invalidTestMechanics[0].id, "agent-effect-blocked");
  assert.ok(
    report.observations.blockedRequests.some(
      (request) =>
        request.method === "POST" &&
        request.reason === "agent-non-read-method"
    )
  );
});

test("agent action broker and replay block read-method mutation behind safe-looking controls", async () => {
  readMutationRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-read-mutation-")
  );
  const exposedLabels = [];
  let planningCall = 0;
  const report = await createAgentRunner((request) => {
    const plannerInput = JSON.parse(request.messages.at(-1).content);
    const availableElements = plannerInput.page.availableElements;
    exposedLabels.push(...availableElements.map((element) => element.label));
    planningCall += 1;
    return planningCall === 1
      ? {
          action: "act",
          elementRef: availableElements[0].ref,
          value: null,
          rationale: "View the supplied preview control.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The preview control was inspected.",
          coverage: "covered",
          summary: "The preview control was inspected."
        };
  })({
    target: `${target}/agent-read-mutation-surface`,
    intent: "Assess the preview interaction",
    exploreIntent: true,
    outputDirectory
  });

  assert.deepEqual([...new Set(exposedLabels)], ["View preview"]);
  assert.equal(readMutationRequestCount, 0);
  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.invalidTestMechanics[0].id, "agent-effect-blocked");
  assert.ok(
    report.observations.blockedRequests.some(
      (request) => request.reason === "agent-non-visit-request"
    )
  );
  readMutationRequestCount = 0;
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
  assert.equal(readMutationRequestCount, 0);
}, 30_000);

test("agent action broker blocks GET form submission", async () => {
  submissionRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-submission-")
  );
  let planningCall = 0;
  const report = await createAgentRunner((request) => {
    const availableElements = JSON.parse(
      request.messages.at(-1).content
    ).page.availableElements;
    planningCall += 1;
    return planningCall === 1
      ? {
          action: "act",
          elementRef: availableElements[0].ref,
          value: null,
          rationale: "View the supplied preview control.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The preview control was inspected.",
          coverage: "covered",
          summary: "The preview control was inspected."
        };
  })({
    target: `${target}/agent-submission-surface`,
    intent: "Assess the preview interaction",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(submissionRequestCount, 0);
  assert.equal(report.outcome, "inconclusive");
  assert.ok(
    report.observations.blockedRequests.some(
      (request) => request.reason === "agent-form-submission"
    )
  );
});

test("cross-origin effects attempted during exploration are inconclusive", async () => {
  crossOriginRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-cross-origin-")
  );
  let planningCall = 0;
  const report = await createAgentRunner((request) => {
    const availableElements = JSON.parse(
      request.messages.at(-1).content
    ).page.availableElements;
    planningCall += 1;
    return planningCall === 1
      ? {
          action: "act",
          elementRef: availableElements[0].ref,
          value: null,
          rationale: "View the supplied preview control.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The preview control was inspected.",
          coverage: "covered",
          summary: "The preview control was inspected."
        };
  })({
    target: `${target}/agent-cross-origin-surface`,
    intent: "Assess the preview interaction",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(crossOriginRequestCount, 0);
  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.exploration.coverage, "partial");
  assert.ok(
    report.observations.blockedRequests.some(
      (request) => request.reason === "agent-cross-origin"
    )
  );
});

test("agent policy omits cross-origin and authentication controls", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-safety-surface-")
  );
  const exposedLabels = [];
  let planningCall = 0;
  const report = await createAgentRunner((request) => {
    const plannerInput = JSON.parse(request.messages.at(-1).content);
    const availableElements = plannerInput.page.availableElements;
    exposedLabels.push(availableElements.map((element) => element.label));
    planningCall += 1;
    return planningCall === 1
      ? {
          action: "act",
          elementRef: availableElements[0].ref,
          value: null,
          rationale: "Inspect the supplied same-origin setup route.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The safe setup route was inspected.",
          coverage: "covered",
          summary: "The safe same-origin setup route was inspected."
        };
  })({
    target: `${target}/agent-safety-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    outputDirectory
  });

  assert.deepEqual(exposedLabels[0], ["Inspect setup"]);
  assert.equal(report.outcome, "clear");
  assert.equal(report.observations.exploration.steps[0].action, "visit");
  assert.equal(report.observations.exploration.steps[0].url, `${target}/agent-flow`);
});

test("agent replay persists and verifies duplicate locator ordinals", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-duplicate-locator-")
  );
  const decisions = [
    {
      action: "act",
      elementRef: "element-2",
      value: null,
      rationale: "Exercise the second query field.",
      coverage: "continue",
      summary: ""
    },
    {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "The requested field was exercised.",
      coverage: "covered",
      summary: "The second query field was exercised."
    }
  ];
  const report = await createAgentRunner(() => decisions.shift())({
    target: `${target}/duplicate-fields`,
    intent: "Assess the second query field interaction",
    exploreIntent: true,
    outputDirectory
  });

  assert.deepEqual(report.observations.exploration.steps[0].locator, {
    kind: "css",
    selector: 'input[name="query"]',
    ordinal: 1,
    matchCount: 2
  });
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(regression, /toHaveCount\(2\)/);
  assert.match(regression, /\.nth\(1\)\.fill/);
  assert.doesNotMatch(regression, /\.first\(\)/);
});

test("scout refreshes provenance and rejects planner model transitions", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-model-transition-")
  );
  let modelReported = "probe-model";
  let planningCall = 0;
  const report = await createAgentRunner(
    () => null,
    async () => ({
      capabilities: {
        jsonSchema: "verified",
        toolCalls: "unverified",
        imageInput: "unverified"
      },
      diagnostic: null,
      engine: {
        provenance: () => ({
          adapter: "test-compatible-engine",
          endpointClass: "loopback",
          modelRequested: "planner-fixture",
          modelReported,
          capabilityManifestVersion: "yellowbird.engine-capabilities.v1"
        }),
        completeStructured: async () => {
          planningCall += 1;
          modelReported = "planner-model";
          return {
            output:
              planningCall === 1
                ? {
                    action: "act",
                    elementRef: "element-1",
                    value: null,
                    rationale: "Inspect the setup route.",
                    coverage: "continue",
                    summary: ""
                  }
                : {
                    action: "finish",
                    elementRef: null,
                    value: null,
                    rationale: "The route was inspected.",
                    coverage: "covered",
                    summary: "The setup route was inspected."
                  }
          };
        }
      }
    })
  )({
    target,
    intent: "Assess the setup flow",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.invalidTestMechanics[0].id, "agent-model-transition");
  assert.equal(report.provenance.engine.modelReported, "planner-model");
  assert.equal(
    report.provenance.agenticEngine,
    "test-compatible-engine:planner-model"
  );
});

test("an engine resolver defect still finalizes a truthful run", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-resolver-")
  );
  const report = await createAgentRunner(
    () => null,
    async () => {
      throw new Error("resolver defect with private console content");
    }
  )({
    target,
    intent: "Assess the initial interface",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(
    report.invalidTestMechanics[0].id,
    "agent-engine-resolution-failed"
  );
  assert.doesNotMatch(
    JSON.stringify(report.invalidTestMechanics),
    /private console content/
  );
  await Promise.all(
    Object.values(report.artifacts)
      .filter(Boolean)
      .map((path) => stat(path))
  );
});

test("unavailable intent engine is inconclusive instead of a narrow clear", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-unavailable-")
  );
  const runWithoutAgent = createScoutRunner({
    launchBrowser: launchSharedBrowser,
    resolveEngine: async () => ({
      engine: null,
      capabilities: null,
      diagnostic: {
        id: "agent-engine-unavailable",
        classification: "test-mechanics",
        title: "No compatible local agent engine is available.",
        evidence: "connection refused",
        remediation: "Start Ollama with a compatible model."
      }
    })
  });

  const report = await runWithoutAgent({
    target,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.deepEqual(report.findings, []);
  assert.equal(report.observations.navigation.completed, true);
  assert.equal(report.observations.exploration.status, "inconclusive");
  assert.equal(
    report.invalidTestMechanics[0].id,
    "agent-engine-unavailable"
  );
  assert.match(
    await readFile(report.artifacts.report, "utf8"),
    /requested intent was not fully exercised/i
  );
});

test("CLI persists an inconclusive run when Chromium is not installed", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-cli-launch-"));
  const emptyBrowserDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-empty-browsers-")
  );
  const result = await runCommand(
    [
      process.execPath,
      resolve("bin/yellowbird.js"),
      "scout",
      "--target",
      target,
      "--output",
      outputDirectory
    ],
    resolve("."),
    { PLAYWRIGHT_BROWSERS_PATH: emptyBrowserDirectory }
  );

  assert.equal(result.exitCode, 3, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /browser-executable-missing/);
  const evidence = JSON.parse(
    await readFile(join(outputDirectory, "evidence.json"), "utf8")
  );
  assert.equal(evidence.outcome, "inconclusive");
  assert.equal(evidence.artifacts.screenshot, null);
});

test("CLI redacts repaired target query values while evidence stays exact", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-cli-repair-"));
  const secret = "not-for-cli-logs";
  const requestedTarget = `${target.replace("http:", "https:")}/?token=${secret}`;
  const repairedTarget = `${target}/?token=${secret}`;
  const result = await runCommand(
    [
      process.execPath,
      resolve("bin/yellowbird.js"),
      "scout",
      "--target",
      requestedTarget,
      "--output",
      outputDirectory
    ],
    resolve(".")
  );

  assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    new RegExp(
      `Target repaired: https://127\\.0\\.0\\.1:${server.address().port}/ -> http://127\\.0\\.0\\.1:${server.address().port}/`
    )
  );
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stderr, new RegExp(secret));

  const evidence = JSON.parse(
    await readFile(join(outputDirectory, "evidence.json"), "utf8")
  );
  assert.equal(evidence.target.repairs[0].from, requestedTarget);
  assert.equal(evidence.target.repairs[0].to, repairedTarget);
});

test("CLI intent runs a real bounded agent loop through a compatible endpoint", async () => {
  let plannerCalls = 0;
  const engineServer = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "planner-fixture" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const schemaName = body.response_format?.json_schema?.name;
    const output = schemaName === "yellowbird_capability_probe"
      ? { status: "ready", nextAction: "inspect" }
      : plannerCalls++ === 0
        ? {
            action: "act",
            elementRef: "element-1",
            value: null,
            rationale: "Inspect the basic setup flow.",
            coverage: "continue",
            summary: ""
          }
        : plannerCalls === 2
          ? {
              action: "act",
              elementRef: "element-1",
              value: null,
              rationale: "Exercise the safe form field.",
              coverage: "continue",
              summary: ""
            }
          : {
            action: "finish",
            elementRef: null,
            value: null,
            rationale: "The read-only route was inspected.",
            coverage: "covered",
            summary:
              "The setup route was inspected.\u001b]0;owned\u0007 | <script>alert(1)</script>"
          };
    response.end(
      JSON.stringify({
        model: "planner-fixture",
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(output) }
          }
        ]
      })
    );
  });
  await new Promise((resolve, reject) => {
    engineServer.once("error", reject);
    engineServer.listen(0, "127.0.0.1", resolve);
  });

  try {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "yellowbird-cli-agent-")
    );
    const result = await runCommand(
      [
        process.execPath,
        resolve("bin/yellowbird.js"),
        "scout",
        "--target",
        target,
        "--intent",
        "Assess the initial interface and basic user flow",
        "--engine-base-url",
        `http://127.0.0.1:${engineServer.address().port}/v1`,
        "--engine-model",
        "planner-fixture",
        "--output",
        outputDirectory
      ],
      resolve(".")
    );

    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Agent: completed/);
    assert.match(result.stdout, /2 bounded agent interaction step/);
    assert.doesNotMatch(
      result.stdout,
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
    );
    const evidence = JSON.parse(
      await readFile(join(outputDirectory, "evidence.json"), "utf8")
    );
    assert.equal(evidence.observations.exploration.status, "completed");
    assert.equal(evidence.observations.exploration.steps.length, 2);
    assert.equal(evidence.observations.exploration.steps[1].action, "fill");
    assert.equal(
      evidence.observations.exploration.steps[1].value,
      "yellowbird@example.test"
    );
    assert.equal(
      evidence.provenance.agenticEngine,
      "openai-compatible-chat:planner-fixture"
    );
    assert.equal(
      evidence.observations.exploration.summary,
      "YellowBird observed the initial page, visited a distinct authorized setup route, and inventoried safe controls on the destination."
    );
    const markdown = await readFile(join(outputDirectory, "report.md"), "utf8");
    assert.doesNotMatch(markdown, /script|alert\(1\)|owned/);
    const schema = JSON.parse(
      await readFile(resolve("schemas/scout-evidence.v2.schema.json"), "utf8")
    );
    assertConformsToSchema(schema, evidence);
  } finally {
    await new Promise((resolve, reject) => {
      engineServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test(
  "CLI reports a configured but unavailable intent engine as inconclusive",
  async () => {
    const unavailable = createServer();
    await new Promise((resolve, reject) => {
      unavailable.once("error", reject);
      unavailable.listen(0, "127.0.0.1", resolve);
    });
    const unavailablePort = unavailable.address().port;
    await new Promise((resolve, reject) => {
      unavailable.close((error) => (error ? reject(error) : resolve()));
    });
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "yellowbird-cli-engine-unavailable-")
    );
    const result = await runCommand(
      [
        process.execPath,
        resolve("bin/yellowbird.js"),
        "scout",
        "--target",
        target,
        "--intent",
        "Assess the initial interface",
        "--engine-base-url",
        `http://127.0.0.1:${unavailablePort}/v1`,
        "--output",
        outputDirectory
      ],
      resolve(".")
    );

    assert.equal(result.exitCode, 3, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /inconclusive/);
    assert.match(result.stdout, /agent-engine-unavailable/);
    assert.match(result.stdout, /Start the configured engine endpoint/);
    assert.doesNotMatch(result.stderr, /yellowbird:/i);
    const evidence = JSON.parse(
      await readFile(join(outputDirectory, "evidence.json"), "utf8")
    );
    assert.equal(evidence.outcome, "inconclusive");
    assert.equal(evidence.observations.exploration.coverage, "blocked");
  },
  15_000
);

test("scout writes portable evidence and a deterministic regression", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-clear-"));
  const report = await runScout({
    target,
    expectedTitle: "Feather Shop",
    expectedTexts: ["Checkout ready"],
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.equal(report.findings.length, 0);
  assert.equal(report.observations.status, 200);
  assert.equal(report.target.authorization.method, "local-loopback-attestation");

  await Promise.all(Object.values(report.artifacts).map((path) => stat(path)));
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(regression, /toHaveTitle\("Feather Shop"\)/);
  assert.match(regression, /toContainText\("Checkout ready"\)/);

  const evidence = JSON.parse(await readFile(report.artifacts.evidence, "utf8"));
  const schema = JSON.parse(
    await readFile(resolve("schemas/scout-evidence.v2.schema.json"), "utf8")
  );
  assert.equal(evidence.schema, "yellowbird.scout-evidence.v2");
  assert.equal(schema.properties.schema.const, evidence.schema);
  assertConformsToSchema(schema, evidence);
  assert.equal(evidence.provenance.agenticEngine, null);
});

test("historical v1 scout evidence remains valid", async () => {
  const schema = JSON.parse(
    await readFile(resolve("schemas/scout-evidence.v1.schema.json"), "utf8")
  );
  const historicalEvidence = {
    schema: "yellowbird.scout-evidence.v1",
    outcome: "clear",
    intent: "Verify the initial page",
    run: {
      id: "scout_historical",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 25
    },
    target: {
      url: "http://127.0.0.1:3000/",
      origin: "http://127.0.0.1:3000",
      authorization: {
        method: "local-loopback-attestation",
        scope: "exact-origin",
        rationale: "Historical fixture"
      }
    },
    assertions: {
      expectedStatus: 200,
      expectedTitle: null,
      expectedTexts: [],
      consoleErrorsAllowed: false
    },
    findings: [],
    observations: {},
    coverageGaps: [],
    artifacts: {
      evidence: "evidence.json",
      report: "report.md",
      screenshot: "page.png",
      regression: "regression.spec.js",
      playwrightConfig: "playwright.config.js"
    },
    provenance: {
      runner: "yellowbird-local-scout",
      runtime: "Bun 1.3.9",
      browser: "Playwright Chromium",
      agenticEngine: null
    }
  };

  assertConformsToSchema(schema, historicalEvidence);
});

test("scout reports explicit failures without changing expected results", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-attention-"));
  const report = await runScout({
    target: `${target}/failing`,
    expectedTitle: "Feather Shop",
    expectedTexts: ["Checkout ready"],
    outputDirectory
  });

  assert.equal(report.outcome, "attention");
  assert.deepEqual(
    report.findings.map((finding) => finding.id).sort(),
    ["console-errors", "missing-text"]
  );
  assert.deepEqual(report.assertions.expectedTexts, ["Checkout ready"]);

  const diagnostics = await readFile(report.artifacts.diagnostics, "utf8");
  assert.doesNotMatch(diagnostics, /checkout failed/);
});

test("scout repairs a loopback HTTPS-to-HTTP transport mismatch with diagnostics", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-repair-"));
  const reportPath = join(outputDirectory, "price-scout.md");
  const requestedTarget = `${target.replace("http:", "https:")}/?token=not-for-logs`;
  const report = await runScout({
    target: requestedTarget,
    expectedTitle: "Feather Shop",
    expectedTexts: ["Checkout ready"],
    outputDirectory,
    reportPath
  });

  assert.equal(report.outcome, "clear");
  assert.equal(report.target.requestedUrl, requestedTarget);
  assert.equal(report.target.url, `${target}/?token=not-for-logs`);
  assert.deepEqual(
    report.target.repairs.map(({ code, expectedResultChanged }) => ({
      code,
      expectedResultChanged
    })),
    [{ code: "loopback-scheme-repaired", expectedResultChanged: false }]
  );
  assert.equal(report.findings.length, 0);
  assert.equal(report.invalidTestMechanics.length, 0);
  assert.equal(report.artifacts.report, reportPath);
  await stat(reportPath);

  const diagnostics = await readFile(report.artifacts.diagnostics, "utf8");
  const events = diagnostics
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.event === "target.scheme_repaired"));
  assert.ok(events.some((event) => event.event === "navigation.completed"));
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1)
  );
  assert.ok(events.every((event) => event.runId === report.run.id));
  assert.doesNotMatch(diagnostics, /not-for-logs/);

  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
}, 30_000);

test("navigation setup failures are inconclusive and not duplicate product findings", async () => {
  const unavailable = createServer();
  await new Promise((resolve, reject) => {
    unavailable.once("error", reject);
    unavailable.listen(0, "127.0.0.1", resolve);
  });
  const unavailablePort = unavailable.address().port;
  await new Promise((resolve, reject) => {
    unavailable.close((error) => (error ? reject(error) : resolve()));
  });

  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-unavailable-"));
  const report = await runScout({
    target: `http://127.0.0.1:${unavailablePort}`,
    timeoutMs: 250,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.findings.length, 0);
  assert.equal(report.invalidTestMechanics.length, 1);
  assert.equal(
    report.invalidTestMechanics[0].id,
    "target-connection-refused"
  );
  assert.equal(report.observations.navigation.completed, false);
  assert.ok(report.observations.failedRequests.length >= 1);
});

test("a markdown output option separates the report from its evidence bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yellowbird-output-"));
  const reportPath = join(directory, "price-scout.md");
  const output = await resolveOutputOption(reportPath);

  assert.equal(output.reportPath, reportPath);
  assert.equal(output.outputDirectory, join(directory, "price-scout.assets"));

  const legacyDirectory = join(directory, "legacy.md");
  await mkdir(legacyDirectory);
  await assert.rejects(
    resolveOutputOption(legacyDirectory),
    /existing directory created by older YellowBird behavior/
  );
});

test("scout executes a permission-declared workflow and generates its regression", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-workflow-"));
  const report = await runScout({
    target,
    intent: "Prepare an order",
    permissions: [
      "browser.navigate",
      "browser.read",
      "browser.fill",
      "browser.click"
    ],
    steps: [
      {
        id: "enter-email",
        action: "fill",
        selector: "[name=email]",
        value: "bird@example.test"
      },
      {
        id: "prepare-order",
        action: "click",
        selector: "#checkout"
      },
      {
        id: "confirm-ready",
        action: "expectText",
        selector: "#status",
        text: "Order ready"
      }
    ],
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.deepEqual(
    report.observations.workflowSteps.map(({ id, status }) => ({ id, status })),
    [
      { id: "enter-email", status: "passed" },
      { id: "prepare-order", status: "passed" },
      { id: "confirm-ready", status: "passed" }
    ]
  );
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(regression, /locator\("\[name=email\]"\)\.fill/);
  assert.match(regression, /locator\("#checkout"\)\.click/);
  assert.match(regression, /toContainText\("Order ready"\)/);
});

test("an unexecutable owner action is inconclusive rather than a product pass", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-invalid-"));
  const report = await runScout({
    target,
    permissions: ["browser.navigate", "browser.read", "browser.click"],
    steps: [
      {
        id: "missing-control",
        action: "click",
        selector: "#does-not-exist"
      }
    ],
    timeoutMs: 500,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.findings.length, 0);
  assert.equal(report.observations.workflowSteps[0].status, "invalid");
  assert.ok(
    report.coverageGaps.some((gap) => gap.includes("did not attempt selector healing"))
  );
});
