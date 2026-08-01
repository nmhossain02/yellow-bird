import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyAgentEngineEndpoint,
  validateAgentEngineConfig
} from "../src/scout/engine.js";

const expectedRepository = "https://github.com/nmhossain02/price-scout";
const yellowBirdDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const priceScoutDirectory = resolve(
  process.env.YELLOWBIRD_PRICE_SCOUT_DIR ||
    "test/fixtures/external/price-scout"
);
const target = "https://localhost:3000";
const healthUrl = "http://localhost:3000/";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(command, cwd) {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  return { exitCode, stdout, stderr };
}

async function checked(command, cwd, description) {
  const result = await run(command, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `${description} failed with exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout.trim();
}

function canonicalRepository(value) {
  return value
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

const engineConfig = validateAgentEngineConfig();
requireCondition(
  !process.env.YELLOWBIRD_PRICE_SCOUT_TARGET &&
    !process.env.YELLOWBIRD_PRICE_SCOUT_HEALTH_URL,
  "Price Scout endpoint overrides are not accepted because the gate must test the stack it starts"
);
requireCondition(
  classifyAgentEngineEndpoint(engineConfig.baseUrl) === "loopback",
  `The real Price Scout gate requires a loopback planning engine, received ${engineConfig.baseUrl}`
);

const origin = await checked(
  ["git", "remote", "get-url", "origin"],
  priceScoutDirectory,
  "Price Scout origin verification"
);
requireCondition(
  canonicalRepository(origin) === expectedRepository,
  `Expected the real Price Scout repository at ${priceScoutDirectory}, received ${origin}`
);
const priceScoutCommit = await checked(
  ["git", "rev-parse", "HEAD"],
  priceScoutDirectory,
  "Price Scout revision verification"
);
const priceScoutStatus = await checked(
  ["git", "status", "--porcelain"],
  priceScoutDirectory,
  "Price Scout checkout cleanliness verification"
);
requireCondition(
  priceScoutStatus === "",
  "The Price Scout checkout must be clean before the end-to-end gate starts it"
);
await checked(
  ["make", "up"],
  priceScoutDirectory,
  "Price Scout target startup from the verified checkout"
);
const startedPriceScoutCommit = await checked(
  ["git", "rev-parse", "HEAD"],
  priceScoutDirectory,
  "Started Price Scout revision verification"
);
requireCondition(
  startedPriceScoutCommit === priceScoutCommit,
  "The Price Scout checkout revision changed during target startup"
);

let healthResponse;
try {
  healthResponse = await fetch(healthUrl, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(5_000)
  });
} catch (error) {
  throw new Error(
    `Price Scout did not become reachable at ${healthUrl} after startup from ${priceScoutDirectory}. ${error.message}`
  );
}
requireCondition(
  healthResponse.status < 400,
  `Price Scout health URL returned HTTP ${healthResponse.status}`
);

const outputDirectory = await mkdtemp(
  join(tmpdir(), "yellowbird-real-price-scout-")
);
const scout = await run(
  [
    process.execPath,
    join(yellowBirdDirectory, "bin/yellowbird.js"),
    "scout",
    "--target",
    target,
    "--intent",
    "Assess initial interface and basic user flow",
    "--engine-base-url",
    engineConfig.baseUrl,
    "--agent-primary-route",
    "/monitors/new",
    "--agent-load-route",
    "/assets/*",
    "--agent-load-route",
    "/static/*",
    "--agent-load-route",
    "/api/v1/monitors",
    "--agent-load-route",
    "/api/v1/events",
    "--output",
    outputDirectory,
    "--verbose"
  ],
  priceScoutDirectory
);
requireCondition(
  scout.exitCode === 0,
  `Real Price Scout scout failed with exit ${scout.exitCode}\n${scout.stdout}\n${scout.stderr}`
);

const evidence = JSON.parse(
  await readFile(join(outputDirectory, "evidence.json"), "utf8")
);
requireCondition(evidence.schema === "yellowbird.scout-evidence.v2", "Unexpected evidence schema");
requireCondition(evidence.outcome === "clear", `Expected clear, received ${evidence.outcome}`);
requireCondition(evidence.findings.length === 0, "Real Price Scout run produced findings");
requireCondition(
  evidence.observations.exploration.status === "completed" &&
    evidence.observations.exploration.coverage === "covered",
  "Intent exploration did not complete with covered evidence"
);
requireCondition(
  evidence.observations.exploration.provenance?.endpointClass === "loopback",
  "The real Price Scout gate did not use a loopback planning engine"
);
requireCondition(
  evidence.observations.exploration.verification?.profile ===
    "initial-interface-basic-flow.v1" &&
    evidence.observations.exploration.verification?.satisfied === true,
  "The owned initial-interface basic-flow profile was not satisfied"
);
const passedMonitorVisit = evidence.observations.exploration.steps.some(
  (step) =>
    step.action === "visit" &&
    step.status === "passed" &&
    new URL(step.url).pathname === "/monitors/new"
);
requireCondition(
  passedMonitorVisit,
  "The scout did not complete the real /monitors/new flow"
);
requireCondition(
  evidence.observations.title === "Price Scout",
  `Expected the Price Scout title, received ${evidence.observations.title}`
);

await checked([process.execPath, "install"], outputDirectory, "Replay dependency installation");
await checked([process.execPath, "run", "test"], outputDirectory, "Portable replay");

process.stdout.write(
  `${JSON.stringify(
    {
      result: "passed",
      repository: expectedRepository,
      priceScoutCommit,
      target: evidence.target.url,
      outcome: evidence.outcome,
      coverageProfile: evidence.observations.exploration.verification.profile,
      visitedPath: "/monitors/new",
      artifacts: outputDirectory
    },
    null,
    2
  )}\n`
);
