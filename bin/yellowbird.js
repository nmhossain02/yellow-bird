#!/usr/bin/env bun

import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import {
  cleanDiagnosticText,
  diagnosticUrl
} from "../src/scout/diagnostics.js";
import { resolveOutputOption } from "../src/scout/output.js";
import { startServer } from "../src/server.js";

function optionValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== `--${name}`) continue;
    const value = process.argv[index + 1];
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.startsWith("--")
    ) {
      throw new Error(`--${name} requires a non-empty value`);
    }
    values.push(value);
  }
  return values;
}

function argument(name, fallback) {
  return optionValues(name)[0] ?? fallback;
}

function argumentsFor(name) {
  return optionValues(name);
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function terminalText(value) {
  return cleanDiagnosticText(value).replaceAll(/\s+/g, " ");
}

async function doctor() {
  const checks = [];
  checks.push({
    name: "Runtime",
    ok: Boolean(process.versions.bun),
    detail: process.versions.bun
      ? `Bun ${process.versions.bun}`
      : `Node ${process.versions.node}; Bun 1.3+ is recommended`
  });

  try {
    await access(resolve("package.json"));
    checks.push({ name: "Workspace", ok: true, detail: resolve(".") });
  } catch {
    checks.push({ name: "Workspace", ok: false, detail: "package.json not found" });
  }

  try {
    const { chromium } = await import("@playwright/test");
    await access(chromium.executablePath());
    checks.push({
      name: "Browser",
      ok: true,
      detail: chromium.executablePath()
    });
  } catch {
    checks.push({
      name: "Browser",
      ok: false,
      detail: "Chromium is missing; run `bun run setup:browsers`"
    });
  }

  checks.push({
    name: "Local scout isolation",
    ok: true,
    warning: true,
    detail: "browser requests are restricted to the target's exact loopback origin"
  });
  checks.push({
    name: "Dashboard authentication",
    ok: true,
    warning: true,
    detail: "fixed local development principal"
  });
  checks.push({
    name: "Model provider",
    ok: true,
    warning: true,
    detail: "checking local compatible endpoint"
  });
  const { inspectAgentEngine } = await import("../src/scout/engine.js");
  const engine = await inspectAgentEngine();
  checks[checks.length - 1].detail = engine.available
    ? `${engine.provenance.modelReported} via ${engine.provenance.adapter}; JSON Schema verified`
    : `${engine.diagnostic.title} Deterministic scenarios remain available.`;

  console.log("Yellow Bird doctor\n");
  for (const check of checks) {
    const icon = check.ok ? (check.warning ? "!" : "✓") : "✗";
    console.log(`${icon} ${check.name}: ${check.detail}`);
  }
  console.log(
    "\nThe local scout and bounded intent exploration are executable. Dashboard orchestration remains simulated."
  );
  process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
}

async function serve() {
  const port = Number(argument("port", "4310"));
  const running = await startServer({ port });
  console.log(`Yellow Bird is listening on http://${running.host}:${running.port}`);
  console.log("Press Ctrl+C to stop.");
}

async function run() {
  const serverUrl = argument("server", "http://127.0.0.1:4310");
  const projectId = argument("project", "prj_feather");
  const targetId = argument("target", "tgt_local");
  const profile = argument("profile", "balanced");

  const response = await fetch(`${serverUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId,
      targetId,
      profile,
      trigger: "manual",
      networkProfile: profile === "deterministic" ? "target-only" : "target-and-declared-tools"
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `Server returned ${response.status}`);

  console.log(`Authorized ${payload.run.id}`);
  console.log(`Grant: ${payload.run.grant.tokenPreview}`);
  console.log(`Open ${serverUrl}/#runs/${payload.run.id}`);
}

async function scout() {
  const scenarioPath = argument("scenario");
  let scenario = {};
  if (scenarioPath) {
    scenario = JSON.parse(await readFile(resolve(scenarioPath), "utf8"));
    if (scenario.schema !== "yellowbird.scenario.v1") {
      throw new Error(
        "scenario must declare schema yellowbird.scenario.v1"
      );
    }
  }

  const target = argument("target", scenario.target);
  if (!target) {
    throw new Error("scout requires --target URL or a scenario target");
  }

  const output = await resolveOutputOption(argument("output"));
  const verbose = flag("verbose");
  const explicitIntent = argument("intent");
  const intent = explicitIntent ?? scenario.intent;
  const { runScout } = await import("../src/scout/scout.js");
  const report = await runScout({
    target,
    intent,
    expectedStatus: argument(
      "expect-status",
      String(scenario.assertions?.expectedStatus ?? 200)
    ),
    expectedTitle: argument(
      "expect-title",
      scenario.assertions?.expectedTitle
    ),
    expectedTexts: [
      ...(scenario.assertions?.expectedTexts || []),
      ...argumentsFor("expect-text")
    ],
    permissions: scenario.permissions,
    steps: scenario.steps,
    exploreIntent:
      !scenarioPath &&
      (explicitIntent !== undefined || (flag("agent") && !flag("no-agent"))),
    maxAgentSteps: argument("max-agent-steps", "4"),
    engineBaseUrl: argument("engine-base-url"),
    engineModel: argument("engine-model"),
    agentPrimaryRoutes: argumentsFor("agent-primary-route"),
    agentNavigationRoutes: argumentsFor("agent-navigation-route"),
    agentLoadRoutes: argumentsFor("agent-load-route"),
    agentExpectedTexts: argumentsFor("agent-expect-text"),
    agentExpectedControls: argumentsFor("agent-expect-control"),
    ...output,
    headed: flag("headed"),
    ignoreConsoleErrors: flag("ignore-console-errors"),
    onDiagnostic: verbose
      ? (event) => {
          console.error(
            `[${event.timestamp}] ${event.level.toUpperCase()} ${event.event}: ${event.message}`
          );
        }
      : undefined
  });

  console.log(`Scout ${report.run.id}: ${report.outcome}`);
  for (const repair of report.target.repairs) {
    console.log(
      `Target repaired: ${diagnosticUrl(repair.from).url} -> ${diagnosticUrl(repair.to).url}`
    );
  }
  console.log(`Findings: ${report.findings.length}`);
  console.log(
    report.observations.exploration.requested
      ? `Scope: ${report.observations.exploration.steps.length} bounded agent interaction step(s); coverage=${report.observations.exploration.coverage}`
      : report.observations.workflowSteps.length
      ? `Scope: ${report.observations.workflowSteps.length} declared workflow step(s); no autonomous exploration`
      : `Scope: initial page load only; ${report.observations.interactiveElements.length} interactive element(s) not exercised`
  );
  if (report.observations.exploration.requested) {
    console.log(`Agent: ${report.observations.exploration.status}`);
    if (report.observations.exploration.verification?.satisfied) {
      console.log(
        `Coverage verified: ${report.observations.exploration.verification.profile}`
      );
    }
    console.log(
      `Engine: ${report.observations.exploration.engine || "unavailable"}`
    );
    if (report.observations.exploration.summary) {
      console.log(
        `Agent summary (coverage only): ${terminalText(report.observations.exploration.summary)}`
      );
    }
  }
  if (report.invalidTestMechanics.length) {
    console.log(`Test-mechanics issues: ${report.invalidTestMechanics.length}`);
    for (const issue of report.invalidTestMechanics) {
      console.log(`- [${issue.id}] ${issue.title}`);
      console.log(`  Fix: ${issue.remediation}`);
    }
  }
  if (report.observations.workflowSteps.length) {
    console.log(
      `Workflow: ${report.observations.workflowSteps.map((step) => `${step.id}=${step.status}`).join(", ")}`
    );
  }
  for (const finding of report.findings) {
    console.log(`- [${finding.severity}] ${finding.title}`);
  }
  console.log(`Evidence: ${report.artifacts.evidence}`);
  console.log(`Report: ${report.artifacts.report}`);
  console.log(`Regression: ${report.artifacts.regression}`);
  console.log(`Diagnostics: ${report.artifacts.diagnostics}`);
  const replayDirectory = JSON.stringify(dirname(report.artifacts.replayPackage));
  console.log(`Replay setup: bun install --cwd ${replayDirectory}`);
  console.log(
    `Browser setup: bun run --cwd ${replayDirectory} setup:browsers`
  );
  console.log(`Replay: bun run --cwd ${replayDirectory} test`);
  if (report.outcome === "attention") process.exitCode = 2;
  else if (report.outcome === "inconclusive") process.exitCode = 3;
}

function help() {
  console.log(`YellowBird

Usage:
  yellowbird serve [--port 4310]
  yellowbird doctor
  yellowbird run [--server URL] [--project ID] [--target ID] [--profile balanced|deterministic|exploratory]
  yellowbird scout [--scenario FILE] [--target URL] [--intent TEXT] [--expect-status 200]
                   [--expect-title TEXT] [--expect-text TEXT ...]
                   [--output DIRECTORY|REPORT.md] [--verbose]
                   [--agent|--no-agent] [--max-agent-steps 4]
                   [--engine-base-url URL] [--engine-model ID]
                   [--agent-primary-route URL ...]
                   [--agent-navigation-route URL ...]
                   [--agent-load-route URL|URL* ...]
                   [--agent-expect-text TEXT ...]
                   [--agent-expect-control ROLE:TYPE:NAME ...]
                   [--headed] [--ignore-console-errors]
`);
}

const command = process.argv[2] || "help";

try {
  if (command === "serve") await serve();
  else if (command === "doctor") await doctor();
  else if (command === "run") await run();
  else if (command === "scout") await scout();
  else help();
} catch (error) {
  console.error(`yellowbird: ${error.message}`);
  process.exitCode = 1;
}
