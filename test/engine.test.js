import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "bun:test";
import {
  classifyAgentEngineEndpoint,
  createCompatibleEngine,
  resolveAgentEngine
} from "../src/scout/engine.js";

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

test("engine endpoint classification recognizes only exact loopback hosts", () => {
  assert.equal(
    classifyAgentEngineEndpoint("http://127.0.0.1:11434/v1"),
    "loopback"
  );
  assert.equal(
    classifyAgentEngineEndpoint("https://[::1]:11434/v1"),
    "loopback"
  );
  assert.equal(
    classifyAgentEngineEndpoint("https://localhost.example/v1"),
    "remote"
  );
});

test("Price Scout gate rejects a remote planning engine before validation", async () => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      resolve("scripts/validate-price-scout-e2e.js")
    ],
    cwd: resolve("."),
    env: {
      ...process.env,
      YELLOWBIRD_ENGINE_BASE_URL: "https://planner.example.test/v1"
    },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);

  assert.notEqual(exitCode, 0, stdout);
  assert.match(stderr, /requires a loopback planning engine/);
});

test("Price Scout gate isolates child environments and Git verification", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "yellowbird-price-scout-gate-"));
  const checkout = join(fixtureRoot, "checkout");
  const fakeBin = join(fixtureRoot, "bin");
  const capturedEnvironment = join(fixtureRoot, "docker-environment.json");
  await Promise.all([mkdir(checkout), mkdir(fakeBin)]);
  const runGit = async (...arguments_) => {
    const child = Bun.spawn({
      cmd: ["git", ...arguments_],
      cwd: checkout,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);
    assert.equal(exitCode, 0, stderr);
    return stdout.trim();
  };
  await runGit("init", "--initial-branch=main");
  await writeFile(join(checkout, "README.md"), "fixture\n", "utf8");
  await runGit("add", "README.md");
  await runGit(
    "-c",
    "user.name=YellowBird Test",
    "-c",
    "user.email=yellowbird@example.test",
    "commit",
    "-m",
    "fixture"
  );
  await runGit(
    "remote",
    "add",
    "origin",
    "https://github.com/nmhossain02/price-scout.git"
  );
  const commit = await runGit("rev-parse", "HEAD");
  const fakeDocker = join(fakeBin, "docker");
  await writeFile(
    fakeDocker,
    `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(capturedEnvironment)}, JSON.stringify(process.env));\nprocess.exit(23);\n`,
    "utf8"
  );
  await chmod(fakeDocker, 0o755);

  const child = Bun.spawn({
    cmd: [process.execPath, resolve("scripts/validate-price-scout-e2e.js")],
    cwd: resolve("."),
    env: {
      ...process.env,
      GIT_DIR: join(fixtureRoot, "spoofed-git-dir"),
      PATH: [fakeBin, process.env.PATH].join(delimiter),
      UNLISTED_GATE_SECRET: "must-not-reach-children",
      YELLOWBIRD_ENGINE_API_KEY: "planner-secret",
      YELLOWBIRD_ENGINE_BASE_URL: "http://127.0.0.1:11434/v1",
      YELLOWBIRD_PRICE_SCOUT_COMMIT: commit,
      YELLOWBIRD_PRICE_SCOUT_DIR: checkout
    },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);

  assert.notEqual(exitCode, 0, stdout);
  assert.match(stderr, /Compose configuration failed with exit 23/);
  const environment = JSON.parse(
    await readFile(capturedEnvironment, "utf8")
  );
  assert.equal(environment.UNLISTED_GATE_SECRET, undefined);
  assert.equal(environment.YELLOWBIRD_ENGINE_API_KEY, undefined);
  assert.equal(environment.GIT_DIR, undefined);
  assert.equal(environment.COMPOSE_DISABLE_ENV_FILE, "1");
  assert.ok(environment.COMPOSE_ENV_FILES);
  assert.equal(await readFile(environment.COMPOSE_ENV_FILES, "utf8"), "");
});

test("compatible engine proves JSON Schema output and normalizes provenance", async () => {
  const requests = [];
  const engine = createCompatibleEngine({
    baseUrl: "http://127.0.0.1:11434/v1/",
    apiKey: "local-test-key",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "local-planner" }] });
      }
      const body = JSON.parse(options.body);
      assert.equal(body.reasoning_effort, "none");
      assert.equal(body.response_format.type, "json_schema");
      return jsonResponse({
        model: "local-planner:resolved",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({ status: "ready", nextAction: "inspect" })
            }
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      });
    }
  });

  assert.deepEqual(await engine.probe(), {
    jsonSchema: "verified",
    toolCalls: "unverified",
    imageInput: "unverified"
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers.authorization, "Bearer local-test-key");
  assert.deepEqual(engine.provenance(), {
    adapter: "openai-compatible-chat",
    endpointClass: "loopback",
    modelRequested: "local-planner",
    modelReported: "local-planner:resolved",
    capabilityManifestVersion: "yellowbird.engine-capabilities.v1"
  });
});

test("compatible engine rejects redirects without forwarding planning data", async () => {
  let forwardedRequests = 0;
  const captureServer = createServer((_request, response) => {
    forwardedRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const captureOrigin = await listen(captureServer);
  const endpointServer = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "local-planner" }] }));
      return;
    }
    response.writeHead(307, { location: `${captureOrigin}/capture` });
    response.end();
  });
  const endpointOrigin = await listen(endpointServer);

  try {
    const engine = createCompatibleEngine({
      baseUrl: `${endpointOrigin}/v1`,
      model: "local-planner"
    });
    await assert.rejects(engine.probe(), /redirects are not allowed/);
    assert.equal(forwardedRequests, 0);
  } finally {
    await Promise.all([
      closeServer(endpointServer),
      closeServer(captureServer)
    ]);
  }
});

test("missing default local engine resolves to actionable test mechanics", async () => {
  const resolved = await resolveAgentEngine({
    fetchImpl: async () => {
      throw new Error("connection refused at http://127.0.0.1:11434/?secret=value");
    },
    timeoutMs: 50
  });

  assert.equal(resolved.engine, null);
  assert.equal(resolved.diagnostic.id, "agent-engine-unavailable");
  assert.match(resolved.diagnostic.remediation, /Start Ollama/);
  assert.doesNotMatch(JSON.stringify(resolved.diagnostic), /secret=value/);
});

test("configured engine rejects malformed structured content", async () => {
  const resolved = await resolveAgentEngine({
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "broken-model",
    fetchImpl: async (url) => {
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "broken-model" }] });
      }
      return jsonResponse({
        model: "broken-model",
        choices: [
          { finish_reason: "stop", message: { content: "not json" } }
        ]
      });
    }
  });

  assert.equal(resolved.engine, null);
  assert.equal(resolved.diagnostic.id, "agent-engine-invalid");
  assert.match(resolved.diagnostic.evidence, /malformed structured content/);
});

test("capability probe rejects JSON that violates the strict schema", async () => {
  const resolved = await resolveAgentEngine({
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "probe-model",
    fetchImpl: async (url) => {
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "probe-model" }] });
      }
      return jsonResponse({
        model: "probe-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                status: "ready",
                nextAction: "inspect",
                extra: true
              })
            }
          }
        ]
      });
    }
  });

  assert.equal(resolved.engine, null);
  assert.equal(resolved.diagnostic.id, "agent-engine-invalid");
  assert.match(resolved.diagnostic.evidence, /violated JSON Schema/);
});

test("capability probe rejects responses without reported model provenance", async () => {
  const resolved = await resolveAgentEngine({
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "probe-model",
    fetchImpl: async (url) => {
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "probe-model" }] });
      }
      return jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({ status: "ready", nextAction: "inspect" })
            }
          }
        ]
      });
    }
  });

  assert.equal(resolved.engine, null);
  assert.equal(resolved.diagnostic.id, "agent-engine-invalid");
  assert.match(resolved.diagnostic.evidence, /omitted the reported model/);
});

test("engine rejects non-printable reported model identifiers", async () => {
  const unsafeIdentifiers = [
    "\u001b]0;owned\u0007probe-model",
    "probe\u2028model",
    "probe\u2029model",
    "probe\ud800model"
  ];
  for (const unsafeIdentifier of unsafeIdentifiers) {
    const resolved = await resolveAgentEngine({
      baseUrl: "http://127.0.0.1:9999/v1",
      model: "probe-model",
      fetchImpl: async (url) => {
        if (url.endsWith("/models")) {
          return jsonResponse({ data: [{ id: "probe-model" }] });
        }
        return jsonResponse({
          model: unsafeIdentifier,
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  status: "ready",
                  nextAction: "inspect"
                })
              }
            }
          ]
        });
      }
    });

    assert.equal(resolved.engine, null);
    assert.equal(resolved.diagnostic.id, "agent-engine-invalid");
    assert.match(resolved.diagnostic.evidence, /not printable text/);
    assert.doesNotMatch(JSON.stringify(resolved), /owned|\\u001b|\\u0007/);
  }
});

test("engine validates every structured response against its JSON Schema", async () => {
  let completion = 0;
  const engine = createCompatibleEngine({
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "strict-model",
    fetchImpl: async (url) => {
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "strict-model" }] });
      }
      completion += 1;
      const output =
        completion === 1
          ? { status: "ready", nextAction: "inspect" }
          : { action: "inspect", extra: true };
      return jsonResponse({
        model: "strict-model",
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(output) }
          }
        ]
      });
    }
  });

  await engine.probe();
  await assert.rejects(
    engine.completeStructured({
      purpose: "planner",
      messages: [],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: { action: { const: "inspect" } }
      }
    }),
    /violated JSON Schema.*extra was not allowed/
  );
});

test("engine rejects reported model transitions after probing", async () => {
  let completion = 0;
  const engine = createCompatibleEngine({
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "planner-alias",
    fetchImpl: async (url) => {
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "planner-alias" }] });
      }
      completion += 1;
      return jsonResponse({
        model: completion === 1 ? "planner-a" : "planner-b",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(
                completion === 1
                  ? { status: "ready", nextAction: "inspect" }
                  : { action: "inspect" }
              )
            }
          }
        ]
      });
    }
  });

  await engine.probe();
  await assert.rejects(
    engine.completeStructured({
      purpose: "planner",
      messages: [],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: { action: { const: "inspect" } }
      }
    }),
    /changed the reported model from planner-a to planner-b/
  );
});

test("engine configuration rejects embedded URL credentials", async () => {
  await assert.rejects(
    resolveAgentEngine({
      baseUrl: "http://user:secret@127.0.0.1:11434/v1"
    }),
    /credentials must not be embedded/
  );
});

test("syntactically invalid engine configuration is fatal", async () => {
  await assert.rejects(
    resolveAgentEngine({ baseUrl: "not a URL" }),
    /URL/i
  );
  await assert.rejects(
    resolveAgentEngine({ baseUrl: "file:///tmp/engine" }),
    /must use http or https/
  );
  await assert.rejects(
    resolveAgentEngine({ baseUrl: "" }),
    /non-empty absolute URL/
  );
  await assert.rejects(
    resolveAgentEngine({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "planner\nmodel"
    }),
    /not printable text/
  );
});
