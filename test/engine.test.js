import assert from "node:assert/strict";
import { test } from "bun:test";
import {
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
  const resolved = await resolveAgentEngine({
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "probe-model",
    fetchImpl: async (url) => {
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "probe-model" }] });
      }
      return jsonResponse({
        model: "\u001b]0;owned\u0007probe-model",
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
  assert.match(resolved.diagnostic.evidence, /not printable text/);
  assert.doesNotMatch(JSON.stringify(resolved), /owned|\\u001b|\\u0007/);
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
  const resolved = await resolveAgentEngine({
    baseUrl: "http://user:secret@127.0.0.1:11434/v1"
  });

  assert.equal(resolved.engine, null);
  assert.equal(resolved.diagnostic.id, "agent-engine-invalid");
  assert.doesNotMatch(JSON.stringify(resolved.diagnostic), /user|secret/);
});
