import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
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
const requestedPriceScoutDirectory = resolve(
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
const inheritedChildEnvironmentNames = [
  "HOME",
  "LOGNAME",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_RUNTIME_DIR"
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const externalCommandEnvironment = Object.fromEntries(
  inheritedChildEnvironmentNames.flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]]
  )
);
const gitEnvironment = {
  ...externalCommandEnvironment,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C"
};

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

async function trustedPriceScoutCommit() {
  const authorizedCommit = process.env.YELLOWBIRD_PRICE_SCOUT_COMMIT;
  if (authorizedCommit !== undefined) {
    requireCondition(
      /^[0-9a-f]{40}$/i.test(authorizedCommit),
      "YELLOWBIRD_PRICE_SCOUT_COMMIT must be a full 40-character commit digest"
    );
    return authorizedCommit.toLowerCase();
  }
  const output = await checked(
    [
      "git",
      "-c",
      "credential.helper=",
      "ls-remote",
      `${expectedRepository}.git`,
      "HEAD"
    ],
    tmpdir(),
    "Trusted Price Scout remote revision verification",
    gitEnvironment
  );
  const [line, ...additionalLines] = output.split("\n");
  const [commit, ref, ...additionalFields] = line.trim().split(/\s+/);
  requireCondition(
    additionalLines.length === 0 &&
      additionalFields.length === 0 &&
      ref === "HEAD" &&
      /^[0-9a-f]{40}$/i.test(commit),
    "The trusted Price Scout remote did not resolve to one commit"
  );
  return commit.toLowerCase();
}

async function verifyPriceScoutCheckout(directory, stage, expectedCommit) {
  const [commit, status, worktreeRoot] = await Promise.all([
    checked(
      ["git", "rev-parse", "HEAD"],
      directory,
      `${stage} revision verification`,
      gitEnvironment
    ),
    checked(
      ["git", "status", "--porcelain", "--untracked-files=all"],
      directory,
      `${stage} cleanliness verification`,
      gitEnvironment
    ),
    checked(
      ["git", "rev-parse", "--show-toplevel"],
      directory,
      `${stage} worktree verification`,
      gitEnvironment
    )
  ]);
  requireCondition(
    (await realpath(worktreeRoot)) === directory,
    `The Price Scout path must resolve to the verified Git worktree root ${stage}`
  );
  requireCondition(
    status === "",
    `The Price Scout checkout must be clean ${stage}`
  );
  requireCondition(
    commit.toLowerCase() === expectedCommit,
    `The Price Scout checkout is not the authorized revision ${stage}`
  );
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

async function removeIsolatedComposeStack(
  priceScoutDirectory,
  environment,
  imageNames
) {
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

function composeEnvironmentMatches(service, expected) {
  const actual = service?.environment || {};
  const actualEntries = Object.entries(actual).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return (
    actualEntries.length === expectedEntries.length &&
    actualEntries.every(
      ([name, value], index) =>
        name === expectedEntries[index][0] &&
        String(value ?? "") === String(expectedEntries[index][1])
    )
  );
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
  const priceScoutDirectory = await realpath(requestedPriceScoutDirectory);
  const authorizedCommit = await trustedPriceScoutCommit();

  const origin = await checked(
    ["git", "remote", "get-url", "origin"],
    priceScoutDirectory,
    "Price Scout origin verification",
    gitEnvironment
  );
  requireCondition(
    canonicalRepository(origin) === expectedRepository,
    `Expected the real Price Scout repository at ${priceScoutDirectory}, received ${origin}`
  );
  const priceScoutCommit = await verifyPriceScoutCheckout(
    priceScoutDirectory,
    "before the end-to-end gate starts it",
    authorizedCommit
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
  const composeEnvironmentPath = join(outputDirectory, "compose.e2e.env");
  const imageNames = [
    `${composeProjectName}-control-plane:dev`,
    `${composeProjectName}-fixture:dev`,
    `${composeProjectName}-worker:dev`
  ];
  await writeFile(
    composeOverridePath,
    `services:\n  api:\n    image: ${imageNames[0]}\n    env_file: !reset []\n    ports: !override\n      - "127.0.0.1:${targetPort}:8080"\n  scheduler:\n    image: ${imageNames[0]}\n    env_file: !reset []\n  fixture:\n    image: ${imageNames[1]}\n    env_file: !reset []\n    ports: !override\n      - "127.0.0.1:${fixturePort}:4173"\n  worker:\n    image: ${imageNames[2]}\n    env_file: !reset []\n`,
    "utf8"
  );
  await writeFile(composeEnvironmentPath, "", "utf8");
  const isolatedComposeValues = {
    ALERT_WEBHOOK_SECRET: "",
    ALERT_WEBHOOK_URL: "",
    BROWSERBASE_API_KEY: "",
    BROWSERBASE_PROJECT_ID: "",
    BROWSER_PROVIDER: "LOCAL",
    DATABASE_URL:
      "postgres://scout:scout@postgres:5432/scout?sslmode=disable",
    DISCORD_WEBHOOK_URL: "",
    FIXTURE_CONTROL_TOKEN: `${composeProjectName}-fixture-token`,
    INFERENCE_MODE: "auto",
    MODEL_API_KEY: "",
    NATS_URL: "nats://nats:4222",
    SCOUT_FIXTURE_ORIGIN: "http://fixture:4173",
    SCOUT_PUBLIC_URL: healthUrl.slice(0, -1),
    STAGEHAND_MODEL: "openai/gpt-4.1-mini",
    WORKER_API_TOKEN: `${composeProjectName}-worker-token`
  };
  const composeEnvironment = { ...externalCommandEnvironment };
  Object.assign(composeEnvironment, {
    COMPOSE_FILE: [
      join(priceScoutDirectory, "compose.yaml"),
      composeOverridePath
    ].join(delimiter),
    COMPOSE_DISABLE_ENV_FILE: "1",
    COMPOSE_ENV_FILES: composeEnvironmentPath,
    COMPOSE_PROJECT_NAME: composeProjectName,
    ...isolatedComposeValues
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
  const controlPlaneEnvironment = {
    ALERT_WEBHOOK_SECRET: isolatedComposeValues.ALERT_WEBHOOK_SECRET,
    ALERT_WEBHOOK_URL: isolatedComposeValues.ALERT_WEBHOOK_URL,
    ARTIFACT_DIR: "/data/artifacts",
    DATABASE_URL: isolatedComposeValues.DATABASE_URL,
    DEFAULT_INTERVAL_MINUTES: "360",
    DISCORD_WEBHOOK_URL: isolatedComposeValues.DISCORD_WEBHOOK_URL,
    MIN_INTERVAL_MINUTES: "15",
    NATS_URL: isolatedComposeValues.NATS_URL,
    SCOUT_EXECUTION_MAX_ATTEMPTS: "3",
    SCOUT_EXECUTION_RUNNING_STALE_AFTER: "5m",
    SCOUT_FIXTURE_ORIGIN: isolatedComposeValues.SCOUT_FIXTURE_ORIGIN,
    SCOUT_HTTP_ADDR: ":8080",
    SCOUT_PUBLIC_URL: isolatedComposeValues.SCOUT_PUBLIC_URL,
    SCOUT_WEB_ROOT: "/app/web",
    WORKER_API_TOKEN: isolatedComposeValues.WORKER_API_TOKEN
  };
  requireCondition(
    composeEnvironmentMatches(
      renderedCompose.services?.postgres,
      {
        POSTGRES_DB: "scout",
        POSTGRES_PASSWORD: "scout",
        POSTGRES_USER: "scout"
      }
    ) &&
      composeEnvironmentMatches(renderedCompose.services?.nats, {}) &&
      composeEnvironmentMatches(renderedCompose.services?.api, controlPlaneEnvironment) &&
      composeEnvironmentMatches(
        renderedCompose.services?.scheduler,
        controlPlaneEnvironment
      ) &&
      composeEnvironmentMatches(renderedCompose.services?.fixture, {
        FIXTURE_CONTROL_TOKEN: isolatedComposeValues.FIXTURE_CONTROL_TOKEN,
        PORT: "4173"
      }) &&
      composeEnvironmentMatches(renderedCompose.services?.worker, {
        ALLOWED_PRIVATE_HOSTS: "fixture",
        ARTIFACT_DIR: "/data/artifacts",
        BROWSERBASE_API_KEY: isolatedComposeValues.BROWSERBASE_API_KEY,
        BROWSERBASE_PROJECT_ID: isolatedComposeValues.BROWSERBASE_PROJECT_ID,
        BROWSER_PROVIDER: isolatedComposeValues.BROWSER_PROVIDER,
        CHROME_EXECUTABLE_PATH: "/usr/bin/chromium",
        CONTROL_PLANE_TIMEOUT_MS: "15000",
        FIXTURE_ORIGIN: isolatedComposeValues.SCOUT_FIXTURE_ORIGIN,
        INFERENCE_MODE: isolatedComposeValues.INFERENCE_MODE,
        INTERNAL_API_URL: "http://api:8080",
        JOB_TIMEOUT_MS: "120000",
        MODEL_API_KEY: isolatedComposeValues.MODEL_API_KEY,
        MODEL_NAME: isolatedComposeValues.STAGEHAND_MODEL,
        NATS_URL: isolatedComposeValues.NATS_URL,
        NAVIGATION_TIMEOUT_MS: "30000",
        WORKER_TOKEN: isolatedComposeValues.WORKER_API_TOKEN
      }),
    "The Price Scout services did not render with only isolated fixture environment values"
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
    await verifyPriceScoutCheckout(
      priceScoutDirectory,
      "after target startup",
      priceScoutCommit
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

    await verifyPriceScoutCheckout(
      priceScoutDirectory,
      "immediately before the scout",
      priceScoutCommit
    );
    const scoutEnvironment = {
      ...externalCommandEnvironment,
      ...(engineConfig.apiKey === null
        ? {}
        : { YELLOWBIRD_ENGINE_API_KEY: engineConfig.apiKey })
    };
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
        ...(engineConfig.model === null
          ? []
          : ["--engine-model", engineConfig.model]),
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
      scoutEnvironment
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
        await removeIsolatedComposeStack(
          priceScoutDirectory,
          composeEnvironment,
          imageNames
        );
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
