import { cleanDiagnosticText, diagnosticUrl } from "./diagnostics.js";

const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
const PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "nextAction"],
  properties: {
    status: { type: "string", enum: ["ready"] },
    nextAction: { type: "string", enum: ["inspect"] }
  }
};

function endpointClass(baseUrl) {
  const hostname = new URL(baseUrl).hostname;
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)
    ? "loopback"
    : "remote";
}

function normalizeBaseUrl(value) {
  const url = new URL(value || DEFAULT_LOCAL_BASE_URL);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("engine endpoint must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("credentials must not be embedded in the engine endpoint URL");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function engineIssue(code, message, remediation, detail = "") {
  const sanitizedDetail = cleanDiagnosticText(detail).replace(
    /https?:\/\/[^\s"'<>]+/g,
    (candidate) => diagnosticUrl(candidate).url
  );
  return {
    id: code,
    classification: "test-mechanics",
    title: message,
    evidence: sanitizedDetail.slice(0, 500),
    remediation
  };
}

async function requestJson(fetchImpl, url, options, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new Error(`connection failed: ${cleanDiagnosticText(error?.message || error)}`);
  }
  if (!response.ok) {
    throw new Error(`endpoint returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("endpoint returned invalid JSON");
  }
}

function schemaResponseFormat(name, schema) {
  return {
    type: "json_schema",
    json_schema: { name, strict: true, schema }
  };
}

function parseStructuredContent(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (choice?.finish_reason !== "stop") {
    throw new Error(
      `model did not finish normally (${choice?.finish_reason || "missing finish reason"})`
    );
  }
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("model returned no structured content");
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("model returned malformed structured content");
  }
}

export function createCompatibleEngine({
  baseUrl,
  model,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 30_000
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  let selectedModel = model || null;
  let reportedModel = null;
  const headers = {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  };

  async function listModels() {
    const payload = await requestJson(
      fetchImpl,
      `${normalizedBaseUrl}/models`,
      { headers },
      Math.min(timeoutMs, 3_000)
    );
    const models = (payload?.data || [])
      .map((entry) => entry?.id)
      .filter((entry) => typeof entry === "string" && entry);
    if (!models.length) throw new Error("endpoint reported no models");
    if (selectedModel && !models.includes(selectedModel)) {
      throw new Error(`configured model is unavailable: ${selectedModel}`);
    }
    selectedModel ||= models[0];
    return models;
  }

  async function completeStructured({ purpose, messages, schema, maxTokens = 512 }) {
    if (!selectedModel) await listModels();
    const payload = await requestJson(
      fetchImpl,
      `${normalizedBaseUrl}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: selectedModel,
          messages,
          response_format: schemaResponseFormat(
            `yellowbird_${purpose.replaceAll(/[^a-z0-9_]/gi, "_")}`,
            schema
          ),
          reasoning_effort: "none",
          temperature: 0,
          max_tokens: maxTokens,
          stream: false
        })
      },
      timeoutMs
    );
    reportedModel =
      typeof payload?.model === "string" && payload.model
        ? payload.model
        : selectedModel;
    return {
      output: parseStructuredContent(payload),
      usage: payload?.usage || null
    };
  }

  async function probe() {
    await listModels();
    const { output } = await completeStructured({
      purpose: "capability_probe",
      messages: [
        {
          role: "system",
          content:
            "Return only the requested structured result. This is a harmless capability probe."
        },
        {
          role: "user",
          content: "Set status to ready and nextAction to inspect."
        }
      ],
      schema: PROBE_SCHEMA,
      maxTokens: 128
    });
    if (output?.status !== "ready" || output?.nextAction !== "inspect") {
      throw new Error("model failed the structured-output capability probe");
    }
    return {
      jsonSchema: "verified",
      toolCalls: "unverified",
      imageInput: "unverified"
    };
  }

  return {
    probe,
    completeStructured,
    provenance() {
      return {
        adapter: "openai-compatible-chat",
        endpointClass: endpointClass(normalizedBaseUrl),
        modelRequested: selectedModel,
        modelReported: reportedModel || selectedModel,
        capabilityManifestVersion: "yellowbird.engine-capabilities.v1"
      };
    }
  };
}

export async function resolveAgentEngine(config = {}) {
  const baseUrl =
    config.baseUrl ||
    process.env.YELLOWBIRD_ENGINE_BASE_URL ||
    DEFAULT_LOCAL_BASE_URL;
  const model = config.model || process.env.YELLOWBIRD_ENGINE_MODEL || null;
  const apiKey =
    config.apiKey || process.env.YELLOWBIRD_ENGINE_API_KEY || null;
  const explicitlyConfigured = Boolean(
    config.baseUrl || process.env.YELLOWBIRD_ENGINE_BASE_URL
  );

  try {
    const engine = createCompatibleEngine({
      baseUrl,
      model,
      apiKey,
      fetchImpl: config.fetchImpl,
      timeoutMs: config.timeoutMs
    });
    const capabilities = await engine.probe();
    return { engine, capabilities, diagnostic: null };
  } catch (error) {
    const detail = cleanDiagnosticText(error?.message || error);
    const unavailable = detail.includes("connection failed");
    return {
      engine: null,
      capabilities: null,
      diagnostic: engineIssue(
        unavailable ? "agent-engine-unavailable" : "agent-engine-invalid",
        unavailable && explicitlyConfigured
          ? "The configured agent engine is unavailable."
          : unavailable
          ? "No compatible local agent engine is available."
          : "The configured agent engine could not be used.",
        unavailable && explicitlyConfigured
          ? "Start the configured engine endpoint and check its URL, credentials, and model, then rerun the scout."
          : unavailable
            ? "Start Ollama with a tool-capable model, or set YELLOWBIRD_ENGINE_BASE_URL and YELLOWBIRD_ENGINE_MODEL."
          : "Check the engine endpoint, model name, credentials, and structured-output support, then rerun the scout.",
        detail
      )
    };
  }
}

export async function inspectAgentEngine(config = {}) {
  const resolved = await resolveAgentEngine({ ...config, timeoutMs: 5_000 });
  return resolved.engine
    ? {
        available: true,
        provenance: resolved.engine.provenance(),
        capabilities: resolved.capabilities
      }
    : { available: false, diagnostic: resolved.diagnostic };
}
