import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "bun:test";
import { authorizeScoutTarget, runScout } from "../src/scout/scout.js";

let server;
let target;

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
          <button>Buy</button>
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
