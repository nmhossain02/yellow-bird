import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "bun:test";
import {
  authorizeScoutTarget,
  runScout,
  validateWorkflow
} from "../src/scout/scout.js";
import { resolveOutputOption } from "../src/scout/output.js";

let server;
let target;

async function runCommand(command, cwd) {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { exitCode, stdout, stderr };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const failing = request.url === "/failing";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>Feather Shop</title></head>
        <body>
          <h1>Feather Shop</h1>
          <p>${failing ? "Checkout unavailable" : "Checkout ready"}</p>
          <input name="email">
          <button id="checkout">Buy</button>
          <p id="status"></p>
          <script>
            document.querySelector("#checkout").addEventListener("click", () => {
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
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

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
    await readFile(resolve("schemas/scout-evidence.v1.schema.json"), "utf8")
  );
  assert.equal(evidence.schema, "yellowbird.scout-evidence.v1");
  assert.equal(schema.properties.schema.const, evidence.schema);
  for (const requiredProperty of schema.required) {
    assert.ok(requiredProperty in evidence, `missing schema property ${requiredProperty}`);
  }
  assert.equal(evidence.provenance.agenticEngine, null);
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
});

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
