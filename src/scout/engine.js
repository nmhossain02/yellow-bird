import { cleanDiagnosticText, diagnosticUrl } from "./diagnostics.js";

const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_ENGINE_TIMEOUT_MS = 120_000;
const ENGINE_ADAPTERS = new Set(["auto", "builtin", "http"]);
const BUILTIN_ENGINE_ID = "yellowbird-safe-flow-v1";
const BASIC_FLOW_INTENT =
  /\buser\s+flow\b/i;
const BASIC_FLOW_VERB =
  /\b(?:assess|ensure|evaluate|inspect|review|verify)\b/i;
const PROHIBITED_INTENT =
  /(?:^|[^a-z0-9])(?:activate|approve|authenticate|buy|checkout|confirm|create|delete|log[ -]?in|order|pay|purchase|register|remove|save|sign[ -]?(?:in|up)|submit|subscribe|update|upload)(?=$|[^a-z0-9])/i;
const NON_PRINTABLE_MODEL_IDENTIFIER = /[\p{C}\p{Zl}\p{Zp}]/u;
const PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "nextAction"],
  properties: {
    status: { type: "string", enum: ["ready"] },
    nextAction: { type: "string", enum: ["inspect"] }
  }
};

export function classifyAgentEngineEndpoint(baseUrl) {
  const hostname = new URL(baseUrl).hostname;
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)
    ? "loopback"
    : "remote";
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error("engine endpoint must be a non-empty absolute URL");
  }
  const url = new URL(value);
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

function modelIdentifier(value, source) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > 200 ||
    NON_PRINTABLE_MODEL_IDENTIFIER.test(value)
  ) {
    throw new Error(`${source} model identifier was not printable text`);
  }
  return value;
}

export function validateAgentEngineConfig(config = {}) {
  const adapter =
    config.adapter !== undefined
      ? config.adapter
      : process.env.YELLOWBIRD_ENGINE_ADAPTER !== undefined
        ? process.env.YELLOWBIRD_ENGINE_ADAPTER
        : "auto";
  if (!ENGINE_ADAPTERS.has(adapter)) {
    throw new Error("engine adapter must be auto, builtin, or http");
  }
  const baseUrl =
    config.baseUrl !== undefined
      ? config.baseUrl
      : process.env.YELLOWBIRD_ENGINE_BASE_URL !== undefined
        ? process.env.YELLOWBIRD_ENGINE_BASE_URL
        : DEFAULT_LOCAL_BASE_URL;
  const model =
    config.model !== undefined
      ? config.model
      : process.env.YELLOWBIRD_ENGINE_MODEL !== undefined
        ? process.env.YELLOWBIRD_ENGINE_MODEL
        : null;
  const apiKey =
    config.apiKey !== undefined
      ? config.apiKey
      : process.env.YELLOWBIRD_ENGINE_API_KEY !== undefined
        ? process.env.YELLOWBIRD_ENGINE_API_KEY
        : null;
  const timeoutMs = config.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? fetch;
  if (
    adapter === "builtin" &&
    (config.baseUrl !== undefined ||
      process.env.YELLOWBIRD_ENGINE_BASE_URL !== undefined ||
      config.model !== undefined ||
      process.env.YELLOWBIRD_ENGINE_MODEL !== undefined ||
      config.apiKey !== undefined ||
      process.env.YELLOWBIRD_ENGINE_API_KEY !== undefined)
  ) {
    throw new Error(
      "the built-in engine adapter cannot be combined with HTTP engine configuration"
    );
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedModel =
    model === null ? null : modelIdentifier(model, "configured");
  if (
    apiKey !== null &&
    (typeof apiKey !== "string" || /[\u0000-\u001f\u007f]/.test(apiKey))
  ) {
    throw new Error("engine API key must be valid header text");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("engine timeout must be a positive number of milliseconds");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("engine fetch implementation must be a function");
  }

  return {
    adapter,
    baseUrl: normalizedBaseUrl,
    model: normalizedModel,
    apiKey,
    fetchImpl,
    timeoutMs,
    explicitlyConfigured:
      adapter !== "auto" ||
      config.baseUrl !== undefined ||
      process.env.YELLOWBIRD_ENGINE_BASE_URL !== undefined ||
      config.model !== undefined ||
      process.env.YELLOWBIRD_ENGINE_MODEL !== undefined ||
      config.apiKey !== undefined ||
      process.env.YELLOWBIRD_ENGINE_API_KEY !== undefined
  };
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
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new Error(`connection failed: ${cleanDiagnosticText(error?.message || error)}`);
  }
  if (
    response.redirected ||
    (response.url && new URL(response.url).href !== new URL(url).href) ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new Error("endpoint redirects are not allowed");
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

function schemaTypeMatches(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function schemaValueEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSchemaValue(schema, value, path = "$") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("supplied response schema was invalid");
  }
  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) {
      validateSchemaValue(candidate, value, path);
    }
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    let matches = 0;
    for (const candidate of schema[keyword]) {
      try {
        validateSchemaValue(candidate, value, path);
        matches += 1;
      } catch {}
    }
    if (
      (keyword === "anyOf" && matches === 0) ||
      (keyword === "oneOf" && matches !== 1)
    ) {
      throw new Error(`${path} did not satisfy ${keyword}`);
    }
  }
  if (schema.not) {
    let matched = true;
    try {
      validateSchemaValue(schema.not, value, path);
    } catch {
      matched = false;
    }
    if (matched) throw new Error(`${path} satisfied a forbidden schema`);
  }
  if (Object.hasOwn(schema, "const") && !schemaValueEquals(value, schema.const)) {
    throw new Error(`${path} did not match const`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => schemaValueEquals(value, candidate))
  ) {
    throw new Error(`${path} was not an allowed value`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => schemaTypeMatches(type, value))) {
      throw new Error(`${path} had an unsupported type`);
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const property of schema.required || []) {
      if (!Object.hasOwn(value, property)) {
        throw new Error(`${path}.${property} was required`);
      }
    }
    for (const [property, propertyValue] of Object.entries(value)) {
      if (Object.hasOwn(properties, property)) {
        validateSchemaValue(properties[property], propertyValue, `${path}.${property}`);
      } else if (schema.additionalProperties === false) {
        throw new Error(`${path}.${property} was not allowed`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        validateSchemaValue(
          schema.additionalProperties,
          propertyValue,
          `${path}.${property}`
        );
      }
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      throw new Error(`${path} had too few items`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      throw new Error(`${path} had too many items`);
    }
    if (schema.uniqueItems) {
      const serialized = value.map((entry) => JSON.stringify(entry));
      if (new Set(serialized).size !== serialized.length) {
        throw new Error(`${path} contained duplicate items`);
      }
    }
    if (schema.items) {
      value.forEach((entry, index) =>
        validateSchemaValue(schema.items, entry, `${path}[${index}]`)
      );
    }
  }
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      throw new Error(`${path} was too short`);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      throw new Error(`${path} was too long`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      throw new Error(`${path} did not match the required pattern`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      throw new Error(`${path} was below the minimum`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      throw new Error(`${path} exceeded the maximum`);
    }
  }
}

export function createCompatibleEngine({
  baseUrl = DEFAULT_LOCAL_BASE_URL,
  model,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_ENGINE_TIMEOUT_MS
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  let selectedModel =
    model === undefined || model === null
      ? null
      : modelIdentifier(model, "configured");
  if (
    apiKey !== undefined &&
    apiKey !== null &&
    (typeof apiKey !== "string" || /[\u0000-\u001f\u007f]/.test(apiKey))
  ) {
    throw new Error("engine API key must be valid header text");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("engine timeout must be a positive number of milliseconds");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("engine fetch implementation must be a function");
  }
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
      .filter((entry) => typeof entry === "string" && entry)
      .map((entry) => modelIdentifier(entry, "endpoint"));
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
    if (typeof payload?.model !== "string" || !payload.model) {
      throw new Error("endpoint completion omitted the reported model");
    }
    const responseModel = modelIdentifier(payload.model, "endpoint response");
    if (reportedModel && responseModel !== reportedModel) {
      throw new Error(
        `endpoint changed the reported model from ${reportedModel} to ${responseModel}`
      );
    }
    reportedModel = responseModel;
    const output = parseStructuredContent(payload);
    try {
      validateSchemaValue(schema, output);
    } catch (error) {
      throw new Error(
        `model returned structured content that violated JSON Schema: ${error.message}`
      );
    }
    return {
      output,
      usage: payload?.usage || null,
      modelReported: reportedModel
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
        endpointClass: classifyAgentEngineEndpoint(normalizedBaseUrl),
        modelRequested: selectedModel,
        modelReported: reportedModel,
        capabilityManifestVersion: "yellowbird.engine-capabilities.v1"
      };
    }
  };
}

function finishAction(coverage, summary) {
  return {
    action: "finish",
    elementRef: null,
    value: null,
    rationale: summary,
    coverage,
    summary
  };
}

function parsePlannerRequest(messages) {
  const content = messages
    ?.filter((message) => message?.role === "user")
    .at(-1)?.content;
  if (typeof content !== "string") {
    throw new Error("built-in planner received no user request");
  }
  let request;
  try {
    request = JSON.parse(content);
  } catch {
    throw new Error("built-in planner received malformed request data");
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("built-in planner request was not an object");
  }
  return request;
}

function preferredSetupVisit(elements) {
  const visits = elements.filter(
    (element) => element?.allowedAction === "visit"
  );
  const uniqueRoutes = (candidates) =>
    [
      ...new Map(
        candidates.map((element) => [element.href || element.ref, element])
      ).values()
    ];
  const preferred = uniqueRoutes(
    visits.filter((element) =>
      /\b(?:begin|new|onboard|setup|start)\b/i.test(element.label || "")
    )
  );
  if (preferred.length === 1) return preferred[0];
  const distinctVisits = uniqueRoutes(visits);
  return distinctVisits.length === 1 ? distinctVisits[0] : null;
}

export function createBuiltinIntentEngine() {
  async function completeStructured({ purpose, messages, schema }) {
    if (purpose !== "safe_interaction_exploration") {
      throw new Error(
        "the built-in planner only supports bounded safe-interaction exploration"
      );
    }
    const request = parsePlannerRequest(messages);
    const intent = String(request.intent || "");
    const elements = Array.isArray(request.page?.availableElements)
      ? request.page.availableElements
      : [];
    const stepsTaken = Number(request.policy?.stepsTaken || 0);
    let output;

    if (
      !BASIC_FLOW_INTENT.test(intent) ||
      !BASIC_FLOW_VERB.test(intent) ||
      PROHIBITED_INTENT.test(intent)
    ) {
      output = finishAction(
        "blocked",
        "The built-in planner only covers a non-mutating initial interface and basic user flow. Configure an HTTP planning engine or provide a deterministic scenario for this intent."
      );
    } else if (stepsTaken > 0) {
      const safeField = elements.find(
        (element) => element?.allowedAction === "fill"
      );
      output = safeField
        ? {
            action: "act",
            elementRef: safeField.ref,
            value: null,
            rationale:
              "YellowBird exercised the next bounded synthetic field on the safe setup destination without submitting the form.",
            coverage: "continue",
            summary: ""
          }
        : finishAction(
            "covered",
            "YellowBird observed the initial interface, one unambiguous safe setup destination, and its bounded synthetic fields."
          );
    } else {
      const visit = preferredSetupVisit(elements);
      output = visit
        ? {
            action: "act",
            elementRef: visit.ref,
            value: null,
            rationale:
              "YellowBird selected the single unambiguous safe setup navigation for the requested basic user flow.",
            coverage: "continue",
            summary: ""
          }
        : finishAction(
            "partial",
            "YellowBird could not identify exactly one safe setup navigation for the requested basic user flow."
          );
    }

    validateSchemaValue(schema, output);
    return {
      output,
      usage: null,
      modelReported: BUILTIN_ENGINE_ID
    };
  }

  return {
    async probe() {
      return {
        jsonSchema: "verified",
        toolCalls: "not-applicable",
        imageInput: "not-applicable"
      };
    },
    completeStructured,
    provenance() {
      return {
        adapter: "yellowbird-bounded-planner",
        endpointClass: "local-process",
        modelRequested: BUILTIN_ENGINE_ID,
        modelReported: BUILTIN_ENGINE_ID,
        capabilityManifestVersion: "yellowbird.engine-capabilities.v1"
      };
    }
  };
}

export async function resolveAgentEngine(config = {}) {
  const validated = validateAgentEngineConfig(config);
  const probe = async (engine) => ({
    engine,
    capabilities: await engine.probe(),
    diagnostic: null
  });

  if (
    validated.adapter === "builtin" ||
    (validated.adapter === "auto" && !validated.explicitlyConfigured)
  ) {
    return probe(createBuiltinIntentEngine());
  }

  let compatibleError;
  try {
    return await probe(createCompatibleEngine(validated));
  } catch (error) {
    compatibleError = error;
  }
  const compatibleDetail = cleanDiagnosticText(
    compatibleError?.message || compatibleError
  );
  const compatibleUnavailable = compatibleDetail.includes("connection failed");
  return {
    engine: null,
    capabilities: null,
    diagnostic: engineIssue(
      compatibleUnavailable
        ? "agent-engine-unavailable"
        : "agent-engine-invalid",
      compatibleUnavailable && validated.explicitlyConfigured
        ? "The configured agent engine is unavailable."
        : "The configured agent engine could not be used.",
      compatibleUnavailable
        ? "Start the configured engine endpoint and check its URL, credentials, and model, then rerun the scout."
        : "Check the engine endpoint, model name, credentials, and structured-output support, then rerun the scout.",
      compatibleDetail
    )
  };
}

export async function inspectAgentEngine(config = {}) {
  const resolved = await resolveAgentEngine({
    ...config,
    timeoutMs: config.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS
  });
  return resolved.engine
    ? {
        available: true,
        provenance: resolved.engine.provenance(),
        capabilities: resolved.capabilities
      }
    : { available: false, diagnostic: resolved.diagnostic };
}
