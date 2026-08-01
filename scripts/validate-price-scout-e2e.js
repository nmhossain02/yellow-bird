import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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
const priceScoutExpectedDestinationTexts = [
  "Track any public product page"
];
const priceScoutExpectedDestinationControls = [
  { role: "textbox", type: "url", name: "Product URL" },
  { role: "textbox", type: "textarea", name: "Tracking instruction" },
  { role: "combobox", type: "select-one", name: "Frequency" },
  { role: "button", type: "submit", name: "Compile monitor" }
];
const composeControlledEnvironmentNames = [
  "ALERT_WEBHOOK_SECRET",
  "ALERT_WEBHOOK_URL",
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  "BROWSER_PROVIDER",
  "DATABASE_URL",
  "DISCORD_WEBHOOK_URL",
  "FIXTURE_CONTROL_TOKEN",
  "INFERENCE_MODE",
  "MODEL_API_KEY",
  "NATS_URL",
  "SCOUT_FIXTURE_ORIGIN",
  "SCOUT_PUBLIC_URL",
  "STAGEHAND_MODEL",
  "WORKER_API_TOKEN"
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const externalCommandEnvironment = { ...process.env };
delete externalCommandEnvironment.YELLOWBIRD_ENGINE_API_KEY;

async function run(command, cwd, env) {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env,
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

async function checked(command, cwd, description, env) {
  const result = await run(command, cwd, env);
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

async function verifyPriceScoutCheckout(stage, expectedCommit) {
  const [commit, status] = await Promise.all([
    checked(
      ["git", "rev-parse", "HEAD"],
      priceScoutDirectory,
      `${stage} revision verification`,
      externalCommandEnvironment
    ),
    checked(
      ["git", "status", "--porcelain"],
      priceScoutDirectory,
      `${stage} cleanliness verification`,
      externalCommandEnvironment
    )
  ]);
  requireCondition(
    status === "",
    `The Price Scout checkout must be clean ${stage}`
  );
  if (expectedCommit) {
    requireCondition(
      commit === expectedCommit,
      `The Price Scout checkout revision changed ${stage}`
    );
  }
  return commit;
}

async function availableLoopbackPort(excluded = new Set()) {
  while (true) {
    const port = await new Promise((resolvePort, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close((error) => {
          if (error) reject(error);
          else resolvePort(address.port);
        });
      });
    });
    if (!excluded.has(port)) return port;
  }
}

function hasPublishedPort(service, targetPort, publishedPort) {
  return service?.ports?.some(
    (port) =>
      Number(port.target) === targetPort &&
      Number(port.published) === publishedPort &&
      port.host_ip === "127.0.0.1"
  );
}

async function removeIsolatedComposeStack(environment, imageNames) {
  const failures = [];
  const down = await run(
    ["docker", "compose", "down", "--volumes", "--remove-orphans"],
    priceScoutDirectory,
    environment
  );
  if (down.exitCode !== 0) {
    failures.push(`Compose teardown failed\n${down.stdout}\n${down.stderr}`);
  }
  for (const imageName of new Set(imageNames)) {
    const remove = await run(
      ["docker", "image", "rm", imageName],
      priceScoutDirectory,
      externalCommandEnvironment
    );
    if (remove.exitCode !== 0 && !remove.stderr.includes("No such image")) {
      failures.push(
        `Image cleanup failed for ${imageName}\n${remove.stdout}\n${remove.stderr}`
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

async function main() {
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
    "Price Scout origin verification",
    externalCommandEnvironment
  );
  requireCondition(
    canonicalRepository(origin) === expectedRepository,
    `Expected the real Price Scout repository at ${priceScoutDirectory}, received ${origin}`
  );
  const priceScoutCommit = await verifyPriceScoutCheckout(
    "before the end-to-end gate starts it"
  );

  const outputDirectory = await mkdtemp(
    join(tmpdir(), "yellowbird-real-price-scout-")
  );
  const targetPort = await availableLoopbackPort();
  const fixturePort = await availableLoopbackPort(new Set([targetPort]));
  const target = `https://localhost:${targetPort}`;
  const healthUrl = `http://localhost:${targetPort}/`;
  const composeProjectName = `yellowbird-price-scout-e2e-${process.pid}`;
  const composeOverridePath = join(outputDirectory, "compose.e2e.yaml");
  const imageNames = [
    `${composeProjectName}-control-plane:dev`,
    `${composeProjectName}-fixture:dev`,
    `${composeProjectName}-worker:dev`
  ];
  await writeFile(
    composeOverridePath,
    `services:\n  api:\n    image: ${imageNames[0]}\n    ports: !override\n      - "127.0.0.1:${targetPort}:8080"\n  scheduler:\n    image: ${imageNames[0]}\n  fixture:\n    image: ${imageNames[1]}\n    ports: !override\n      - "127.0.0.1:${fixturePort}:4173"\n  worker:\n    image: ${imageNames[2]}\n`,
    "utf8"
  );
  const composeEnvironment = { ...externalCommandEnvironment };
  for (const name of composeControlledEnvironmentNames) {
    delete composeEnvironment[name];
  }
  Object.assign(composeEnvironment, {
    COMPOSE_FILE: [
      join(priceScoutDirectory, "compose.yaml"),
      composeOverridePath
    ].join(delimiter),
    COMPOSE_PROJECT_NAME: composeProjectName,
    SCOUT_PUBLIC_URL: healthUrl.slice(0, -1)
  });

  const renderedCompose = JSON.parse(
    await checked(
      ["docker", "compose", "config", "--format", "json"],
      priceScoutDirectory,
      "Isolated Price Scout Compose configuration",
      composeEnvironment
    )
  );
  requireCondition(
    renderedCompose.name === composeProjectName &&
      hasPublishedPort(renderedCompose.services?.api, 8080, targetPort) &&
      hasPublishedPort(renderedCompose.services?.fixture, 4173, fixturePort) &&
      renderedCompose.services?.api?.image === imageNames[0] &&
      renderedCompose.services?.scheduler?.image === imageNames[0] &&
      renderedCompose.services?.fixture?.image === imageNames[1] &&
      renderedCompose.services?.worker?.image === imageNames[2],
    "The Price Scout target did not render as an isolated Compose project"
  );

  let startupAttempted = false;
  let primaryFailure;
  let result;
  try {
    startupAttempted = true;
    await checked(
      ["make", "up"],
      priceScoutDirectory,
      "Price Scout target startup from the verified checkout",
      composeEnvironment
    );
    await verifyPriceScoutCheckout("after target startup", priceScoutCommit);

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

    await verifyPriceScoutCheckout(
      "immediately before the scout",
      priceScoutCommit
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
        ...priceScoutExpectedDestinationTexts.flatMap((text) => [
          "--agent-expect-text",
          text
        ]),
        ...priceScoutExpectedDestinationControls.flatMap((control) => [
          "--agent-expect-control",
          `${control.role}:${control.type}:${control.name}`
        ]),
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
      priceScoutDirectory,
      process.env
    );
    requireCondition(
      scout.exitCode === 0,
      `Real Price Scout scout failed with exit ${scout.exitCode}\n${scout.stdout}\n${scout.stderr}`
    );

    const evidence = JSON.parse(
      await readFile(join(outputDirectory, "evidence.json"), "utf8")
    );
    requireCondition(
      evidence.schema === "yellowbird.scout-evidence.v2",
      "Unexpected evidence schema"
    );
    requireCondition(
      evidence.outcome === "clear",
      `Expected clear, received ${evidence.outcome}`
    );
    requireCondition(
      evidence.findings.length === 0,
      "Real Price Scout run produced findings"
    );
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
    const routePolicy = evidence.observations.exploration.routePolicy;
    requireCondition(
      routePolicy?.primaryRoutes.some(
        (route) => new URL(route).pathname === "/monitors/new"
      ) &&
        routePolicy.loadRoutes.some(
          (route) => new URL(route).pathname === "/api/v1/monitors"
        ) &&
        routePolicy.loadRoutes.some(
          (route) => new URL(route).pathname === "/api/v1/events"
        ),
      "The evidence did not preserve the declared Price Scout route authority"
    );
    const passedMonitorVisit = evidence.observations.exploration.steps.find(
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
      passedMonitorVisit.destinationAssertions?.length ===
        priceScoutExpectedDestinationTexts.length &&
        priceScoutExpectedDestinationTexts.every((text) =>
          passedMonitorVisit.destinationAssertions.some(
            (assertion) => assertion.text === text && assertion.satisfied
          )
        ),
      "The /monitors/new flow did not expose the declared Price Scout heading text"
    );
    requireCondition(
      passedMonitorVisit.destinationControlAssertions?.length ===
        priceScoutExpectedDestinationControls.length &&
        priceScoutExpectedDestinationControls.every((expected) =>
          passedMonitorVisit.destinationControlAssertions.some(
            (assertion) =>
              assertion.role === expected.role &&
              assertion.type === expected.type &&
              assertion.name === expected.name &&
              assertion.matchCount === 1 &&
              assertion.satisfied
          )
        ),
      "The /monitors/new flow did not expose the declared semantic Price Scout form controls"
    );
    requireCondition(
      evidence.observations.title === "Price Scout",
      `Expected the Price Scout title, received ${evidence.observations.title}`
    );

    await checked(
      [process.execPath, "install"],
      outputDirectory,
      "Replay dependency installation",
      externalCommandEnvironment
    );
    await checked(
      [process.execPath, "run", "test"],
      outputDirectory,
      "Portable replay",
      externalCommandEnvironment
    );

    result = {
      result: "passed",
      repository: expectedRepository,
      priceScoutCommit,
      target: evidence.target.url,
      outcome: evidence.outcome,
      coverageProfile: evidence.observations.exploration.verification.profile,
      visitedPath: "/monitors/new",
      destinationAssertions: priceScoutExpectedDestinationTexts,
      destinationControls: priceScoutExpectedDestinationControls,
      composeProject: composeProjectName,
      artifacts: outputDirectory
    };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (startupAttempted) {
      try {
        await removeIsolatedComposeStack(composeEnvironment, imageNames);
      } catch (cleanupError) {
        if (!primaryFailure) throw cleanupError;
        process.stderr.write(
          `Price Scout cleanup also failed: ${cleanupError.message}\n`
        );
      }
    }
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main();
