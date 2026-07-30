#!/usr/bin/env bun

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { startServer } from "../src/server.js";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function argumentsFor(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  }
  return values;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
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
    detail: "simulated — Kimi and generic open-weight endpoint adapters are unconfigured"
  });

  console.log("Yellow Bird doctor\n");
  for (const check of checks) {
    const icon = check.ok ? (check.warning ? "!" : "✓") : "✗";
    console.log(`${icon} ${check.name}: ${check.detail}`);
  }
  console.log(
    "\nThe local scout is executable. Dashboard orchestration and agentic testing remain simulated."
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

  const { runScout } = await import("../src/scout/scout.js");
  const report = await runScout({
    target,
    intent: argument("intent", scenario.intent),
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
    outputDirectory: argument("output"),
    headed: flag("headed"),
    ignoreConsoleErrors: flag("ignore-console-errors")
  });

  console.log(`Scout ${report.run.id}: ${report.outcome}`);
  console.log(`Findings: ${report.findings.length}`);
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
  console.log(
    `Replay: bunx playwright test --config ${report.artifacts.playwrightConfig}`
  );
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
                   [--output DIRECTORY] [--headed] [--ignore-console-errors]
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
