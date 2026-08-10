import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "bun:test";
import {
  authorizeScoutTarget,
  createScoutRunner,
  validateWorkflow
} from "../src/scout/scout.js";
import {
  diagnoseBrowserLaunchError,
  diagnoseNavigationError,
  resolveLoopbackScheme
} from "../src/scout/diagnostics.js";
import {
  browserRenderedTextSnapshot,
  exploreIntentWithEngine,
  isAgentUrlAllowed,
  PROHIBITED_AGENT_ACTION_PATTERN
} from "../src/scout/explorer.js";
import { resolveOutputOption } from "../src/scout/output.js";
import { loadScenarioFile } from "../src/scout/scenario.js";

let server;
let target;
let sharedBrowser;
let mutationRequestCount = 0;
let readMutationRequestCount = 0;
let delayedReadMutationRequestCount = 0;
let initialVisitReadRequestCount = 0;
let initialDelayedVisitMutationRequestCount = 0;
let visitReadRequestCount = 0;
let delayedVisitMutationRequestCount = 0;
let visitEventSourceRequestCount = 0;
let visitWebSocketUpgradeCount = 0;
let failedVisitDelayedRequestCount = 0;
let submissionRequestCount = 0;
let authorizedMutationRequestCount = 0;
let crossOriginRequestCount = 0;
let prohibitedRedirectRequestCount = 0;
let deleteAccountRequestCount = 0;
let delete2FARequestCount = 0;
let relatedTargetEffectCount = 0;
let sameUrlCorrelationRequestCount = 0;
let replaySettlementDelayedRequestCount = 0;
let zeroConfigBackgroundRequestCount = 0;
let failVisitNavigation = false;
let changeReplaySettlementUrl = false;
let hideAgentFlowHeading = false;
let visualFixtureChanged = false;

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

async function startIntentFlowTarget() {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      resolve("test/fixtures/intent-flow/server.js")
    ],
    cwd: resolve("."),
    stdout: "pipe",
    stderr: "pipe"
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(`Intent flow target exited before startup: ${stderr}`);
    }
    output += decoder.decode(value, { stream: true });
  }
  const { url } = JSON.parse(output.slice(0, output.indexOf("\n")));
  reader.releaseLock();
  return {
    url,
    async close() {
      child.kill("SIGTERM");
      await child.exited;
    }
  };
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
    if (request.method === "GET" && request.url === "/command-fixture") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <head><title>Command fixture</title></head>
          <body>
            <select id="choice"><option value="alpha">Alpha</option><option value="beta">Beta</option></select>
            <label><input id="enabled" type="checkbox"> Enabled</label>
            <button id="hover" type="button">Hover target</button>
            <input id="keys" aria-label="Keyboard target">
            <p id="status">Ready</p>
            <script>
              const status = document.querySelector("#status");
              document.querySelector("#enabled").addEventListener("change", event => {
                status.textContent = event.target.checked ? "Checked" : "Unchecked";
              });
              document.querySelector("#hover").addEventListener("mouseenter", () => {
                status.textContent = "Hovered";
              });
              document.querySelector("#keys").addEventListener("keydown", event => {
                if (event.key === "Enter") status.textContent = "Pressed Enter";
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (request.method === "GET" && request.url === "/visual-fixture") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <head><title>Visual fixture</title></head>
          <body style="margin: 0">
            <section id="card" style="width: 240px; height: 120px; background: ${visualFixtureChanged ? "rgb(180, 20, 20)" : "rgb(20, 80, 180)"}; color: white; display: flex; align-items: center; justify-content: center; font: 20px sans-serif">Visual contract</section>
          </body>
        </html>`);
      return;
    }
    if (request.method === "POST" && request.url === "/api/fixture-items") {
      authorizedMutationRequestCount += 1;
      response.writeHead(303, { location: "/authorized-workflow-complete" });
      response.end();
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/authorized-workflow-complete"
    ) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html><head><title>Fixture committed</title></head>
        <body><h1>Fixture committed successfully</h1></body></html>`);
      return;
    }
    if (request.method === "GET" && request.url === "/authorized-workflow") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <head><title>Authorized fixture workflow</title></head>
          <body>
            <form action="/api/fixture-items" method="post">
              <label>Fixture name <input name="fixtureName" type="text"></label>
              <button type="submit">Commit fixture</button>
            </form>
          </body>
        </html>`);
      return;
    }
    if (request.method === "GET" && request.url === "/zero-config-flow-data") {
      zeroConfigBackgroundRequestCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ready: true }));
      return;
    }
    if (request.method === "GET" && request.url === "/zero-config-flow") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <head><title>Zero-config dashboard</title></head>
          <body>
            <h1>Product monitors</h1>
            <a href="/zero-config-setup">New monitor</a>
            <script>
              const refresh = () => fetch("/zero-config-flow-data").catch(() => {});
              refresh();
              setInterval(refresh, 100);
            </script>
          </body>
        </html>`);
      return;
    }
    if (request.method === "GET" && request.url === "/zero-config-setup") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <head><title>Zero-config setup</title></head>
          <body>
            <h1>Track any public product page</h1>
            <input type="url" aria-label="Product URL">
            <textarea aria-label="Tracking instruction"></textarea>
            <select aria-label="Frequency"><option>Daily</option></select>
            <button type="submit">Compile monitor</button>
          </body>
        </html>`);
      return;
    }
    if (request.method === "GET" && request.url === "/implicit-static-app.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(
        'document.querySelector("#hydration-status").textContent = "Application hydrated";'
      );
      return;
    }
    if (request.method === "GET" && request.url === "/implicit-static-app.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end("#hydration-status { display: block; }");
      return;
    }
    if (request.method === "GET" && request.url === "/implicit-static-app") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <head>
            <title>Hydrated application</title>
            <link rel="stylesheet" href="/implicit-static-app.css">
          </head>
          <body>
            <h1 id="hydration-status">Application shell</h1>
            <script src="/implicit-static-app.js"></script>
          </body>
        </html>`);
      return;
    }
    if (request.method === "GET" && request.url === "/delayed-workflow") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <head><title>Delayed workflow</title></head>
          <body>
            <input name="email" aria-label="Email">
            <button id="checkout">Buy</button>
            <p id="status"></p>
            <script>
              document.querySelector("#checkout").addEventListener("click", () => {
                setTimeout(() => {
                  document.querySelector("#status").textContent =
                    document.querySelector("[name=email]").value
                      ? "Order ready"
                      : "Email required";
                }, 200);
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (request.method === "GET" && request.url === "/ambiguous-healing") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <head><title>Ambiguous healing</title></head>
          <body>
            <button>Buy now</button>
            <button>Buy later</button>
          </body>
        </html>`);
      return;
    }
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
    if (
      request.method === "GET" &&
      request.url === "/agent-delayed-read-mutation"
    ) {
      delayedReadMutationRequestCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/agent-initial-visit-data"
    ) {
      initialVisitReadRequestCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/agent-initial-delayed-visit-mutation"
    ) {
      initialDelayedVisitMutationRequestCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/agent-visit-data"
    ) {
      visitReadRequestCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/agent-delayed-visit-mutation"
    ) {
      delayedVisitMutationRequestCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/agent-visit-events") {
      visitEventSourceRequestCount += 1;
      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": "text/event-stream"
      });
      response.write("data: ready\n\n");
      const timer = setTimeout(() => response.end(), 350);
      response.once("close", () => clearTimeout(timer));
      return;
    }
    if (request.method === "GET" && request.url === "/agent-same-url-correlation") {
      sameUrlCorrelationRequestCount += 1;
      if (sameUrlCorrelationRequestCount === 1) {
        const timer = setTimeout(() => response.end("late"), 500);
        response.once("close", () => clearTimeout(timer));
      } else {
        response.writeHead(302, { location: "/deleteAccount" });
        response.end();
      }
      return;
    }
    if (request.method === "GET" && request.url === "/agent-replay-settlement-delayed") {
      replaySettlementDelayedRequestCount += 1;
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
    if (request.url === "/agent-prohibited-redirect") {
      response.writeHead(302, { location: "/agent-flow#auth_callback" });
      response.end();
      return;
    }
    if (request.url === "/agent-fetch-redirect") {
      response.writeHead(302, { location: "/deleteAccount" });
      response.end();
      return;
    }
    if (request.url === "/agent-failed-visit-delayed") {
      failedVisitDelayedRequestCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/agent-failed-visit-destination" && failVisitNavigation) {
      request.socket.destroy();
      return;
    }
    if (request.url === "/auth_callback") {
      prohibitedRedirectRequestCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/deleteAccount") {
      deleteAccountRequestCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/delete2FA") {
      delete2FARequestCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/agent-related-target-effect") {
      relatedTargetEffectCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/agent-independent-failure") {
      const timer = setTimeout(() => response.end("late"), 500);
      response.once("close", () => clearTimeout(timer));
      return;
    }
    if (request.url === "/history-return") {
      response.writeHead(302, { location: "/history-surface" });
      response.end();
      return;
    }
    if (request.url === "/agent-http-error-destination") {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <head><title>Missing preview</title></head>
          <body><input name="query" aria-label="Query"></body>
        </html>`);
      return;
    }
    if (request.url === "/agent-product-http-error") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "catalog unavailable" }));
      return;
    }
    if (request.url === "/agent-product-network-failure") {
      request.socket.destroy();
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
    const delayedMutationSurface = request.url?.startsWith(
      "/agent-delayed-mutation-surface"
    );
    const delayedVisitMutationSurface = request.url?.startsWith(
      "/agent-delayed-visit-mutation-surface"
    );
    const delayedVisitMutationDestination = request.url?.startsWith(
      "/agent-delayed-visit-destination"
    );
    const submissionSurface = request.url?.startsWith(
      "/agent-submission-surface"
    );
    const crossOriginSurface = request.url?.startsWith(
      "/agent-cross-origin-surface"
    );
    const preAbortedCrossOriginSurface = request.url?.startsWith(
      "/agent-pre-aborted-cross-origin-surface"
    );
    const redirectSurface = request.url?.startsWith("/agent-redirect-surface");
    const prohibitedRedirectSurface = request.url?.startsWith(
      "/agent-prohibited-redirect-surface"
    );
    const fetchRedirectSurface = request.url?.startsWith(
      "/agent-fetch-redirect-surface"
    );
    const fetchRedirectDestination = request.url?.startsWith(
      "/agent-fetch-redirect-destination"
    );
    const failedVisitSurface = request.url?.startsWith(
      "/agent-failed-visit-surface"
    );
    const failedVisitDestination = request.url?.startsWith(
      "/agent-failed-visit-destination"
    );
    const historySurface = request.url?.startsWith("/history-surface");
    const sameDocumentSurface = request.url?.startsWith(
      "/agent-same-document-surface"
    );
    const sameDocumentDestination = request.url?.startsWith(
      "/agent-same-document-destination"
    );
    const guardTamperSurface = request.url?.startsWith(
      "/agent-guard-tamper-surface"
    );
    const guardTamperDestination = request.url?.startsWith(
      "/agent-guard-tamper-destination"
    );
    const errorCorrelationSurface = request.url?.startsWith(
      "/agent-error-correlation-surface"
    );
    const sameUrlCorrelationSurface = request.url?.startsWith(
      "/agent-same-url-correlation-surface"
    );
    const sameUrlCorrelationDestination = request.url?.startsWith(
      "/agent-same-url-correlation-destination"
    );
    const replaySettlementSurface = request.url?.startsWith(
      "/agent-replay-settlement-surface"
    );
    const replaySettlementDestination = request.url?.startsWith(
      "/agent-replay-settlement-destination"
    );
    const httpErrorSurface = request.url?.startsWith(
      "/agent-http-error-surface"
    );
    const productHttpErrorSurface = request.url?.startsWith(
      "/agent-product-http-error-surface"
    );
    const productHttpErrorDestination = request.url?.startsWith(
      "/agent-product-http-error-destination"
    );
    const productNetworkFailureSurface = request.url?.startsWith(
      "/agent-product-network-failure-surface"
    );
    const productNetworkFailureDestination = request.url?.startsWith(
      "/agent-product-network-failure-destination"
    );
    const relatedTargetSurface = request.url?.startsWith(
      "/agent-related-target-surface"
    );
    const realmCorrelationSurface = request.url?.startsWith(
      "/agent-realm-correlation-surface"
    );
    const realmCorrelationDestination = request.url?.startsWith(
      "/agent-realm-correlation-destination"
    );
    const detachingSurface = request.url?.startsWith(
      "/agent-detaching-surface"
    );
    const snapshotBoundary = request.url?.startsWith(
      "/agent-snapshot-boundary"
    );
    const deepSnapshotBoundary = request.url?.startsWith(
      "/agent-deep-snapshot-boundary"
    );
    const replayLocatorBoundary = request.url?.startsWith(
      "/agent-replay-locator-boundary"
    );
    const undeclaredNavigationSurface = request.url?.startsWith(
      "/agent-undeclared-navigation-surface"
    );
    const unrelatedRouteSurface = request.url?.startsWith(
      "/agent-unrelated-route-surface"
    );
    const staticControlCopySurface = request.url?.startsWith(
      "/agent-static-control-copy-surface"
    );
    const staticControlCopyDestination = request.url?.startsWith(
      "/agent-static-control-copy-destination"
    );
    const nativeSemanticSurface = request.url?.startsWith(
      "/agent-native-semantic-surface"
    );
    const nativeSemanticDestination = request.url?.startsWith(
      "/agent-native-semantic-destination"
    );
    const multiPrimarySurface = request.url?.startsWith(
      "/agent-multi-primary-surface"
    );
    const multiPrimaryFirst = request.url?.startsWith(
      "/agent-multi-primary-first"
    );
    const multiPrimarySecond = request.url?.startsWith(
      "/agent-multi-primary-second"
    );
    const semanticSpoofSurface = request.url?.startsWith(
      "/agent-semantic-spoof-surface"
    );
    const semanticSpoofDestination = request.url?.startsWith(
      "/agent-semantic-spoof-destination"
    );
    const semanticBoundSurface = request.url?.startsWith(
      "/agent-semantic-bound-surface"
    );
    const semanticBoundDestination = request.url?.startsWith(
      "/agent-semantic-bound-destination"
    );
    const verifiedPolicySurface = request.url?.startsWith(
      "/agent-verified-policy-surface"
    );
    const verifiedPolicyDestination = request.url?.startsWith(
      "/agent-verified-policy-destination"
    );
    const optionReferenceSurface = request.url?.startsWith(
      "/agent-option-reference-surface"
    );
    const peerTransportSurface = request.url?.startsWith(
      "/agent-peer-transport-surface"
    );
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (semanticSpoofSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Semantic control boundary</title></head>
          <body><a href="/agent-semantic-spoof-destination">New monitor</a></body>
        </html>`);
      return;
    }
    if (semanticSpoofDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Spoofed semantic control</title></head>
          <body>
            <h1>Track any public product page</h1>
            <input role="button" type="url" name="Product URL">
            <input id="semantic-decoy" type="text" aria-label="Product URL">
            <button type="submit">Compile monitor</button>
            <script>
              const nativeQuerySelector = document.querySelector.bind(document);
              document.querySelector = (selector) =>
                String(selector).includes("yellowbird")
                  ? nativeQuerySelector("#semantic-decoy")
                  : nativeQuerySelector(selector);
            </script>
          </body>
        </html>`);
      return;
    }
    if (semanticBoundSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Semantic traversal boundary</title></head>
          <body><a href="/agent-semantic-bound-destination">New monitor</a></body>
        </html>`);
      return;
    }
    if (semanticBoundDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Bounded semantic destination</title></head>
          <body>
            <input type="url" aria-label="Product URL">
            ${"<div></div>".repeat(6_000)}
          </body>
        </html>`);
      return;
    }
    if (verifiedPolicySurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Verified policy boundary</title></head>
          <body><a href="/agent-verified-policy-destination">New monitor</a></body>
        </html>`);
      return;
    }
    if (verifiedPolicyDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Verified policy destination</title></head>
          <body>
            <input type="text" aria-label="Query">
            <script>fetch("/agent-write", { method: "POST" }).catch(() => {});</script>
          </body>
        </html>`);
      return;
    }
    if (optionReferenceSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Opaque option boundary</title></head>
          <body>
            <select aria-label="Inspect interval">
              <option value="internal-secret-92">Weekly</option>
            </select>
          </body>
        </html>`);
      return;
    }
    if (peerTransportSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Peer transport boundary</title></head>
          <body>
            <button id="preview" type="button">View peer details</button>
            <script>
              document.querySelector("#preview").addEventListener("click", () => {
                try {
                  const peer = new RTCPeerConnection({
                    iceServers: [{ urls: "stun:stun.example.test:3478" }]
                  });
                  peer.createDataChannel("yellowbird");
                } catch {}
                try {
                  const workerSource =
                    'try { new WebTransport("https://transport.example.test/"); } catch {}';
                  new Worker(URL.createObjectURL(new Blob(
                    [workerSource],
                    { type: "text/javascript" }
                  )));
                } catch {}
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (staticControlCopySurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Control assertion boundary</title></head>
          <body><a href="/agent-static-control-copy-destination">New monitor</a></body>
        </html>`);
      return;
    }
    if (staticControlCopyDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Static form copy</title></head>
          <body>
            <h1>Track any public product page</h1>
            <p>Product URL</p>
            <p>Tracking instruction</p>
            <p>Frequency</p>
            <p>Compile monitor</p>
            <a href="/">Home</a>
          </body>
        </html>`);
      return;
    }
    if (nativeSemanticSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Native semantic roles</title></head>
          <body><a href="/agent-native-semantic-destination">New filters</a></body>
        </html>`);
      return;
    }
    if (nativeSemanticDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Native semantic destination</title></head>
          <body>
            <h1>Catalog filters</h1>
            <input type="search" aria-label="Catalog query">
            <select multiple aria-label="Regions">
              <option>North</option>
              <option>South</option>
            </select>
          </body>
        </html>`);
      return;
    }
    if (multiPrimarySurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Multiple primary routes</title></head>
          <body>
            <a href="/agent-multi-primary-first">Inspect overview</a>
            <a href="/agent-multi-primary-second">Inspect matching setup</a>
          </body>
        </html>`);
      return;
    }
    if (multiPrimaryFirst) {
      response.end(`<!doctype html>
        <html>
          <head><title>Overview destination</title></head>
          <body>
            <h1>Overview destination</h1>
            <a href="/agent-multi-primary-second">Inspect matching setup</a>
            <input type="text" aria-label="Overview query">
          </body>
        </html>`);
      return;
    }
    if (multiPrimarySecond) {
      response.end(`<!doctype html>
        <html>
          <head><title>Matching setup destination</title></head>
          <body>
            <h1>Matching destination</h1>
            <input type="text" aria-label="Setup query">
          </body>
        </html>`);
      return;
    }
    if (undeclaredNavigationSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Declared route boundary</title></head>
          <body>
            <a href="/agent-read-mutation">View preview</a>
            <a href="/agent-flow">Setup monitor</a>
          </body>
        </html>`);
      return;
    }
    if (unrelatedRouteSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Route relevance boundary</title></head>
          <body>
            <a href="/privacy">Review privacy</a>
            <a href="/agent-flow">Setup monitor</a>
          </body>
        </html>`);
      return;
    }
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
            <a href="/auth">Account help</a>
            <a href="/user_auth">Account support</a>
            <a href="/auth_callback">Account callback</a>
            <a href="/authCallback">Inspect callback</a>
            <a href="/deleteAccount">Inspect account</a>
            <a href="/createMonitor">Inspect monitor</a>
            <a href="http://user:secret@127.0.0.1:${server.address().port}/agent-flow">Credentialed setup</a>
            <span id="dangerous-name"><img alt="Delete account"></span>
            <a aria-label="Inspect setup" aria-labelledby="dangerous-name" href="/agent-flow">Setup</a>
            <form action="/create-monitor">
              <label>Name <input name="name"></label>
              <label>Password <input name="password" type="password"></label>
              <button type="button">Inspect account</button>
            </form>
            <label><span>Inspect</span> Delete account <input name="details"></label>
            <select aria-label="Inspect choices">
              <option value="preview">Preview</option>
              <option value="delete_account">Dangerous choice</option>
            </select>
            <form action="http://localhost:${server.address().port}/agent-flow">
              <button type="button">View details</button>
            </form>
            <section hidden>
              <p>hidden-copy-secret</p>
              <a href="/agent-flow">Hidden setup choice</a>
            </section>
            <section aria-hidden="true">
              <p>aria-copy-secret</p>
              <a href="/agent-flow">Aria hidden setup choice</a>
            </section>
            <section style="display: none">
              <p>css-copy-secret</p>
              <a href="/agent-flow">CSS hidden setup choice</a>
            </section>
            <details>
              <summary>Private details</summary>
              <p>closed-details-secret</p>
              <a href="/agent-flow">Closed details setup choice</a>
            </details>
            <section style="width: 0; height: 0; overflow: hidden">
              <p>zero-clipped-secret</p>
              <a href="/agent-flow">Clipped setup choice</a>
            </section>
            <section style="clip-path: inset(50%)">
              <p>clip-path-secret</p>
              <a href="/agent-flow">Clip path setup choice</a>
            </section>
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
    if (delayedMutationSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Delayed mutation boundary</title></head>
          <body>
            <button id="preview" type="button">View preview</button>
            <script>
              document.querySelector("#preview").addEventListener("click", () => {
                setTimeout(() => {
                  fetch("/agent-delayed-read-mutation").catch(() => {});
                }, 200);
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (delayedVisitMutationSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Delayed visit boundary</title></head>
          <body>
            <a href="/agent-delayed-visit-destination">Setup route</a>
            <script>
              fetch("/agent-initial-visit-data");
              setTimeout(() => {
                fetch("/agent-initial-delayed-visit-mutation");
              }, 200);
            </script>
          </body>
        </html>`);
      return;
    }
    if (delayedVisitMutationDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Delayed visit destination</title></head>
          <body>
            <input name="query" aria-label="Query">
            <script>
              fetch("/agent-visit-data");
              const events = new EventSource("/agent-visit-events");
              events.onmessage = () => {
                const ready = document.createElement("input");
                ready.setAttribute("aria-label", "Stream ready");
                document.body.append(ready);
              };
              setTimeout(() => {
                fetch("/agent-delayed-visit-mutation");
                new WebSocket("ws://" + location.host + "/agent-visit-socket");
              }, 200);
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
                fetch("http://localhost:${server.address().port}/agent-cross-origin-read");
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (preAbortedCrossOriginSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Pre-aborted cross-origin boundary</title></head>
          <body>
            <button id="preview" type="button">View preview</button>
            <script>
              document.querySelector("#preview").addEventListener("click", () => {
                const controller = new AbortController();
                controller.abort();
                fetch("http://localhost:${server.address().port}/agent-cross-origin-read", {
                  signal: controller.signal
                });
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
    if (prohibitedRedirectSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Prohibited redirect surface</title></head>
          <body><a href="/agent-prohibited-redirect">Setup monitor</a></body>
        </html>`);
      return;
    }
    if (fetchRedirectSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Fetch redirect surface</title></head>
          <body><a href="/agent-fetch-redirect-destination">Inspect setup</a></body>
        </html>`);
      return;
    }
    if (fetchRedirectDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Fetch redirect destination</title></head>
          <body>
            <input name="query" aria-label="Query">
            <script>fetch("/agent-fetch-redirect");</script>
          </body>
        </html>`);
      return;
    }
    if (failedVisitSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Failed visit surface</title></head>
          <body>
            <a href="/agent-failed-visit-destination">Inspect unavailable route</a>
          </body>
        </html>`);
      return;
    }
    if (failedVisitDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Recovered visit destination</title></head>
          <body><input name="query" aria-label="Query"></body>
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
    if (sameDocumentSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Same-document boundary</title></head>
          <body><a href="/agent-same-document-destination">Setup route</a></body>
        </html>`);
      return;
    }
    if (sameDocumentDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Same-document destination</title></head>
          <body>
            <input name="query" aria-label="Query">
            <script>
              history.pushState({}, "", "/authCallback");
              history.replaceState({}, "", "/agent-same-document-destination");
            </script>
          </body>
        </html>`);
      return;
    }
    if (guardTamperSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Guard tamper surface</title></head>
          <body><a href="/agent-guard-tamper-destination">Setup route</a></body>
        </html>`);
      return;
    }
    if (guardTamperDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Guard tamper destination</title></head>
          <body>
            <input name="query" aria-label="Query">
            <script>
              const controlName = Object.getOwnPropertyNames(globalThis)
                .find((name) => name.startsWith("__yellowbird_"));
              globalThis[controlName]?.("attacker-token", "fill");
              try {
                Object.defineProperty(globalThis, controlName, {
                  value: () => true
                });
              } catch {}
              globalThis.__yellowbirdAgentActionGuard = {
                active: false,
                attempts: [],
                observeCurrentUrl() {}
              };
              history.pushState({}, "", "/authCallback");
            </script>
          </body>
        </html>`);
      return;
    }
    if (errorCorrelationSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Error correlation surface</title></head>
          <body>
            <button id="preview" type="button">View preview</button>
            <script>
              document.querySelector("#preview").addEventListener("click", () => {
                fetch("/agent-read-mutation");
                Promise.reject(new TypeError("Failed to fetch catalog independently"));
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (sameUrlCorrelationSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Same URL correlation surface</title></head>
          <body><a href="/agent-same-url-correlation-destination">Inspect setup</a></body>
        </html>`);
      return;
    }
    if (sameUrlCorrelationDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Same URL correlation destination</title></head>
          <body>
            <input name="query" aria-label="Query">
            <script>
              const controller = new AbortController();
              fetch("/agent-same-url-correlation", { signal: controller.signal });
              setTimeout(() => controller.abort(), 20);
              setTimeout(() => fetch("/agent-same-url-correlation"), 50);
            </script>
          </body>
        </html>`);
      return;
    }
    if (replaySettlementSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Replay settlement surface</title></head>
          <body><a href="/agent-replay-settlement-destination">Inspect setup</a></body>
        </html>`);
      return;
    }
    if (replaySettlementDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Replay settlement destination</title></head>
          <body>
            <input name="query" aria-label="Query">
            <script>
              ${changeReplaySettlementUrl ? 'setTimeout(() => history.replaceState({}, "", "/agent-replay-settlement-changed"), 50);' : ""}
              setTimeout(() => fetch("/agent-replay-settlement-delayed"), 250);
            </script>
          </body>
        </html>`);
      return;
    }
    if (httpErrorSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>HTTP error surface</title></head>
          <body><a href="/agent-http-error-destination">Inspect preview</a></body>
        </html>`);
      return;
    }
    if (productHttpErrorSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Product response health</title></head>
          <body><a href="/agent-product-http-error-destination">Inspect catalog</a></body>
        </html>`);
      return;
    }
    if (productHttpErrorDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Catalog response health</title></head>
          <body>
            <input name="query" aria-label="Query">
            <script>fetch("/agent-product-http-error").catch(() => {});</script>
          </body>
        </html>`);
      return;
    }
    if (productNetworkFailureSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Product request health</title></head>
          <body><a href="/agent-product-network-failure-destination">Inspect catalog</a></body>
        </html>`);
      return;
    }
    if (productNetworkFailureDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Catalog request health</title></head>
          <body>
            <input name="query" aria-label="Query">
            <script>fetch("/agent-product-network-failure").catch(() => {});</script>
          </body>
        </html>`);
      return;
    }
    if (relatedTargetSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Related target surface</title></head>
          <body>
            <button id="preview" type="button">View related details</button>
            <script>
              document.querySelector("#preview").addEventListener("click", () => {
                Promise.reject(new Error("Related target product failure"));
                const effectUrl = location.origin + "/agent-related-target-effect";
                const source = "fetch(" + JSON.stringify(effectUrl) + ", { method: 'POST' })";
                try {
                  new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
                } catch {}
                window.open("/agent-related-target-effect", "yellowbird-related-target");
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (realmCorrelationSurface) {
      response.end(`<!doctype html>
        <html>
          <head><title>Realm correlation surface</title></head>
          <body>
            <a href="/agent-realm-correlation-destination">Inspect setup</a>
            <script>fetch("/deleteAccount");</script>
          </body>
        </html>`);
      return;
    }
    if (realmCorrelationDestination) {
      response.end(`<!doctype html>
        <html>
          <head><title>Realm correlation destination</title></head>
          <body>
            <input name="query" aria-label="Query">
            <script>
              const controller = new AbortController();
              fetch("/agent-independent-failure", { signal: controller.signal });
              controller.abort();
            </script>
          </body>
        </html>`);
      return;
    }
    if (detachingSurface) {
      const links = Array.from(
        { length: 30 },
        (_, index) => `<a href="/agent-flow?item=${index}">Setup ${index}</a>`
      ).join("");
      response.end(`<!doctype html>
        <html>
          <head><title>Detaching controls</title></head>
          <body>
            ${links}
            <script>
              const observer = new MutationObserver((records) => {
                if (!records.some((record) => record.attributeName === "data-yellowbird-agent-ref")) return;
                document.querySelectorAll("a").forEach((element) => element.remove());
                observer.disconnect();
              });
              observer.observe(document.body, {
                attributeFilter: ["data-yellowbird-agent-ref"],
                attributes: true,
                subtree: true
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (snapshotBoundary) {
      const options = Array.from(
        { length: 200 },
        (_, index) =>
          `<option value="value-${index}">${"Oversized option ".repeat(100)}${index}</option>`
      ).join("");
      response.end(`<!doctype html>
        <html>
          <head><title>${"Oversized title ".repeat(100)}</title></head>
          <body>
            <p>${"Oversized body content ".repeat(10_000)}</p>
            <select aria-label="Inspect choices">${options}</select>
            <button type="button">View ${"padding ".repeat(60)} delete account</button>
            <a href="/agent-flow">Setup route</a>
          </body>
        </html>`);
      return;
    }
    if (deepSnapshotBoundary) {
      const inertNodes = "<div></div>".repeat(6_000);
      response.end(`<!doctype html>
        <html>
          <head><title>Deep snapshot boundary</title></head>
          <body>${inertNodes}<a href="/agent-flow">Late setup route</a></body>
        </html>`);
      return;
    }
    if (replayLocatorBoundary) {
      const hiddenInputs = '<input name="query" aria-label="Hidden query">'.repeat(
        5_100
      );
      response.end(`<!doctype html>
        <html>
          <head><title>Replay locator boundary</title></head>
          <body>
            <input name="query" aria-label="Visible query">
            <section style="display: none">${hiddenInputs}</section>
          </body>
        </html>`);
      return;
    }
    response.end(`<!doctype html>
      <html>
        <head><title>${agentFlow ? "Monitor setup" : "Feather Shop"}</title></head>
        <body>
          <h1${agentFlow && hideAgentFlowHeading ? " hidden" : ""}>${agentFlow ? "Create monitor" : "Feather Shop"}</h1>
          <p>${failing ? "Checkout unavailable" : "Checkout ready"}</p>
          ${staticPage ? "<p>No available workflow controls.</p>" : agentFlow ? '<p>Choose a product URL and monitoring rule.</p>' : '<a href="/agent-flow">New monitor</a>'}
          ${staticPage ? "" : '<input name="email" aria-label="Email">'}
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
  server.on("upgrade", (request, socket) => {
    if (request.url === "/agent-visit-socket") {
      visitWebSocketUpgradeCount += 1;
    }
    socket.destroy();
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

async function launchBrowserWithDelayedScreenshot() {
  let context;
  return {
    async newContext(options) {
      context = await sharedBrowser.newContext(options);
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        const goto = page.goto.bind(page);
        const screenshot = page.screenshot.bind(page);
        page.goto = async (url, gotoOptions) => {
          try {
            return await goto(url, gotoOptions);
          } catch (error) {
            if (String(url).includes("/agent-failed-visit-destination")) {
              setTimeout(() => {
                page
                  .evaluate((requestUrl) => {
                    fetch(requestUrl).catch(() => {});
                  }, `${target}/agent-failed-visit-delayed`)
                  .catch(() => {});
              }, 50);
            }
            throw error;
          }
        };
        page.screenshot = async (screenshotOptions) => {
          await page.waitForTimeout(400);
          return screenshot(screenshotOptions);
        };
        return page;
      };
      return context;
    },
    async close() {
      await context?.close();
    }
  };
}

async function launchBrowserWithFailingScreenshot() {
  let context;
  return {
    async newContext(options) {
      context = await sharedBrowser.newContext(options);
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        page.screenshot = async () => {
          throw new Error("injected browser screenshot timeout");
        };
        return page;
      };
      return context;
    },
    async close() {
      await context?.close();
    }
  };
}

async function launchBrowserWithFailingClose() {
  let context;
  return {
    async newContext(options) {
      context = await sharedBrowser.newContext(options);
      return context;
    },
    async close() {
      await context?.close();
      throw new Error(
        `injected browser cleanup failure at ${target}/?token=hidden-value`
      );
    }
  };
}

async function launchBrowserWithFailingNetworkGuard() {
  let context;
  return {
    async newContext(options) {
      context = await sharedBrowser.newContext(options);
      const newCdpSession = context.newCDPSession.bind(context);
      context.newCDPSession = async (page) => {
        const session = await newCdpSession(page);
        let injected = false;
        const proxy = {
          on(event, listener) {
            session.on(event, listener);
            return proxy;
          },
          async send(method, parameters) {
            const result = await session.send(method, parameters);
            if (method === "Fetch.continueRequest" && !injected) {
              injected = true;
              throw new Error(
                `injected network guard failure at ${target}/?token=hidden-value`
              );
            }
            return result;
          }
        };
        return proxy;
      };
      return context;
    },
    async close() {
      await context?.close();
    }
  };
}

async function launchBrowserWithFailingAgentCleanup() {
  let context;
  return {
    async newContext(options) {
      context = await sharedBrowser.newContext(options);
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        const evaluate = page.evaluate.bind(page);
        let idleTransitions = 0;
        page.evaluate = async (callback, argument) => {
          if (argument?.action === "idle") {
            idleTransitions += 1;
            if (idleTransitions === 3) {
              throw new Error(
                `injected action cleanup failure at ${target}/?token=hidden-value`
              );
            }
          }
          return evaluate(callback, argument);
        };
        return page;
      };
      return context;
    },
    async close() {
      await context?.close();
    }
  };
}

async function launchBrowserWithFailingGuardSession() {
  let context;
  return {
    async newContext(options) {
      context = await sharedBrowser.newContext(options);
      context.newCDPSession = async () => {
        throw new Error("injected CDP session initialization failure");
      };
      return context;
    },
    async close() {
      await context?.close();
    }
  };
}

async function launchBrowserWithFailingGuardEnable() {
  let context;
  return {
    async newContext(options) {
      context = await sharedBrowser.newContext(options);
      const newCdpSession = context.newCDPSession.bind(context);
      context.newCDPSession = async (page) => {
        const session = await newCdpSession(page);
        return {
          on(event, candidate) {
            session.on(event, candidate);
            return this;
          },
          async send(method, parameters) {
            if (method === "Fetch.enable") {
              throw new Error("injected Fetch.enable failure");
            }
            return session.send(method, parameters);
          }
        };
      };
      return context;
    },
    async close() {
      await context?.close();
    }
  };
}

const runSharedScout = createScoutRunner({
  launchBrowser: launchSharedBrowser
});

function createAgentRunner(
  decide,
  resolveEngineOverride,
  launchBrowser = launchSharedBrowser
) {
  const runner = createScoutRunner({
    launchBrowser,
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
  return (input) => {
    const primaryRoutes = [
      "/agent-flow",
      "/history-return",
      "/agent-redirect",
      "/agent-prohibited-redirect",
      "/agent-fetch-redirect-destination",
      "/agent-same-url-correlation-destination",
      "/agent-realm-correlation-destination",
      "/agent-replay-settlement-destination",
      "/agent-same-document-destination",
      "/agent-guard-tamper-destination",
      "/agent-http-error-destination",
      "/agent-product-http-error-destination",
      "/agent-product-network-failure-destination",
      "/agent-failed-visit-destination",
      "/agent-delayed-visit-destination"
    ];
    const loadRoutes = [
      "/agent-initial-visit-data",
      "/agent-visit-data",
      "/agent-visit-events",
      "/agent-fetch-redirect",
      "/agent-same-url-correlation",
      "/agent-independent-failure",
      "/agent-replay-settlement-delayed",
      "/agent-product-http-error",
      "/agent-product-network-failure"
    ];
    return runner({
      agentPrimaryRoutes: primaryRoutes,
      agentLoadRoutes: loadRoutes,
      ...input
    });
  };
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

test("agent URL policy rejects credentials, auth shorthand, and fragments", () => {
  assert.equal(isAgentUrlAllowed(`${target}/setup`, target), true);
  assert.equal(isAgentUrlAllowed(`${target}/user_auth`, target), false);
  assert.equal(isAgentUrlAllowed(`${target}/auth_callback`, target), false);
  assert.equal(isAgentUrlAllowed(`${target}/authCallback`, target), false);
  assert.equal(isAgentUrlAllowed(`${target}/deleteAccount`, target), false);
  assert.equal(isAgentUrlAllowed(`${target}/delete2FA`, target), false);
  assert.equal(isAgentUrlAllowed(`${target}/createMonitor`, target), false);
  assert.equal(isAgentUrlAllowed(`${target}/setup#auth_callback`, target), false);
  assert.equal(isAgentUrlAllowed(`${target}/%25252561uth`, target), false);
  assert.equal(isAgentUrlAllowed(`${target}/%ZZauth`, target), false);
  assert.equal(isAgentUrlAllowed(`${target}/setup?action=log+in`, target), false);
  assert.equal(isAgentUrlAllowed(`blob:${target}/temporary`, target), false);
  assert.equal(
    isAgentUrlAllowed(
      `http://user:secret@127.0.0.1:${server.address().port}/setup`,
      target
    ),
    false
  );
});

test("agent target policy runs before loopback transport probes", async () => {
  delete2FARequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-target-policy-")
  );
  await assert.rejects(
    createAgentRunner(() => {
      throw new Error("planner must not run");
    })({
      target: `${target}/delete2FA`,
      intent: "Assess the initial interface",
      exploreIntent: true,
      outputDirectory
    }),
    /target contains a prohibited action/
  );
  assert.equal(delete2FARequestCount, 0);
  await assert.rejects(stat(join(outputDirectory, "evidence.json")));
});

test("action cleanup runs after a failed begin without masking its error", async () => {
  const context = await sharedBrowser.newContext();
  const page = await context.newPage();
  let authorityOpen = false;
  try {
    await page.goto(`${target}/agent-redirect-surface`);
    const exploration = await exploreIntentWithEngine({
      page,
      intent: "Assess the setup route",
      authorizedOrigin: target,
      authorizedNavigationRoutes: new Set([
        `${target}/agent-redirect`,
        `${target}/agent-flow`
      ]),
      engine: {
        completeStructured: async (request) => {
          const availableElements = JSON.parse(
            request.messages.at(-1).content
          ).page.availableElements;
          return {
            output: {
              action: "act",
              elementRef: availableElements[0].ref,
              value: null,
              rationale: "Inspect the supplied route.",
              coverage: "continue",
              summary: ""
            }
          };
        }
      },
      maxSteps: 1,
      timeoutMs: 1_000,
      record: () => {},
      actionPolicy: {
        async begin() {
          authorityOpen = true;
          throw new Error("primary begin failure");
        },
        async end() {
          authorityOpen = false;
          throw new Error("cleanup failure");
        }
      }
    });

    assert.equal(authorityOpen, false);
    assert.equal(exploration.steps.length, 1);
    assert.match(exploration.steps[0].evidence, /primary begin failure/);
    assert.doesNotMatch(exploration.steps[0].evidence, /cleanup failure/);
  } finally {
    await context.close();
  }
});

test("action cleanup failure preserves completed exploration evidence", async () => {
  const context = await sharedBrowser.newContext();
  const page = await context.newPage();
  let cleanupCalls = 0;
  try {
    await page.goto(`${target}/agent-redirect-surface`);
    const exploration = await exploreIntentWithEngine({
      page,
      intent: "Assess the setup route",
      authorizedOrigin: target,
      authorizedNavigationRoutes: new Set([
        `${target}/agent-redirect`,
        `${target}/agent-flow`
      ]),
      engine: {
        completeStructured: async (request) => {
          const availableElements = JSON.parse(
            request.messages.at(-1).content
          ).page.availableElements;
          return {
            output: {
              action: "act",
              elementRef: availableElements[0].ref,
              value: null,
              rationale: "Inspect the supplied route.",
              coverage: "continue",
              summary: ""
            }
          };
        }
      },
      maxSteps: 1,
      timeoutMs: 1_000,
      record: () => {},
      actionPolicy: {
        async begin() {},
        async end() {
          cleanupCalls += 1;
          throw new Error("cleanup failure");
        }
      }
    });

    assert.equal(cleanupCalls, 1);
    assert.equal(exploration.status, "inconclusive");
    assert.equal(exploration.coverage, "partial");
    assert.equal(exploration.issue.id, "agent-action-cleanup-failed");
    assert.equal(exploration.steps.length, 1);
    assert.equal(exploration.steps[0].status, "passed");
  } finally {
    await context.close();
  }
});

test("later invalid planner output preserves partial coverage", async () => {
  const context = await sharedBrowser.newContext();
  const page = await context.newPage();
  let planningCalls = 0;
  try {
    await page.goto(`${target}/agent-redirect-surface`);
    const exploration = await exploreIntentWithEngine({
      page,
      intent: "Assess the setup route",
      authorizedOrigin: target,
      authorizedNavigationRoutes: new Set([
        `${target}/agent-redirect`,
        `${target}/agent-flow`
      ]),
      engine: {
        completeStructured: async (request) => {
          planningCalls += 1;
          if (planningCalls > 1) return { output: { action: "invalid" } };
          const availableElements = JSON.parse(
            request.messages.at(-1).content
          ).page.availableElements;
          return {
            output: {
              action: "act",
              elementRef: availableElements[0].ref,
              value: null,
              rationale: "Inspect the supplied route.",
              coverage: "continue",
              summary: ""
            }
          };
        }
      },
      maxSteps: 2,
      timeoutMs: 1_000,
      record: () => {}
    });

    assert.equal(planningCalls, 2);
    assert.equal(exploration.status, "inconclusive");
    assert.equal(exploration.coverage, "partial");
    assert.equal(exploration.issue.id, "agent-output-invalid");
    assert.equal(exploration.steps.length, 1);
    assert.equal(exploration.steps[0].status, "passed");
  } finally {
    await context.close();
  }
});

test("v2 evidence schema keeps exploration observations backward-compatible", async () => {
  const schema = JSON.parse(
    await readFile(resolve("schemas/scout-evidence.v2.schema.json"), "utf8")
  );

  assert.equal(
    schema.properties.observations.required.includes("exploration"),
    false
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

test("loopback repairs are validated before their transport probe", async () => {
  const originalFetch = globalThis.fetch;
  const probedUrls = [];
  globalThis.fetch = async (url) => {
    probedUrls.push(String(url));
    throw new Error("TLS probe failed");
  };

  try {
    await assert.rejects(
      resolveLoopbackScheme(
        "https://127.0.0.1/path",
        100,
        () => {},
        (candidate) => {
          if (candidate.startsWith("http:")) {
            throw new Error("repaired target rejected");
          }
        }
      ),
      /repaired target rejected/
    );
    assert.deepEqual(probedUrls, ["https://127.0.0.1/path"]);
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
  const previousEngineKey = process.env.YELLOWBIRD_ENGINE_API_KEY;
  process.env.YELLOWBIRD_ENGINE_API_KEY = "planner-secret";
  let report;
  try {
    report = await runWithUnavailableBrowser({
      target,
      expectedTexts: ["Checkout ready"],
      permissions: ["browser.navigate", "browser.read", "browser.click"],
      steps: [{ id: "checkout", action: "click", selector: "#checkout" }],
      outputDirectory
    });
  } finally {
    if (previousEngineKey === undefined) {
      delete process.env.YELLOWBIRD_ENGINE_API_KEY;
    } else {
      process.env.YELLOWBIRD_ENGINE_API_KEY = previousEngineKey;
    }
  }

  assert.equal(report.outcome, "inconclusive");
  assert.equal(launchOptions.headless, true);
  assert.equal(launchOptions.timeout, 15_000);
  assert.equal(launchOptions.env.YELLOWBIRD_ENGINE_API_KEY, undefined);
  assert.equal(launchOptions.env.PATH, process.env.PATH);
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
  const markdown = await readFile(report.artifacts.report, "utf8");
  assert.match(
    markdown,
    /> \*\*ERROR\*\* - YellowBird could not complete a trustworthy evaluation\./
  );
  assert.match(markdown, /YellowBird run: \*\*ERROR\*\*/);
  assert.match(
    markdown,
    /Product signal: Not established because the evaluation was incomplete or untrustworthy\./
  );
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

test("browser context creation failure finalizes an inconclusive run", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-context-"));
  let browserClosed = false;
  const runWithUnavailableContext = createScoutRunner({
    launchBrowser: async () => ({
      async newContext() {
        throw new Error(
          `context setup failed at ${target}/?token=hidden-value`
        );
      },
      async close() {
        browserClosed = true;
      }
    })
  });

  const report = await runWithUnavailableContext({
    target,
    permissions: ["browser.navigate", "browser.read", "browser.click"],
    steps: [{ id: "checkout", action: "click", selector: "#checkout" }],
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(browserClosed, true);
  assert.deepEqual(report.findings, []);
  assert.equal(
    report.invalidTestMechanics[0].id,
    "browser-context-creation-failed"
  );
  assert.equal(report.observations.browser.launch.successful, true);
  assert.equal(report.observations.navigation.status, "skipped");
  assert.equal(
    report.observations.navigation.reason,
    "browser-context-unavailable"
  );
  assert.deepEqual(
    report.observations.workflowSteps.map(({ status, reason }) => ({
      status,
      reason
    })),
    [{ status: "skipped", reason: "browser-context-unavailable" }]
  );
  assert.equal(report.artifacts.screenshot, null);
  await assert.rejects(stat(join(outputDirectory, "page.png")));
  await Promise.all(
    Object.entries(report.artifacts)
      .filter(([name]) => name !== "screenshot")
      .map(([, path]) => stat(path))
  );
  const schema = JSON.parse(
    await readFile(resolve("schemas/scout-evidence.v2.schema.json"), "utf8")
  );
  assertConformsToSchema(schema, report);
  const diagnostics = await readFile(report.artifacts.diagnostics, "utf8");
  const events = diagnostics
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.slice(-3).map((event) => event.event),
    ["browser.context.failed", "browser.closed", "run.completed"]
  );
  assert.doesNotMatch(diagnostics, /hidden-value/);
});

test("browser screenshot capture failure finalizes without a screenshot claim", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-screenshot-capture-")
  );
  const report = await createScoutRunner({
    launchBrowser: launchBrowserWithFailingScreenshot
  })({
    target,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.navigation.completed, true);
  assert.equal(report.artifacts.screenshot, null);
  assert.ok(
    report.invalidTestMechanics.some(
      (issue) => issue.id === "browser-screenshot-capture-failed"
    )
  );
  await assert.rejects(stat(join(outputDirectory, "page.png")));
  await Promise.all(
    Object.entries(report.artifacts)
      .filter(([name]) => name !== "screenshot")
      .map(([, path]) => stat(path))
  );
  assert.match(
    await readFile(report.artifacts.diagnostics, "utf8"),
    /browser\.screenshot\.failed/
  );
});

test("browser cleanup failure finalizes with durable evidence", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-browser-close-")
  );
  const report = await createScoutRunner({
    launchBrowser: launchBrowserWithFailingClose
  })({
    target,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.navigation.completed, true);
  assert.deepEqual(report.findings, []);
  assert.ok(
    report.invalidTestMechanics.some(
      (issue) => issue.id === "browser-close-failed"
    )
  );
  assert.ok(report.artifacts.screenshot);
  await Promise.all(Object.values(report.artifacts).map((path) => stat(path)));
  const schema = JSON.parse(
    await readFile(resolve("schemas/scout-evidence.v2.schema.json"), "utf8")
  );
  assertConformsToSchema(schema, report);
  const diagnostics = await readFile(report.artifacts.diagnostics, "utf8");
  const events = diagnostics
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.slice(-2).map((event) => event.event),
    ["browser.close.failed", "run.completed"]
  );
  assert.doesNotMatch(diagnostics, /hidden-value/);
});

test("a browser network guard failure cannot produce a clear report", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-network-guard-failure-")
  );
  const report = await createAgentRunner(
    () => ({
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "The initial interface was observed.",
      coverage: "covered",
      summary: "The initial interface was observed."
    }),
    undefined,
    launchBrowserWithFailingNetworkGuard
  )({
    target,
    intent: "Assess the initial interface",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.exploration.status, "inconclusive");
  assert.ok(
    report.invalidTestMechanics.some(
      (issue) => issue.id === "browser-network-guard-failed"
    )
  );
  assert.match(
    await readFile(report.artifacts.diagnostics, "utf8"),
    /browser\.network-guard\.failed/
  );
  assert.doesNotMatch(
    await readFile(report.artifacts.diagnostics, "utf8"),
    /hidden-value/
  );
});

test("intent exploration loads passive same-origin application assets without declarations", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-static-assets-")
  );
  const report = await createAgentRunner(() => ({
    action: "finish",
    elementRef: null,
    value: null,
    rationale: "The hydrated initial interface was observed.",
    coverage: "covered",
    summary: "The hydrated initial interface was observed."
  }))({
    target: `${target}/implicit-static-app`,
    intent: "Assess the initial interface",
    exploreIntent: true,
    expectedTexts: ["Application hydrated"],
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.findings.length, 0);
  assert.equal(report.observations.blockedRequests.length, 0);
  assert.equal(report.observations.consoleErrors.length, 0);
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(regression, /yellowbirdPassiveAgentResourceTypes/);

  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
}, 30_000);

test("zero-configuration intent discovers a safe setup route and background reads", async () => {
  zeroConfigBackgroundRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-zero-config-intent-")
  );
  const report = await createScoutRunner({
    launchBrowser: launchSharedBrowser
  })({
    target: `${target}/zero-config-flow`,
    intent: "Ensure user flow works as expected",
    exploreIntent: true,
    agentPrimaryRoutes: undefined,
    agentNavigationRoutes: undefined,
    agentLoadRoutes: undefined,
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.equal(report.invalidTestMechanics.length, 0);
  assert.equal(report.observations.blockedRequests.length, 0);
  assert.deepEqual(
    report.observations.exploration.steps.map((step) => step.action),
    ["visit", "fill", "fill"]
  );
  assert.ok(zeroConfigBackgroundRequestCount >= 2);
  assert.equal(
    report.observations.exploration.verification?.profile,
    "initial-interface-basic-flow.v1"
  );
  assert.equal(report.observations.exploration.verification?.satisfied, true);
  assert.equal(
    report.observations.exploration.routePolicy.automaticNavigationRoutes,
    true
  );
  assert.equal(
    report.observations.exploration.routePolicy.automaticLoadRoutes,
    true
  );
  assert.ok(
    report.observations.exploration.routePolicy.backgroundLoadRoutes.includes(
      `${target}/zero-config-flow-data`
    )
  );

  const markdown = await readFile(report.artifacts.report, "utf8");
  assert.match(markdown, /5\/5 YellowBird-observed coverage criteria satisfied/);
  assert.match(markdown, /automatic safe same-origin discovery/);
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
}, 30_000);

test("action-policy cleanup failures retain findings and durable evidence", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-cleanup-failure-")
  );
  const report = await createAgentRunner(
    (request) => {
      const availableElements = JSON.parse(
        request.messages.at(-1).content
      ).page.availableElements;
      return {
        action: "act",
        elementRef: availableElements[0].ref,
        value: null,
        rationale: "Inspect the supplied setup route.",
        coverage: "continue",
        summary: ""
      };
    },
    undefined,
    launchBrowserWithFailingAgentCleanup
  )({
    target: `${target}/failing`,
    intent: "Assess the setup route",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "attention");
  assert.ok(report.findings.some((finding) => finding.id === "console-errors"));
  assert.ok(
    report.invalidTestMechanics.some(
      (issue) => issue.id === "agent-action-cleanup-failed"
    )
  );
  assert.equal(report.observations.exploration.status, "inconclusive");
  assert.equal(report.observations.exploration.coverage, "partial");
  assert.equal(report.observations.exploration.steps[0].status, "passed");
  assert.ok(report.artifacts.screenshot);
  await Promise.all(Object.values(report.artifacts).map((path) => stat(path)));
  const diagnostics = await readFile(report.artifacts.diagnostics, "utf8");
  assert.match(diagnostics, /agent\.action\.cleanup\.failed/);
  assert.doesNotMatch(diagnostics, /hidden-value/);
});

test("network guard initialization failures persist inconclusive reports", async () => {
  for (const launchBrowser of [
    launchBrowserWithFailingGuardSession,
    launchBrowserWithFailingGuardEnable
  ]) {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "yellowbird-agent-network-guard-init-")
    );
    const report = await createAgentRunner(
      () => {
        throw new Error("planner must not run");
      },
      undefined,
      launchBrowser
    )({
      target,
      intent: "Assess the initial interface",
      exploreIntent: true,
      outputDirectory
    });

    assert.equal(report.outcome, "inconclusive");
    assert.deepEqual(report.findings, []);
    assert.equal(report.observations.navigation.completed, false);
    assert.equal(
      report.observations.navigation.reason,
      "network-guard-unavailable"
    );
    assert.ok(
      report.invalidTestMechanics.some(
        (issue) => issue.id === "browser-network-guard-failed"
      )
    );
    await stat(report.artifacts.evidence);
    await stat(report.artifacts.report);
    await stat(report.artifacts.diagnostics);
  }
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
  const markdown = await readFile(report.artifacts.report, "utf8");
  assert.match(
    markdown,
    /> \*\*LIMITED\*\* - YellowBird completed, but the run did not exercise a declared functional workflow\./
  );
  assert.match(
    markdown,
    /Effective scope: Bounded safe exploration; 2\/2 interaction\(s\) exercised; no declared workflow; 1 product assertion; 5\/5 YellowBird-observed coverage criteria satisfied\./
  );
  assert.match(markdown, /Evidence outcome: \*\*clear\*\*/);
  assert.ok(
    report.observations.exploration.routePolicy.primaryRoutes.includes(
      `${target}/agent-flow`
    )
  );
  assert.ok(
    report.observations.exploration.routePolicy.navigationRoutes.includes(
      `${target}/`
    )
  );
  assert.ok(
    report.observations.exploration.routePolicy.loadRoutes.includes(
      `${target}/agent-visit-data`
    )
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

test("explicitly disabled intent exploration preserves initial-page scenarios", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-opt-out-")
  );
  let planningCalls = 0;
  const report = await createAgentRunner(() => {
    planningCalls += 1;
    throw new Error("the planner must remain disabled");
  })({
    target,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: false,
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.equal(report.observations.exploration.requested, false);
  assert.equal(report.observations.navigation.completed, true);
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
    agentExpectedTexts: ["Create monitor", "Choose a product URL"],
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
      { id: "authorized-actions-passed", satisfied: true },
      {
        id: "owner-declared-destination-text-observed",
        satisfied: true
      }
    ],
    summary:
      "YellowBird observed the initial page, visited a distinct authorized setup route, and matched the owner-declared destination text."
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
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(regression, /yellowbirdReadRenderedBodyText/);
  assert.match(regression, /toContain\("Create monitor"\)/);
  assert.match(regression, /toContain\("Choose a product URL"\)/);
});

test("portable replay rejects destination text that becomes non-rendered", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-visible-text-replay-")
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
    agentExpectedTexts: ["Create monitor"],
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  hideAgentFlowHeading = true;
  try {
    const replay = await runCommand(
      [process.execPath, "run", "test"],
      outputDirectory
    );
    assert.notEqual(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
  } finally {
    hideAgentFlowHeading = false;
  }
}, 30_000);

test("owned coverage rejects a primary destination missing declared text", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-destination-assertion-")
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
    agentExpectedTexts: ["Price Scout product URL"],
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.exploration.verification.satisfied, false);
  assert.deepEqual(
    report.observations.exploration.steps[0].destinationAssertions,
    [{ text: "Price Scout product URL", satisfied: false }]
  );
  assert.equal(
    report.observations.exploration.verification.criteria.find(
      (criterion) =>
        criterion.id === "owner-declared-destination-text-observed"
    ).satisfied,
    false
  );
});

test("owned coverage rejects static copy without declared semantic controls", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-control-assertion-")
  );
  const report = await createAgentRunner(() => ({
    action: "finish",
    elementRef: null,
    value: null,
    rationale: "No action is needed.",
    coverage: "partial",
    summary: "The planner remained conservative."
  }))({
    target: `${target}/agent-static-control-copy-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    agentPrimaryRoutes: ["/agent-static-control-copy-destination"],
    agentNavigationRoutes: ["/"],
    agentExpectedTexts: [
      "Track any public product page",
      "Product URL",
      "Tracking instruction",
      "Frequency"
    ],
    agentExpectedControls: [
      "textbox:url:Product URL",
      "textbox:textarea:Tracking instruction",
      "combobox:select-one:Frequency",
      "button:submit:Compile monitor"
    ],
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.exploration.verification.satisfied, false);
  const visit = report.observations.exploration.steps[0];
  assert.ok(visit.destinationControlCount > 0);
  assert.ok(visit.destinationAssertions.every((assertion) => assertion.satisfied));
  assert.deepEqual(
    visit.destinationControlAssertions,
    [
      ["textbox", "url", "Product URL"],
      ["textbox", "textarea", "Tracking instruction"],
      ["combobox", "select-one", "Frequency"],
      ["button", "submit", "Compile monitor"]
    ].map(([role, type, name]) => ({
      role,
      type,
      name,
      matchCount: 0,
      satisfied: false
    }))
  );
  assert.equal(
    report.observations.exploration.verification.criteria.find(
      (criterion) =>
        criterion.id === "owner-declared-destination-controls-observed"
    ).satisfied,
    false
  );
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(regression, /yellowbirdReadSemanticControls/);
  assert.match(regression, /candidateTraversalComplete/);
  assert.doesNotMatch(regression, /getByRole\(/);
});

test("owned coverage normalizes native search and multi-select roles", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-native-semantic-")
  );
  const report = await createAgentRunner(() => ({
    action: "finish",
    elementRef: null,
    value: null,
    rationale: "The native controls were inspected.",
    coverage: "partial",
    summary: "The native controls were inspected."
  }))({
    target: `${target}/agent-native-semantic-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    agentPrimaryRoutes: ["/agent-native-semantic-destination"],
    agentExpectedTexts: ["Catalog filters"],
    agentExpectedControls: [
      "textbox:search:Catalog query",
      "combobox:select-multiple:Regions"
    ],
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.equal(report.observations.exploration.verification.satisfied, true);
  assert.deepEqual(
    report.observations.exploration.steps[0].destinationControlAssertions,
    [
      {
        role: "textbox",
        type: "search",
        name: "Catalog query",
        matchCount: 1,
        satisfied: true
      },
      {
        role: "combobox",
        type: "select-multiple",
        name: "Regions",
        matchCount: 1,
        satisfied: true
      }
    ]
  );
});

test("owned coverage uses browser accessibility semantics for controls", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-semantic-control-")
  );
  const report = await createAgentRunner(() => ({
    action: "finish",
    elementRef: null,
    value: null,
    rationale: "No action is needed.",
    coverage: "partial",
    summary: "The planner remained conservative."
  }))({
    target: `${target}/agent-semantic-spoof-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    agentPrimaryRoutes: ["/agent-semantic-spoof-destination"],
    agentExpectedTexts: ["Track any public product page"],
    agentExpectedControls: [
      "textbox:url:Product URL",
      "button:submit:Compile monitor"
    ],
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.deepEqual(
    report.observations.exploration.steps[0].destinationControlAssertions,
    [
      {
        role: "textbox",
        type: "url",
        name: "Product URL",
        matchCount: 0,
        satisfied: false
      },
      {
        role: "button",
        type: "submit",
        name: "Compile monitor",
        matchCount: 1,
        satisfied: true
      }
    ]
  );
  assert.equal(
    report.observations.exploration.verification.satisfied,
    false
  );
});

test("semantic controls ignore page-controlled selector resolution", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-semantic-selector-spoof-")
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
      rationale: "The route was inspected.",
      coverage: "covered",
      summary: "The route was inspected."
    }
  ];
  const report = await createAgentRunner(() => decisions.shift())({
    target: `${target}/agent-semantic-spoof-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    agentPrimaryRoutes: ["/agent-semantic-spoof-destination"],
    agentExpectedControls: ["textbox:url:Product URL"],
    outputDirectory
  });

  assert.deepEqual(
    report.observations.exploration.steps[0].destinationControlAssertions,
    [
      {
        role: "textbox",
        type: "url",
        name: "Product URL",
        matchCount: 0,
        satisfied: false
      }
    ]
  );
  assert.equal(report.observations.exploration.verification.satisfied, false);
});

test("semantic replay fails closed at the live traversal bound", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-semantic-replay-bound-")
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
      rationale: "The route was inspected.",
      coverage: "covered",
      summary: "The route was inspected."
    }
  ];
  const report = await createAgentRunner(() => decisions.shift())({
    target: `${target}/agent-semantic-bound-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    agentPrimaryRoutes: ["/agent-semantic-bound-destination"],
    agentExpectedControls: ["textbox:url:Product URL"],
    outputDirectory
  });

  assert.equal(report.observations.exploration.verification.satisfied, false);
  assert.equal(
    report.observations.exploration.steps[0].destinationControlAssertions[0]
      .matchCount,
    0
  );
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.doesNotMatch(regression, /getByRole\(/);
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.notEqual(replay.exitCode, 0, "Replay must preserve the live bound");
  assert.match(
    `${replay.stdout}\n${replay.stderr}`,
    /candidateTraversalComplete|Expected: true/i
  );
}, 30_000);

test("select option values stay outside planner input", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-option-reference-")
  );
  let planningCall = 0;
  const report = await createAgentRunner((request) => {
    planningCall += 1;
    assert.doesNotMatch(
      request.messages.at(-1).content,
      /internal-secret-92/
    );
    if (planningCall > 1) {
      return {
        action: "finish",
        elementRef: null,
        value: null,
        rationale: "The choice interaction was inspected.",
        coverage: "partial",
        summary: "The choice interaction was inspected."
      };
    }
    const availableElements = JSON.parse(
      request.messages.at(-1).content
    ).page.availableElements;
    const select = availableElements.find(
      (element) => element.allowedAction === "select"
    );
    assert.deepEqual(select.options, [
      { ref: "option-1", label: "Weekly" }
    ]);
    return {
      action: "act",
      elementRef: select.ref,
      value: select.options[0].ref,
      rationale: "Inspect the supplied interval choice.",
      coverage: "continue",
      summary: ""
    };
  })({
    target: `${target}/agent-option-reference-surface`,
    intent: "Assess the available choice interaction",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.observations.exploration.steps[0].status, "passed");
  assert.equal(
    report.observations.exploration.steps[0].value,
    "internal-secret-92"
  );
});

test("policy effects invalidate otherwise verified coverage", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-verified-policy-")
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
      rationale: "The setup route was inspected.",
      coverage: "covered",
      summary: "The setup route was inspected."
    }
  ];
  const report = await createAgentRunner(() => decisions.shift())({
    target: `${target}/agent-verified-policy-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    agentPrimaryRoutes: ["/agent-verified-policy-destination"],
    agentExpectedControls: ["textbox:text:Query"],
    outputDirectory
  });

  assert.equal(report.observations.exploration.coverage, "partial");
  assert.equal(report.observations.exploration.verification.satisfied, false);
  assert.deepEqual(
    report.observations.exploration.verification.criteria.at(-1),
    { id: "final-evidence-integrity", satisfied: false }
  );
});

test("operational failures invalidate otherwise verified coverage", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-verified-operation-")
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
      rationale: "The setup route was inspected.",
      coverage: "covered",
      summary: "The setup route was inspected."
    }
  ];
  const report = await createAgentRunner(
    () => decisions.shift(),
    undefined,
    launchBrowserWithFailingScreenshot
  )({
    target,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    agentExpectedControls: ["textbox:text:Email"],
    outputDirectory
  });

  assert.equal(report.observations.exploration.coverage, "partial");
  assert.equal(report.observations.exploration.verification.satisfied, false);
  assert.deepEqual(
    report.observations.exploration.verification.criteria.at(-1),
    { id: "final-evidence-integrity", satisfied: false }
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

test("owned coverage selects the primary visit matching owner declarations", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-multi-primary-")
  );
  const decisions = [
    {
      action: "act",
      elementRef: "element-1",
      value: null,
      rationale: "Inspect the first declared primary route.",
      coverage: "continue",
      summary: ""
    },
    {
      action: "act",
      elementRef: "element-1",
      value: null,
      rationale: "Inspect the next declared primary route.",
      coverage: "continue",
      summary: ""
    },
    {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "Both declared primary routes were inspected.",
      coverage: "covered",
      summary: "Both declared primary routes were inspected."
    }
  ];
  const report = await createAgentRunner(() => decisions.shift())({
    target: `${target}/agent-multi-primary-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    agentPrimaryRoutes: [
      "/agent-multi-primary-first",
      "/agent-multi-primary-second"
    ],
    agentExpectedTexts: ["Matching destination"],
    agentExpectedControls: ["textbox:text:Setup query"],
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.equal(report.observations.exploration.verification.satisfied, true);
  assert.deepEqual(
    report.observations.exploration.steps.map((step) => ({
      url: step.url,
      textSatisfied: step.destinationAssertions[0].satisfied,
      controlSatisfied: step.destinationControlAssertions[0].satisfied
    })),
    [
      {
        url: `${target}/agent-multi-primary-first`,
        textSatisfied: false,
        controlSatisfied: false
      },
      {
        url: `${target}/agent-multi-primary-second`,
        textSatisfied: true,
        controlSatisfied: true
      }
    ]
  );
});

test("owned coverage profile rejects a non-primary authorized route", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-route-relevance-")
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
          elementRef: availableElements.find(
            (element) => new URL(element.href).pathname === "/privacy"
          ).ref,
          value: null,
          rationale: "Review the authorized privacy route.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The route was reviewed.",
          coverage: "covered",
          summary: "The basic flow was covered."
        };
  })({
    target: `${target}/agent-unrelated-route-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    agentNavigationRoutes: ["/privacy"],
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.exploration.coverage, "partial");
  assert.equal(
    report.observations.exploration.verification.criteria.find(
      (criterion) => criterion.id === "primary-route-visited"
    ).satisfied,
    false
  );
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

test("agent redirect chains use the canonical prohibited-action policy", async () => {
  prohibitedRedirectRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-prohibited-redirect-")
  );
  const report = await createAgentRunner((request) => {
    const availableElements = JSON.parse(
      request.messages.at(-1).content
    ).page.availableElements;
    return {
      action: "act",
      elementRef: availableElements[0].ref,
      value: null,
      rationale: "Open the supplied setup route.",
      coverage: "continue",
      summary: ""
    };
  })({
    target: `${target}/agent-prohibited-redirect-surface`,
    intent: "Assess the setup route",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(prohibitedRedirectRequestCount, 0);
  assert.equal(report.outcome, "inconclusive");
  assert.ok(
    report.observations.blockedRequests.some(
      (request) =>
        request.url === `${target}/agent-flow#auth_callback` &&
        request.reason === "agent-prohibited-url"
    )
  );
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.ok(
    regression.includes(JSON.stringify(PROHIBITED_AGENT_ACTION_PATTERN))
  );
});

test("blocked fetch redirects retain exact attribution in live and replay", async () => {
  deleteAccountRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-fetch-redirect-")
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
          rationale: "Inspect the supplied setup route.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The setup route was inspected.",
          coverage: "covered",
          summary: "The setup route was inspected."
        };
  })({
    target: `${target}/agent-fetch-redirect-surface`,
    intent: "Assess the setup route",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.observations.pageErrors, []);
  assert.deepEqual(report.observations.failedRequests, []);
  assert.equal(deleteAccountRequestCount, 0);
  assert.ok(
    report.observations.blockedRequests.some(
      (request) =>
        request.reason === "agent-prohibited-url" &&
        request.url === `${target}/deleteAccount` &&
        request.redirectChain.includes(`${target}/agent-fetch-redirect`) &&
        request.redirectChain.includes(`${target}/deleteAccount`)
    )
  );
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
  assert.equal(deleteAccountRequestCount, 0);
}, 30_000);

test("blocked fetch attribution is scoped to one request occurrence", async () => {
  sameUrlCorrelationRequestCount = 0;
  deleteAccountRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-same-url-correlation-")
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
          rationale: "Inspect the supplied setup route.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The setup route was inspected.",
          coverage: "covered",
          summary: "The setup route was inspected."
        };
  })({
    target: `${target}/agent-same-url-correlation-surface`,
    intent: "Assess the setup route",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "attention");
  assert.equal(report.observations.pageErrors.length, 1);
  assert.match(report.observations.pageErrors[0].message, /aborted/i);
  assert.equal(deleteAccountRequestCount, 0);
  assert.ok(
    report.observations.blockedRequests.some(
      (request) =>
        request.url === `${target}/deleteAccount` &&
        request.redirectChain.includes(`${target}/agent-same-url-correlation`)
    )
  );

  sameUrlCorrelationRequestCount = 0;
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.notEqual(replay.exitCode, 0, "Replay must preserve the independent failure");
  assert.match(
    `${replay.stdout}\n${replay.stderr}`,
    /aborted|Failed to fetch|ERR_EMPTY_RESPONSE/i
  );
  assert.equal(deleteAccountRequestCount, 0);
}, 30_000);

test("fetch occurrence identities remain unique across documents", async () => {
  deleteAccountRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-realm-correlation-")
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
          rationale: "Inspect the supplied setup route.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The destination request failed independently.",
          coverage: "partial",
          summary: "The destination request failed independently."
        };
  })({
    target: `${target}/agent-realm-correlation-surface`,
    intent: "Assess the setup route",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(deleteAccountRequestCount, 0);
  assert.equal(report.outcome, "attention");
  assert.equal(report.observations.pageErrors.length, 1);
  assert.match(report.observations.pageErrors[0].message, /aborted/i);
  assert.ok(report.findings.some((finding) => finding.id === "page-errors"));
});

test("replay closes visit authority before asserting the recorded URL", async () => {
  replaySettlementDelayedRequestCount = 0;
  changeReplaySettlementUrl = false;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-replay-settlement-")
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
          rationale: "Inspect the supplied setup route.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The setup route was inspected.",
          coverage: "covered",
          summary: "The setup route was inspected."
        };
  })({
    target: `${target}/agent-replay-settlement-surface`,
    intent: "Assess the setup route",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.observations.exploration.steps.length, 1);
  assert.equal(replaySettlementDelayedRequestCount, 0);
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  changeReplaySettlementUrl = true;
  try {
    const replay = await runCommand(
      [process.execPath, "run", "test"],
      outputDirectory
    );
    assert.notEqual(replay.exitCode, 0, "The changed replay URL must fail its assertion");
    assert.equal(replaySettlementDelayedRequestCount, 0);
  } finally {
    changeReplaySettlementUrl = false;
  }
}, 30_000);

test("same-document auth routing invalidates an agent visit", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-same-document-")
  );
  const report = await createAgentRunner((request) => {
    const availableElements = JSON.parse(
      request.messages.at(-1).content
    ).page.availableElements;
    return {
      action: "act",
      elementRef: availableElements[0].ref,
      value: null,
      rationale: "Open the supplied setup route.",
      coverage: "continue",
      summary: ""
    };
  })({
    target: `${target}/agent-same-document-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.ok(
    report.observations.blockedRequests.some(
      (request) => request.reason === "agent-prohibited-navigation"
    )
  );
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(regression, /hashchange/);
  assert.match(regression, /url\.search\.replaceAll\("\+", " "\)/);
});

test("page code cannot disable the agent navigation guard", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-guard-tamper-")
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
          rationale: "Open the supplied setup route.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The setup route was observed.",
          coverage: "covered",
          summary: "The setup route was observed."
        };
  })({
    target: `${target}/agent-guard-tamper-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.ok(
    report.observations.blockedRequests.some(
      (request) => request.reason === "agent-prohibited-navigation"
    )
  );
  assert.equal(
    report.observations.exploration.steps[0].url,
    `${target}/agent-guard-tamper-destination`
  );
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.notEqual(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
  assert.match(`${replay.stdout}\n${replay.stderr}`, /prohibited-navigation/);
}, 30_000);

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

test("agent replay rejects a destination HTTP error found live", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-http-error-")
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
          rationale: "Inspect the supplied preview route.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The preview route returned an HTTP error.",
          coverage: "partial",
          summary: "The preview route returned an HTTP error."
        };
  })({
    target: `${target}/agent-http-error-surface`,
    intent: "Assess the preview route",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "attention");
  assert.ok(report.findings.some((finding) => finding.id === "http-errors"));
  assert.equal(report.observations.exploration.steps[0].status, "failed");
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(regression, /toBeLessThan\(400\)/);

  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.notEqual(replay.exitCode, 0, "Replay must retain the HTTP health invariant");
}, 30_000);

async function assertAuthorizedRuntimeFailureReplay({
  findingId,
  observedPath,
  surfacePath
}) {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-product-runtime-errors-")
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
          rationale: "Inspect the supplied catalog route.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The catalog runtime signals were observed.",
          coverage: "partial",
          summary: "The catalog runtime signals were observed."
        };
  })({
    target: `${target}${surfacePath}`,
    intent: "Assess catalog runtime health",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "attention");
  assert.ok(report.findings.some((finding) => finding.id === findingId));
  assert.equal(
    report.findings.some(
      (finding) =>
        finding.id ===
        (findingId === "http-errors" ? "failed-requests" : "http-errors")
    ),
    false
  );
  assert.ok(
    [...report.observations.serverErrors, ...report.observations.failedRequests]
      .some((entry) => entry.url === `${target}${observedPath}`)
  );

  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.notEqual(
    replay.exitCode,
    0,
    "Replay must preserve live response and request failure invariants"
  );
  assert.match(
    `${replay.stdout}\n${replay.stderr}`,
    new RegExp(observedPath.slice(1))
  );
}

test("agent replay preserves an authorized subresource HTTP error", async () => {
  await assertAuthorizedRuntimeFailureReplay({
    findingId: "http-errors",
    observedPath: "/agent-product-http-error",
    surfacePath: "/agent-product-http-error-surface"
  });
}, 30_000);

test("agent replay preserves an authorized request failure", async () => {
  await assertAuthorizedRuntimeFailureReplay({
    findingId: "failed-requests",
    observedPath: "/agent-product-network-failure",
    surfacePath: "/agent-product-network-failure-surface"
  });
}, 30_000);

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
  assert.ok(
    report.invalidTestMechanics.some(
      (issue) => issue.id === "agent-effect-blocked"
    )
  );
  assert.ok(
    report.observations.blockedRequests.some(
      (request) =>
        request.method === "POST" &&
        request.reason === "agent-non-read-method"
    )
  );
});

test("agent navigation requires owner-declared positive route authority", async () => {
  readMutationRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-route-authority-")
  );
  const exposedPaths = [];
  let planningCall = 0;
  const report = await createAgentRunner((request) => {
    const availableElements = JSON.parse(
      request.messages.at(-1).content
    ).page.availableElements;
    exposedPaths.push(
      ...availableElements
        .filter((element) => element.href)
        .map((element) => new URL(element.href).pathname)
    );
    planningCall += 1;
    return planningCall === 1
      ? {
          action: "act",
          elementRef: availableElements[0].ref,
          value: null,
          rationale: "Open the declared setup route.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The declared route was inspected.",
          coverage: "partial",
          summary: "The declared route was inspected."
        };
  })({
    target: `${target}/agent-undeclared-navigation-surface`,
    intent: "Assess the setup route",
    exploreIntent: true,
    outputDirectory
  });

  assert.ok(exposedPaths.includes("/agent-flow"));
  assert.equal(exposedPaths.includes("/agent-read-mutation"), false);
  assert.equal(readMutationRequestCount, 0);
  assert.equal(report.observations.exploration.steps.length, 1);
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
  assert.ok(
    report.invalidTestMechanics.some(
      (issue) => issue.id === "agent-effect-blocked"
    )
  );
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

test("blocked fetch attribution preserves an independent page error", async () => {
  readMutationRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-error-correlation-")
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
    target: `${target}/agent-error-correlation-surface`,
    intent: "Assess the preview interaction",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(readMutationRequestCount, 0);
  assert.equal(report.outcome, "attention");
  assert.equal(report.observations.pageErrors.length, 1);
  assert.match(
    report.observations.pageErrors[0].message,
    /Failed to fetch catalog independently/
  );
  assert.doesNotMatch(
    JSON.stringify(report.observations.pageErrors),
    /__yellowbird_fetch_failure__/
  );
  assert.ok(
    report.observations.blockedRequests.some(
      (request) => request.reason === "agent-non-visit-request"
    )
  );
});

test("agent action guards block effects delayed between planning rounds", async () => {
  delayedReadMutationRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-delayed-mutation-")
  );
  let planningCall = 0;
  const report = await createAgentRunner(async (request) => {
    const availableElements = JSON.parse(
      request.messages.at(-1).content
    ).page.availableElements;
    planningCall += 1;
    if (planningCall === 1) {
      return {
        action: "act",
        elementRef: availableElements[0].ref,
        value: null,
        rationale: "View the supplied preview control.",
        coverage: "continue",
        summary: ""
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "The preview control was inspected.",
      coverage: "covered",
      summary: "The preview control was inspected."
    };
  })({
    target: `${target}/agent-delayed-mutation-surface`,
    intent: "Assess the preview interaction",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(delayedReadMutationRequestCount, 0);
  assert.equal(report.outcome, "inconclusive");
  assert.ok(
    report.observations.blockedRequests.some(
      (request) => request.reason === "agent-non-visit-request"
    )
  );
});

test("failed visits close authority before delayed requests", async () => {
  failedVisitDelayedRequestCount = 0;
  failVisitNavigation = true;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-failed-visit-")
  );
  try {
    const report = await createAgentRunner(
      (request) => {
        const availableElements = JSON.parse(
          request.messages.at(-1).content
        ).page.availableElements;
        return {
          action: "act",
          elementRef: availableElements[0].ref,
          value: null,
          rationale: "Inspect the supplied route.",
          coverage: "continue",
          summary: ""
        };
      },
      undefined,
      launchBrowserWithDelayedScreenshot
    )({
      target: `${target}/agent-failed-visit-surface`,
      intent: "Assess the setup route",
      exploreIntent: true,
      outputDirectory
    });

    assert.equal(failedVisitDelayedRequestCount, 0);
    assert.equal(report.outcome, "attention");
    assert.match(
      report.observations.exploration.steps[0].evidence,
      /ERR_FAILED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/
    );
    assert.equal(
      report.observations.exploration.steps[0].navigationAttempted,
      true
    );
    assert.ok(
      report.observations.blockedRequests.some(
        (request) =>
          request.url === `${target}/agent-failed-visit-delayed` &&
          request.reason === "agent-non-visit-request"
      )
    );
    const regression = await readFile(report.artifacts.regression, "utf8");
    assert.match(regression, /yellowbirdRunAgentAction/);
    assert.match(regression, /finally \{/);
    assert.match(regression, /agent-failed-visit-destination/);
    const install = await runCommand(
      [process.execPath, "install"],
      outputDirectory
    );
    assert.equal(install.exitCode, 0, install.stderr);
    const replay = await runCommand(
      [process.execPath, "run", "test"],
      outputDirectory
    );
    assert.notEqual(
      replay.exitCode,
      0,
      "Replay must retain the authorized visit request failure"
    );
  } finally {
    failVisitNavigation = false;
  }
}, 30_000);

test("visit authority allows bounded load requests and blocks delayed effects in live and replay", async () => {
  initialVisitReadRequestCount = 0;
  initialDelayedVisitMutationRequestCount = 0;
  visitReadRequestCount = 0;
  delayedVisitMutationRequestCount = 0;
  visitEventSourceRequestCount = 0;
  visitWebSocketUpgradeCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-delayed-visit-mutation-")
  );
  let planningCall = 0;
  let destinationLabels = [];
  const report = await createAgentRunner(async (request) => {
    const availableElements = JSON.parse(
      request.messages.at(-1).content
    ).page.availableElements;
    planningCall += 1;
    if (planningCall === 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        action: "act",
        elementRef: availableElements[0].ref,
        value: null,
        rationale: "Open the supplied setup route.",
        coverage: "continue",
        summary: ""
      };
    }
    destinationLabels = availableElements.map((element) => element.label);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "The setup route was observed.",
      coverage: "covered",
      summary: "The setup route was observed."
    };
  })({
    target: `${target}/agent-delayed-visit-mutation-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(initialVisitReadRequestCount, 1);
  assert.equal(initialDelayedVisitMutationRequestCount, 0);
  assert.equal(visitReadRequestCount, 1);
  assert.equal(delayedVisitMutationRequestCount, 0);
  assert.equal(visitEventSourceRequestCount, 1);
  assert.ok(destinationLabels.includes("Stream ready"));
  assert.equal(visitWebSocketUpgradeCount, 0);
  assert.equal(report.outcome, "inconclusive");
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.observations.pageErrors, []);
  assert.ok(
    report.observations.blockedRequests.some(
      (request) => request.reason === "agent-non-visit-request"
    )
  );
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
  assert.equal(initialVisitReadRequestCount, 2);
  assert.equal(initialDelayedVisitMutationRequestCount, 0);
  assert.equal(visitReadRequestCount, 2);
  assert.equal(delayedVisitMutationRequestCount, 0);
  assert.equal(visitEventSourceRequestCount, 2);
  assert.equal(visitWebSocketUpgradeCount, 0);
}, 30_000);

test("rendered text bounds each range before browser geometry", async () => {
  const page = await sharedBrowser.newPage();
  try {
    await page.setContent(`<main>${"x".repeat(100_000)}</main>`);
    await page.evaluate(() => {
      const original = Range.prototype.getBoundingClientRect;
      globalThis.maximumMeasuredRange = 0;
      Range.prototype.getBoundingClientRect = function () {
        globalThis.maximumMeasuredRange = Math.max(
          globalThis.maximumMeasuredRange,
          this.toString().length
        );
        return original.call(this);
      };
    });
    const text = await page.evaluate(browserRenderedTextSnapshot, {
      maximum: 8_000,
      traversalNodeCount: 5_000
    });

    assert.equal(text.length, 8_000);
    assert.equal(
      await page.evaluate(() => globalThis.maximumMeasuredRange),
      8_000
    );
  } finally {
    await page.close();
  }
});

test("agent snapshots bound page fields, select options, and total prompt size", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-snapshot-boundary-")
  );
  let firstPlannerInput;
  let planningCall = 0;
  const report = await createAgentRunner((request) => {
    const plannerInput = JSON.parse(request.messages.at(-1).content);
    planningCall += 1;
    if (planningCall === 1) {
      firstPlannerInput = plannerInput;
      const visit = plannerInput.page.availableElements.find(
        (element) => element.allowedAction === "visit"
      );
      return {
        action: "act",
        elementRef: visit.ref,
        value: null,
        rationale: "Open the supplied setup route.",
        coverage: "continue",
        summary: ""
      };
    }
    return {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "The bounded snapshot was inspected.",
      coverage: "partial",
      summary: "The bounded snapshot was inspected."
    };
  })({
    target: `${target}/agent-snapshot-boundary`,
    intent: "Assess the available setup choices",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(firstPlannerInput.page.text.length, 8_000);
  assert.equal(
    firstPlannerInput.page.availableElements.some(
      (element) => element.allowedAction === "select"
    ),
    false
  );
  assert.equal(
    firstPlannerInput.page.availableElements.some(
      (element) => element.allowedAction === "click"
    ),
    false
  );
  assert.ok(JSON.stringify(firstPlannerInput.page).length < 50_000);
  assert.equal(report.observations.exploration.steps.length, 1);
  const screenshot = await readFile(report.artifacts.screenshot);
  assert.equal(screenshot.readUInt32BE(16), 1440);
  assert.equal(screenshot.readUInt32BE(20), 900);
});

test("agent snapshots stop traversal before controls beyond the DOM bound", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-deep-snapshot-boundary-")
  );
  let planningCalls = 0;
  const startedAt = Date.now();
  const report = await createAgentRunner(() => {
    planningCalls += 1;
    throw new Error("a control beyond the DOM traversal bound must not be exposed");
  })({
    target: `${target}/agent-deep-snapshot-boundary`,
    intent: "Assess the basic user flow",
    exploreIntent: true,
    outputDirectory,
    timeoutMs: 1_000
  });

  assert.equal(planningCalls, 0);
  assert.equal(report.outcome, "inconclusive");
  assert.ok(
    report.invalidTestMechanics.some(
      (issue) => issue.id === "agent-no-authorized-actions"
    )
  );
  assert.ok(Date.now() - startedAt < 2_000);
}, 5_000);

test("agent replay locators stay bounded when broad matches exceed the DOM limit", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-replay-locator-boundary-")
  );
  let planningCall = 0;
  let firstAvailableElements;
  const report = await createAgentRunner((request) => {
    const plannerInput = JSON.parse(request.messages.at(-1).content);
    planningCall += 1;
    if (planningCall === 1) {
      firstAvailableElements = plannerInput.page.availableElements;
      return {
        action: "act",
        elementRef: firstAvailableElements[0].ref,
        value: null,
        rationale: "Exercise the visible query field.",
        coverage: "continue",
        summary: ""
      };
    }
    return {
      action: "finish",
      elementRef: null,
      value: null,
      rationale: "The visible field was inspected.",
      coverage: "partial",
      summary: "The visible field was inspected."
    };
  })({
    target: `${target}/agent-replay-locator-boundary`,
    intent: "Assess the visible query field interaction",
    exploreIntent: true,
    outputDirectory
  });

  assert.deepEqual(
    firstAvailableElements.map((element) => element.label),
    ["Visible query"]
  );
  assert.deepEqual(report.observations.exploration.steps[0].locator, {
    kind: "css",
    selector: ":root > body:nth-child(2) > input:nth-child(1)",
    ordinal: 0,
    matchCount: 1
  });
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(regression, /toHaveCount\(1\)/);
}, 10_000);

test("detached accessible-name candidates are skipped within a bounded interval", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-detaching-snapshot-")
  );
  let planningCalls = 0;
  const startedAt = Date.now();
  const report = await createAgentRunner(() => {
    planningCalls += 1;
    throw new Error("detached controls must not reach the planner");
  })({
    target: `${target}/agent-detaching-surface`,
    intent: "Assess the basic user flow",
    exploreIntent: true,
    outputDirectory,
    timeoutMs: 500
  });
  const durationMs = Date.now() - startedAt;

  assert.equal(planningCalls, 0);
  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.invalidTestMechanics[0].id, "agent-no-authorized-actions");
  assert.ok(durationMs < 2_000, `snapshot took ${durationMs} ms`);
}, 5_000);

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

test("versioned agent authority performs one exact mutation and replays model-free", async () => {
  authorizedMutationRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-authorized-workflow-")
  );
  const report = await runSharedScout({
    target: `${target}/authorized-workflow`,
    agentPrimaryRoutes: undefined,
    agentLoadRoutes: undefined,
    intent: "Complete the owner-authorized fixture workflow",
    exploreIntent: true,
    maxAgentSteps: 2,
    permissions: [
      "browser.navigate",
      "browser.read",
      "browser.fill",
      "browser.click",
      "browser.submit"
    ],
    agentAuthorization: {
      schema: "yellowbird.agent.v1",
      mode: "authorized-workflow",
      fields: [
        {
          role: "textbox",
          type: "text",
          name: "Fixture name",
          value: "isolated-yellowbird-fixture"
        }
      ],
      mutationControls: [
        { role: "button", type: "submit", name: "Commit fixture" }
      ],
      mutationRoutes: [
        { method: "POST", url: "/api/fixture-items", maxRequests: 1 }
      ],
      expectedTexts: ["Fixture committed successfully"]
    },
    outputDirectory
  });

  assert.equal(authorizedMutationRequestCount, 1);
  assert.equal(report.outcome, "clear");
  assert.equal(report.observations.exploration.mode, "agent-authorized-workflow");
  assert.equal(report.observations.exploration.verification.profile, "authorized-workflow.v1");
  assert.equal(report.observations.exploration.verification.satisfied, true);
  assert.deepEqual(
    report.observations.exploration.steps.map((step) => step.action),
    ["fill", "mutate"]
  );
  assert.deepEqual(
    report.observations.exploration.steps[1].mutationRequests,
    [{ method: "POST", url: `${target}/api/fixture-items` }]
  );

  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
  assert.equal(authorizedMutationRequestCount, 2);
}, 30_000);

test("CLI runs a versioned authorized-agent scenario with the local planner", async () => {
  authorizedMutationRequestCount = 0;
  const fixtureDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-cli-fixture-")
  );
  const scenarioPath = join(fixtureDirectory, "authorized.scenario.json");
  const outputDirectory = join(fixtureDirectory, "output");
  await writeFile(
    scenarioPath,
    `${JSON.stringify({
      schema: "yellowbird.scenario.v1",
      target: `${target}/authorized-workflow`,
      intent: "Complete the owner-authorized fixture workflow",
      permissions: [
        "browser.navigate",
        "browser.read",
        "browser.fill",
        "browser.click",
        "browser.submit"
      ],
      assertions: { expectedStatus: 200 },
      agent: {
        schema: "yellowbird.agent.v1",
        mode: "authorized-workflow",
        fields: [
          {
            role: "textbox",
            type: "text",
            name: "Fixture name",
            value: "cli-isolated-fixture"
          }
        ],
        mutationControls: [
          { role: "button", type: "submit", name: "Commit fixture" }
        ],
        mutationRoutes: [
          { method: "POST", url: "/api/fixture-items", maxRequests: 1 }
        ],
        expectedTexts: ["Fixture committed successfully"]
      },
      steps: []
    }, null, 2)}\n`,
    "utf8"
  );

  const cli = await runCommand(
    [
      process.execPath,
      "bin/yellowbird.js",
      "scout",
      "--scenario",
      scenarioPath,
      "--output",
      outputDirectory
    ],
    resolve(".")
  );
  assert.equal(cli.exitCode, 0, `${cli.stdout}\n${cli.stderr}`);
  assert.equal(authorizedMutationRequestCount, 1);
  const evidence = JSON.parse(
    await readFile(join(outputDirectory, "evidence.json"), "utf8")
  );
  assert.equal(evidence.outcome, "clear");
  assert.equal(
    evidence.observations.exploration.verification.profile,
    "authorized-workflow.v1"
  );
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
  assert.equal(authorizedMutationRequestCount, 2);
}, 30_000);

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
  assert.deepEqual(report.observations.pageErrors, []);
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
  assert.equal(crossOriginRequestCount, 0);
}, 30_000);

test("peer transports are blocked and recorded during exploration", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-peer-transport-")
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
          rationale: "View the supplied peer details.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "The peer details were inspected.",
          coverage: "covered",
          summary: "The peer details were inspected."
        };
  })({
    target: `${target}/agent-peer-transport-surface`,
    intent: "Assess the peer details interaction",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.exploration.coverage, "partial");
  assert.ok(
    report.observations.blockedRequests.some(
      (request) => request.reason === "agent-peer-transport"
    )
  );
  assert.ok(
    report.observations.blockedRequests.some(
      (request) => request.reason === "agent-worker-realm"
    )
  );
  assert.deepEqual(report.observations.pageErrors, []);
});

test("pre-aborted cross-origin fetches are blocked and recorded before dispatch", async () => {
  crossOriginRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-pre-aborted-cross-origin-")
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
    target: `${target}/agent-pre-aborted-cross-origin-surface`,
    intent: "Assess the preview interaction",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(crossOriginRequestCount, 0);
  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.observations.exploration.coverage, "partial");
  assert.ok(
    report.observations.blockedRequests.some(
      (request) =>
        request.reason === "agent-cross-origin" &&
        request.url ===
          `http://localhost:${server.address().port}/agent-cross-origin-read`
    )
  );
  assert.deepEqual(report.observations.pageErrors, []);
  assert.deepEqual(report.observations.failedRequests, []);
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
  assert.equal(crossOriginRequestCount, 0);
}, 30_000);

test("product findings take precedence when related targets make coverage inconclusive", async () => {
  relatedTargetEffectCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-related-targets-")
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
          rationale: "View the supplied related details control.",
          coverage: "continue",
          summary: ""
        }
      : {
          action: "finish",
          elementRef: null,
          value: null,
          rationale: "Related targets attempted effects outside policy.",
          coverage: "partial",
          summary: "Related targets attempted effects outside policy."
        };
  })({
    target: `${target}/agent-related-target-surface`,
    intent: "Assess the related details interaction",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(relatedTargetEffectCount, 0);
  assert.equal(report.outcome, "attention");
  assert.ok(report.findings.some((finding) => finding.id === "page-errors"));
  assert.ok(
    report.invalidTestMechanics.some(
      (issue) => issue.id === "browser-related-target-created"
    )
  );
  assert.ok(
    report.observations.blockedRequests.some(
      (request) =>
        request.url === `${target}/agent-related-target-effect` &&
        ["GET", "POST"].includes(request.method)
    )
  );
  const markdown = await readFile(report.artifacts.report, "utf8");
  assert.match(markdown, /> \*\*ATTENTION \+ ERROR\*\*/);
  assert.match(markdown, /YellowBird run: \*\*ERROR\*\*/);
  assert.match(markdown, /Product signal: 1 failure signal observed\./);
});

test("agent policy omits cross-origin and authentication controls", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-safety-surface-")
  );
  const exposedLabels = [];
  const plannerInputs = [];
  let planningCall = 0;
  const report = await createAgentRunner((request) => {
    const plannerInput = JSON.parse(request.messages.at(-1).content);
    plannerInputs.push(request.messages.at(-1).content);
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
  assert.doesNotMatch(
    plannerInputs.join("\n"),
    /secret|user_auth|auth_callback|authCallback|deleteAccount|createMonitor|hidden-copy-secret|aria-copy-secret|css-copy-secret/
  );
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
  assert.equal(report.observations.exploration.coverage, "partial");
  assert.equal(report.invalidTestMechanics[0].id, "agent-model-transition");
  assert.equal(report.provenance.engine.modelReported, "planner-model");
  assert.equal(
    report.provenance.agenticEngine,
    "test-compatible-engine:planner-model"
  );
});

test("report markdown escapes provider-controlled model names", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-model-markdown-")
  );
  const modelReported = "[planner](https://example.test) | <script>";
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
          modelRequested: modelReported,
          modelReported,
          capabilityManifestVersion: "yellowbird.engine-capabilities.v1"
        }),
        completeStructured: async () => {
          throw new Error("the static page must not invoke the planner");
        }
      }
    })
  )({
    target: `${target}/static`,
    intent: "Assess the static interface",
    exploreIntent: true,
    outputDirectory
  });

  const markdown = await readFile(report.artifacts.report, "utf8");
  assert.ok(
    markdown.includes(
      String.raw`- Engine: test-compatible-engine:\[planner\](https://example.test) \| \<script\>`
    )
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

test("policy blocks remain alongside an independent engine failure", async () => {
  deleteAccountRequestCount = 0;
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-agent-issue-aggregation-")
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
        remediation: "Start a compatible engine."
      }
    })
  });

  const report = await runWithoutAgent({
    target: `${target}/agent-realm-correlation-surface`,
    intent: "Assess the initial interface and basic user flow",
    exploreIntent: true,
    outputDirectory
  });

  assert.equal(deleteAccountRequestCount, 0);
  assert.equal(
    report.observations.exploration.issue.id,
    "agent-engine-unavailable"
  );
  assert.deepEqual(
    report.invalidTestMechanics.map((issue) => issue.id).slice(0, 2),
    ["agent-engine-unavailable", "agent-effect-blocked"]
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

test("CLI rejects missing and empty option operands", async () => {
  for (const optionTail of [["--intent", ""], ["--intent"]]) {
    const result = await runCommand(
      [
        process.execPath,
        resolve("bin/yellowbird.js"),
        "scout",
        "--target",
        target,
        ...optionTail
      ],
      resolve(".")
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--intent requires a non-empty value/);
    assert.doesNotMatch(result.stdout, /Scout scout_/);
  }
});

test("CLI keeps invalid engine configuration fatal", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-invalid-engine-")
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
      "file:///tmp/not-an-engine",
      "--output",
      outputDirectory
    ],
    resolve(".")
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /engine endpoint must use http or https/);
  await assert.rejects(stat(join(outputDirectory, "evidence.json")));
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
        "--no-agent",
        "--agent-primary-route",
        "/agent-flow",
        "--agent-expect-text",
        "Create monitor",
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
      "YellowBird observed the initial page, visited a distinct authorized setup route, and matched the owner-declared destination text."
    );
    assert.deepEqual(
      evidence.observations.exploration.steps[0].destinationAssertions,
      [{ text: "Create monitor", satisfied: true }]
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

test("standalone intent fixture runs end to end including replay", async () => {
  const intentFlow = await startIntentFlowTarget();
  let plannerCalls = 0;
  const engineServer = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "intent-flow-planner" }] }));
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
    const output =
      schemaName === "yellowbird_capability_probe"
        ? { status: "ready", nextAction: "inspect" }
        : plannerCalls++ === 0
          ? {
              action: "act",
              elementRef: "element-1",
              value: null,
              rationale: "Open the supplied watch preview.",
              coverage: "continue",
              summary: ""
            }
          : plannerCalls === 2
            ? {
                action: "act",
                elementRef: "element-1",
                value: null,
                rationale: "Exercise the item URL field safely.",
                coverage: "continue",
                summary: ""
              }
            : {
                action: "finish",
                elementRef: null,
                value: null,
                rationale: "The fixture preview flow was inspected.",
                coverage: "covered",
                summary: "The fixture preview flow was inspected."
              };
    response.end(
      JSON.stringify({
        model: "intent-flow-planner",
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
      join(tmpdir(), "yellowbird-intent-flow-e2e-")
    );
    const result = await runCommand(
      [
        process.execPath,
        resolve("bin/yellowbird.js"),
        "scout",
        "--target",
        intentFlow.url,
        "--intent",
        "Assess the initial interface and basic user flow",
        "--expect-title",
        "Intent flow fixture",
        "--agent-primary-route",
        "/watch",
        "--agent-expect-text",
        "Preview a watch",
        "--agent-expect-control",
        "textbox:url:Item URL",
        "--engine-base-url",
        `http://127.0.0.1:${engineServer.address().port}/v1`,
        "--engine-model",
        "intent-flow-planner",
        "--output",
        outputDirectory
      ],
      resolve(".")
    );

    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    const evidence = JSON.parse(
      await readFile(join(outputDirectory, "evidence.json"), "utf8")
    );
    assert.equal(evidence.outcome, "clear");
    assert.equal(evidence.observations.exploration.status, "completed");
    assert.deepEqual(evidence.assertions.agentExpectedControls, [
      { role: "textbox", type: "url", name: "Item URL" }
    ]);
    assert.deepEqual(
      evidence.observations.exploration.steps.map(
        ({ action, status }) => ({ action, status })
      ),
      [
        { action: "visit", status: "passed" },
        { action: "fill", status: "passed" }
      ]
    );
    assert.equal(
      evidence.observations.exploration.steps[0].url,
      `${intentFlow.url}/watch`
    );
    assert.deepEqual(
      evidence.observations.exploration.steps[0].destinationAssertions,
      [{ text: "Preview a watch", satisfied: true }]
    );
    assert.deepEqual(
      evidence.observations.exploration.steps[0].destinationControlAssertions,
      [
        {
          role: "textbox",
          type: "url",
          name: "Item URL",
          matchCount: 1,
          satisfied: true
        }
      ]
    );

    const install = await runCommand(
      [process.execPath, "install"],
      outputDirectory
    );
    assert.equal(install.exitCode, 0, install.stderr);
    const replay = await runCommand(
      [process.execPath, "run", "test"],
      outputDirectory
    );
    assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
  } finally {
    await new Promise((resolve, reject) => {
      engineServer.close((error) => (error ? reject(error) : resolve()));
    });
    await intentFlow.close();
  }
}, 30_000);

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
  const report = await runSharedScout({
    target,
    expectedTitle: "Feather Shop",
    expectedTexts: ["Checkout ready"],
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.equal(report.findings.length, 0);
  assert.equal(report.observations.status, 200);
  assert.equal(report.target.authorization.method, "local-loopback-attestation");

  const markdown = await readFile(report.artifacts.report, "utf8");
  assert.match(
    markdown,
    /> \*\*LIMITED\*\* - YellowBird completed, but the run did not exercise a declared functional workflow\./
  );
  assert.match(
    markdown,
    /Effective scope: Initial-page smoke check; no declared workflow; 3 product assertions\./
  );
  assert.doesNotMatch(markdown, /- Outcome: \*\*clear\*\*/);

  await Promise.all(Object.values(report.artifacts).map((path) => stat(path)));
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(regression, /toHaveTitle\("Feather Shop"\)/);
  assert.match(
    regression,
    /yellowbirdReadRenderedBodyText\(20000\)\)\.toContain\("Checkout ready"\)/
  );

  const evidence = JSON.parse(await readFile(report.artifacts.evidence, "utf8"));
  const schema = JSON.parse(
    await readFile(resolve("schemas/scout-evidence.v2.schema.json"), "utf8")
  );
  assert.equal(evidence.schema, "yellowbird.scout-evidence.v2");
  assert.equal(schema.properties.schema.const, evidence.schema);
  assertConformsToSchema(schema, evidence);
  assert.equal(evidence.provenance.agenticEngine, null);
});

test("initial-page smoke counts the enforced HTTP status assertion", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-status-assertion-")
  );
  const report = await runSharedScout({
    target,
    expectedStatus: 200,
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  const markdown = await readFile(report.artifacts.report, "utf8");
  assert.match(
    markdown,
    /> \*\*LIMITED\*\* - YellowBird completed, but the run did not exercise a declared functional workflow\./
  );
  assert.match(
    markdown,
    /Effective scope: Initial-page smoke check; no declared workflow; 1 product assertion\./
  );
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

test("historical v2 evidence without exploration remains valid", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-historical-v2-")
  );
  const evidence = await runSharedScout({
    target,
    outputDirectory
  });
  delete evidence.observations.exploration;
  delete evidence.assertions.agentExpectedTexts;
  delete evidence.assertions.agentExpectedControls;
  const schema = JSON.parse(
    await readFile(resolve("schemas/scout-evidence.v2.schema.json"), "utf8")
  );

  assertConformsToSchema(schema, evidence);
});

test("scout reports explicit failures without changing expected results", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-attention-"));
  const report = await runSharedScout({
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

  const markdown = await readFile(report.artifacts.report, "utf8");
  assert.match(
    markdown,
    /> \*\*ATTENTION\*\* - 2 product failure signals require attention\./
  );
  assert.match(
    markdown,
    /YellowBird run: Completed without test-mechanics errors\./
  );
  assert.match(markdown, /Product signal: 2 failure signals observed\./);

  const diagnostics = await readFile(report.artifacts.diagnostics, "utf8");
  assert.doesNotMatch(diagnostics, /checkout failed/);
});

test("scout repairs a loopback HTTPS-to-HTTP transport mismatch with diagnostics", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-repair-"));
  const reportPath = join(outputDirectory, "price-scout.md");
  const requestedTarget = `${target.replace("http:", "https:")}/?token=not-for-logs`;
  const report = await runSharedScout({
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
  const report = await runSharedScout({
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
  const report = await runSharedScout({
    target: `${target}/delayed-workflow`,
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
        target: { role: "textbox", name: "Email" },
        value: "bird@example.test"
      },
      {
        id: "prepare-order",
        action: "click",
        target: { role: "button", name: "Bu", exact: false }
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
  const markdown = await readFile(report.artifacts.report, "utf8");
  assert.match(
    markdown,
    /Effective scope: Declared workflow; 3\/3 step\(s\) exercised; 2 product assertions\./
  );
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(
    regression,
    /getByRole\("textbox", \{ name: "Email", exact: true \}\)\.fill/
  );
  assert.match(
    regression,
    /getByRole\("button", \{ name: "Bu", exact: false \}\)\.click/
  );
  assert.match(regression, /toContainText\("Order ready"\)/);
});

test("scenario visual assertion passes live and replay then detects drift", async () => {
  const fixtureDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-visual-fixture-")
  );
  const baselinePath = join(fixtureDirectory, "card.png");
  const baselinePage = await sharedBrowser.newPage({
    viewport: { width: 1440, height: 900 }
  });
  try {
    await baselinePage.goto(`${target}/visual-fixture`, {
      waitUntil: "domcontentloaded"
    });
    await writeFile(
      baselinePath,
      await baselinePage.locator("#card").screenshot({
        animations: "disabled",
        caret: "hide"
      })
    );
  } finally {
    await baselinePage.close();
  }
  const scenarioPath = join(fixtureDirectory, "visual.scenario.json");
  await writeFile(
    scenarioPath,
    `${JSON.stringify({
      schema: "yellowbird.scenario.v1",
      target: `${target}/visual-fixture`,
      intent: "Verify the visual card contract",
      permissions: ["browser.navigate", "browser.read"],
      assertions: { expectedStatus: 200 },
      steps: [
        {
          id: "card-visual",
          action: "expectVisual",
          selector: "#card",
          baseline: "card.png",
          maxDiffPixelRatio: 0,
          colorThreshold: 0
        }
      ]
    }, null, 2)}\n`,
    "utf8"
  );
  const scenario = await loadScenarioFile(scenarioPath);
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-visual-output-")
  );
  const report = await runSharedScout({
    target: scenario.target,
    intent: scenario.intent,
    permissions: scenario.permissions,
    steps: scenario.steps,
    expectedStatus: scenario.assertions.expectedStatus,
    exploreIntent: false,
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.equal(report.observations.workflowSteps[0].status, "passed");
  assert.equal(
    report.observations.workflowSteps[0].visual.diffPixelRatio,
    0
  );
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);

  visualFixtureChanged = true;
  try {
    const driftReplay = await runCommand(
      [process.execPath, "run", "test"],
      outputDirectory
    );
    assert.notEqual(
      driftReplay.exitCode,
      0,
      `${driftReplay.stdout}\n${driftReplay.stderr}`
    );
    assert.match(
      `${driftReplay.stdout}\n${driftReplay.stderr}`,
      /diffPixelRatio|toBeLessThanOrEqual/
    );
  } finally {
    visualFixtureChanged = false;
  }
}, 30_000);

test("deterministic form and keyboard commands execute and replay", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-command-workflow-")
  );
  const report = await runSharedScout({
    target: `${target}/command-fixture`,
    intent: "Exercise deterministic browser commands",
    permissions: [
      "browser.navigate",
      "browser.read",
      "browser.fill",
      "browser.click"
    ],
    steps: [
      { id: "select", action: "select", selector: "#choice", value: "beta" },
      { id: "selected", action: "expectValue", selector: "#choice", value: "beta" },
      { id: "check", action: "check", selector: "#enabled" },
      { id: "checked", action: "expectText", selector: "#status", text: "Checked" },
      { id: "uncheck", action: "uncheck", selector: "#enabled" },
      { id: "unchecked", action: "expectText", selector: "#status", text: "Unchecked" },
      { id: "hover", action: "hover", selector: "#hover" },
      { id: "hovered", action: "expectText", selector: "#status", text: "Hovered" },
      { id: "press", action: "press", selector: "#keys", key: "Enter" },
      { id: "pressed", action: "expectText", selector: "#status", text: "Pressed Enter" }
    ],
    expectedStatus: 200,
    exploreIntent: false,
    outputDirectory
  });

  assert.equal(report.outcome, "clear");
  assert.equal(report.observations.workflowSteps.length, 10);
  assert.ok(
    report.observations.workflowSteps.every((step) => step.status === "passed")
  );
  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
}, 30_000);

test("CLI executes a variable-backed reusable module and replays the expansion", async () => {
  const scenarioDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-cli-module-")
  );
  const moduleDirectory = join(scenarioDirectory, "modules");
  const outputDirectory = join(scenarioDirectory, "output");
  await mkdir(moduleDirectory);
  const modulePath = join(moduleDirectory, "prepare.module.json");
  const scenarioPath = join(scenarioDirectory, "checkout.scenario.json");
  await writeFile(
    modulePath,
    `${JSON.stringify(
      {
        schema: "yellowbird.module.v1",
        parameters: ["EMAIL", "EXPECTED"],
        defaults: { EXPECTED: "Order ready" },
        steps: [
          {
            id: "email",
            action: "fill",
            target: { role: "textbox", name: "Email" },
            value: "{{ vars.EMAIL }}"
          },
          {
            id: "buy",
            action: "click",
            target: { role: "button", name: "Buy" }
          },
          {
            id: "ready",
            action: "expectText",
            selector: "#status",
            text: "{{ vars.EXPECTED }}"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    scenarioPath,
    `${JSON.stringify(
      {
        schema: "yellowbird.scenario.v1",
        target: `${target}/delayed-workflow`,
        intent: "Prepare an order for {{ vars.PERSON }}",
        permissions: [
          "browser.navigate",
          "browser.read",
          "browser.fill",
          "browser.click"
        ],
        variables: {
          PERSON: "a shopper",
          EMAIL: "bird@example.test"
        },
        assertions: { expectedStatus: 200 },
        steps: [
          {
            id: "checkout",
            action: "module",
            path: "modules/prepare.module.json",
            inputs: { EMAIL: "{{ vars.EMAIL }}" }
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await runCommand(
    [
      process.execPath,
      resolve("bin/yellowbird.js"),
      "scout",
      "--scenario",
      scenarioPath,
      "--output",
      outputDirectory
    ],
    resolve(".")
  );
  assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
  const evidence = JSON.parse(
    await readFile(join(outputDirectory, "evidence.json"), "utf8")
  );
  assert.equal(evidence.intent, "Prepare an order for a shopper");
  assert.deepEqual(
    evidence.observations.workflowSteps.map(({ id, status }) => ({ id, status })),
    [
      { id: "checkout.email", status: "passed" },
      { id: "checkout.buy", status: "passed" },
      { id: "checkout.ready", status: "passed" }
    ]
  );
  const regression = await readFile(
    join(outputDirectory, "regression.spec.js"),
    "utf8"
  );
  assert.match(regression, /fill\("bird@example\.test"\)/);
  assert.doesNotMatch(regression, /\{\{\s*vars\./);

  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
});

test("an unexecutable owner action is inconclusive rather than a product pass", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-invalid-"));
  const report = await runSharedScout({
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
    report.coverageGaps.some((gap) => gap.includes("did not attempt target healing"))
  );
});

test("workflow semantic targets are validated before browser execution", () => {
  const base = {
    permissions: ["browser.navigate", "browser.read", "browser.click"]
  };
  assert.throws(
    () =>
      validateWorkflow({
        ...base,
        steps: [
          {
            id: "ambiguous",
            action: "click",
            selector: "button",
            target: { role: "button", name: "Continue" }
          }
        ]
      }),
    /exactly one of selector or target/
  );
  assert.throws(
    () =>
      validateWorkflow({
        ...base,
        steps: [
          {
            id: "unsupported-role",
            action: "click",
            target: { role: "banana", name: "Continue" }
          }
        ]
      }),
    /requires a supported role/
  );
  assert.throws(
    () =>
      validateWorkflow({
        ...base,
        steps: [
          {
            id: "unknown-option",
            action: "click",
            target: { role: "button", name: "Continue", fuzzy: true }
          }
        ]
      }),
    /unsupported property fuzzy/
  );
  assert.throws(
    () =>
      validateWorkflow({
        ...base,
        steps: [
          {
            id: "unnamed-healing",
            action: "click",
            target: { role: "button", heal: true }
          }
        ]
      }),
    /target healing requires an accessible name/
  );
});

test("semantic workflow targets heal unambiguous accessible-name drift and replay", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-workflow-healing-")
  );
  const report = await runSharedScout({
    target: `${target}/delayed-workflow`,
    intent: "Prepare an order after accessible copy changes",
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
        target: { role: "textbox", name: "Email address", heal: true },
        value: "bird@example.test"
      },
      {
        id: "prepare-order",
        action: "click",
        target: { role: "button", name: "Buy now", heal: true }
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
    report.observations.workflowSteps.slice(0, 2).map((step) => ({
      id: step.id,
      healed: step.healed,
      from: step.repair.from.name,
      to: step.repair.to.name,
      expectedResultChanged: step.repair.expectedResultChanged
    })),
    [
      {
        id: "enter-email",
        healed: true,
        from: "Email address",
        to: "Email",
        expectedResultChanged: false
      },
      {
        id: "prepare-order",
        healed: true,
        from: "Buy now",
        to: "Buy",
        expectedResultChanged: false
      }
    ]
  );
  const regression = await readFile(report.artifacts.regression, "utf8");
  assert.match(
    regression,
    /getByRole\("textbox", \{ name: "Email", exact: true \}\)\.fill/
  );
  assert.match(
    regression,
    /getByRole\("button", \{ name: "Buy", exact: true \}\)\.click/
  );
  assert.doesNotMatch(regression, /Email address|Buy now/);
  const markdown = await readFile(report.artifacts.report, "utf8");
  assert.match(
    markdown,
    /semantic-target:enter-email \(0\.667\).*textbox "Email address".*textbox "Email".*no/
  );
  assert.match(
    markdown,
    /semantic-target:prepare-order \(0\.667\).*button "Buy now".*button "Buy".*no/
  );
  const diagnostics = await readFile(report.artifacts.diagnostics, "utf8");
  assert.equal(
    diagnostics
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "workflow.target.healed").length,
    2
  );

  const install = await runCommand([process.execPath, "install"], outputDirectory);
  assert.equal(install.exitCode, 0, install.stderr);
  const replay = await runCommand(
    [process.execPath, "run", "test"],
    outputDirectory
  );
  assert.equal(replay.exitCode, 0, `${replay.stdout}\n${replay.stderr}`);
});

test("semantic workflow target healing fails closed on ambiguous drift", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-workflow-ambiguous-healing-")
  );
  const report = await runSharedScout({
    target: `${target}/ambiguous-healing`,
    permissions: ["browser.navigate", "browser.read", "browser.click"],
    steps: [
      {
        id: "buy",
        action: "click",
        target: { role: "button", name: "Buy", heal: true }
      }
    ],
    timeoutMs: 500,
    outputDirectory
  });

  assert.equal(report.outcome, "inconclusive");
  assert.equal(report.findings.length, 0);
  assert.deepEqual(
    report.observations.workflowSteps.map(({ status, reason }) => ({
      status,
      reason
    })),
    [{ status: "invalid", reason: "target-healing-unsatisfied" }]
  );
  assert.match(
    report.observations.workflowSteps[0].evidence,
    /no high-confidence unambiguous button/
  );
});
