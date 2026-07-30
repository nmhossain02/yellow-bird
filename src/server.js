import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityCatalog } from "./domain/catalog.js";
import { GrantIssuer } from "./services/grants.js";
import { PolicyError } from "./services/policy.js";
import { SimulatedRunner } from "./services/runner.js";
import { FileStore } from "./services/store.js";

const publicDirectory = fileURLToPath(new URL("./public/", import.meta.url));
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new PolicyError("Request body is too large", 413, "body_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PolicyError("Request body must be valid JSON", 400, "invalid_json");
  }
}

function publicState(state, runner) {
  return {
    product: state.product,
    principal: state.principal,
    projects: state.projects,
    targets: state.targets,
    policies: state.policies,
    triggers: state.triggers,
    engineProfiles: state.engineProfiles,
    scenarios: state.scenarios,
    runs: state.runs.map((run) => runner.publicRun(run)),
    findings: state.findings,
    auditEvents: state.auditEvents.slice(0, 30),
    capabilities: capabilityCatalog
  };
}

async function staticFile(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(publicDirectory, requested);
  if (!filePath.startsWith(`${resolve(publicDirectory)}${sep}`)) return false;

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=300"
    });
    response.end(content);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return false;
    throw error;
  }
}

export async function createApplication(options = {}) {
  const store = options.store || new FileStore(options.dataPath);
  await store.initialize();
  const grantIssuer = options.grantIssuer || new GrantIssuer(options.signingSecret);
  const runner =
    options.runner ||
    new SimulatedRunner({
      store,
      grantIssuer,
      stageDelayMs: options.stageDelayMs
    });

  const handler = async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'self'; style-src 'self'; script-src 'self'");

    try {
      const url = new URL(request.url, "http://yellowbird.local");
      const { pathname } = url;

      if (request.method === "GET" && pathname === "/api/health") {
        return json(response, 200, {
          status: "ok",
          mode: "local-stub",
          engine: "simulated",
          time: new Date().toISOString()
        });
      }

      if (request.method === "GET" && pathname === "/api/bootstrap") {
        return json(response, 200, publicState(store.snapshot(), runner));
      }

      if (request.method === "GET" && pathname === "/api/capabilities") {
        return json(response, 200, { capabilities: capabilityCatalog });
      }

      if (request.method === "POST" && pathname === "/api/runs") {
        const run = await runner.createRun(await body(request));
        return json(response, 202, { run });
      }

      const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === "GET" && runMatch) {
        const state = store.snapshot();
        const run = state.runs.find((candidate) => candidate.id === runMatch[1]);
        if (!run) throw new PolicyError("Run not found", 404, "run_not_found");
        const findings = state.findings.filter((finding) => finding.runId === run.id);
        const scenarios = run.scenarioIds
          .map((id) => state.scenarios.find((scenario) => scenario.id === id))
          .filter(Boolean);
        return json(response, 200, { run: runner.publicRun(run), findings, scenarios });
      }

      const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        const cancelled = await runner.cancel(cancelMatch[1]);
        return json(response, 200, { cancelled });
      }

      const targetMatch = pathname.match(/^\/api\/targets\/([^/]+)\/verify$/);
      if (request.method === "POST" && targetMatch) {
        const input = await body(request);
        let verifiedTarget;
        await store.mutate((state) => {
          const target = state.targets.find((candidate) => candidate.id === targetMatch[1]);
          if (!target) throw new PolicyError("Target not found", 404, "target_not_found");
          const verifiedAt = new Date();
          const expiresAt = new Date(verifiedAt.getTime() + 90 * 24 * 60 * 60 * 1000);
          target.proof = {
            status: "verified",
            method: input.method || target.proof.method || "http-challenge",
            assurance: input.assurance || "origin",
            verifiedAt: verifiedAt.toISOString(),
            expiresAt: expiresAt.toISOString()
          };
          target.health = "ready";
          verifiedTarget = structuredClone(target);
          state.auditEvents.unshift({
            id: `evt_${randomSuffix()}`,
            type: "target.verified",
            actor: state.principal.id,
            message: `Verified ${target.name} using ${target.proof.method} (simulated).`,
            createdAt: verifiedAt.toISOString()
          });
        });
        return json(response, 200, { target: verifiedTarget, simulated: true });
      }

      const findingMatch = pathname.match(/^\/api\/findings\/([^/]+)$/);
      if (request.method === "PATCH" && findingMatch) {
        const input = await body(request);
        let updated;
        await store.mutate((state) => {
          const finding = state.findings.find((candidate) => candidate.id === findingMatch[1]);
          if (!finding) throw new PolicyError("Finding not found", 404, "finding_not_found");
          if (!["open", "acknowledged", "resolved", "dismissed"].includes(input.status)) {
            throw new PolicyError("Invalid finding status", 422, "invalid_finding_status");
          }
          finding.status = input.status;
          finding.updatedAt = new Date().toISOString();
          updated = structuredClone(finding);
        });
        return json(response, 200, { finding: updated });
      }

      if (request.method === "POST" && pathname === "/api/demo/reset") {
        await store.reset();
        return json(response, 200, { reset: true });
      }

      if (request.method === "GET" && !pathname.startsWith("/api/")) {
        if (await staticFile(pathname, response)) return;
      }

      return json(response, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      return json(response, statusCode, {
        error: {
          code: error.code || "internal_error",
          message: statusCode >= 500 ? "An unexpected error occurred" : error.message
        }
      });
    }
  };

  return { handler, store, runner, grantIssuer };
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 12);
}

export async function startServer(options = {}) {
  const application = await createApplication(options);
  const server = createServer(application.handler);
  const port = Number(options.port ?? process.env.PORT ?? 4310);
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolvePromise);
  });

  const address = server.address();
  return { ...application, server, port: address.port, host };
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const running = await startServer();
  console.log(`Yellow Bird is listening on http://${running.host}:${running.port}`);
  console.log("Local stub mode · simulated runner · development principal");
}
