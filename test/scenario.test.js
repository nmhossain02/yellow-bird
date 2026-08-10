import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { loadScenarioFile } from "../src/scout/scenario.js";

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function scenario(steps, variables = {}) {
  return {
    schema: "yellowbird.scenario.v1",
    target: "http://127.0.0.1:4321/?{{ vars.STATE }}",
    intent: "Prepare an order for {{ vars.CUSTOMER }}",
    permissions: [
      "browser.navigate",
      "browser.read",
      "browser.fill",
      "browser.click"
    ],
    variables: {
      STATE: "fixed",
      CUSTOMER: "a shopper",
      ...variables
    },
    assertions: {
      expectedStatus: 200,
      expectedTitle: "Feather {{ vars.PRODUCT }}",
      expectedTexts: ["Checkout {{ vars.READINESS }}"]
    },
    steps
  };
}

test("scenario loader expands bounded reusable modules and variables", async () => {
  const root = await mkdtemp(join(tmpdir(), "yellowbird-scenario-module-"));
  const modules = join(root, "modules");
  await mkdir(modules);
  await writeJson(join(modules, "assert.module.json"), {
    schema: "yellowbird.module.v1",
    parameters: ["EXPECTED"],
    steps: [
      {
        id: "ready",
        action: "expectText",
        target: { role: "status" },
        text: "{{ vars.EXPECTED }}"
      }
    ]
  });
  await writeJson(join(modules, "order.module.json"), {
    schema: "yellowbird.module.v1",
    parameters: ["EMAIL", "RESULT"],
    defaults: { RESULT: "Order ready" },
    steps: [
      {
        id: "email",
        action: "fill",
        target: { role: "textbox", name: "Email" },
        value: "{{ vars.EMAIL }}"
      },
      {
        id: "buy",
        action: "click",
        target: { role: "button", name: "Buy" }
      },
      {
        id: "assert",
        action: "module",
        path: "assert.module.json",
        inputs: { EXPECTED: "{{ vars.RESULT }}" }
      }
    ]
  });
  const scenarioPath = join(root, "checkout.scenario.json");
  await writeJson(
    scenarioPath,
    scenario(
      [
        {
          id: "checkout",
          action: "module",
          path: "modules/order.module.json",
          inputs: { EMAIL: "{{ vars.EMAIL }}" }
        }
      ],
      {
        PRODUCT: "Shop",
        READINESS: "ready",
        EMAIL: "bird@example.test"
      }
    )
  );

  const loaded = await loadScenarioFile(scenarioPath);
  assert.equal(loaded.target, "http://127.0.0.1:4321/?fixed");
  assert.equal(loaded.intent, "Prepare an order for a shopper");
  assert.equal(loaded.assertions.expectedTitle, "Feather Shop");
  assert.deepEqual(loaded.assertions.expectedTexts, ["Checkout ready"]);
  assert.deepEqual(
    loaded.steps.map(({ id, action, value, text }) => ({
      id,
      action,
      value,
      text
    })),
    [
      {
        id: "checkout.email",
        action: "fill",
        value: "bird@example.test",
        text: undefined
      },
      {
        id: "checkout.buy",
        action: "click",
        value: undefined,
        text: undefined
      },
      {
        id: "checkout.assert.ready",
        action: "expectText",
        value: undefined,
        text: "Order ready"
      }
    ]
  );
  assert.equal(loaded.variables, undefined);
});

test("scenario loader rejects module path escapes and recursion", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "yellowbird-scenario-policy-"));
  const root = join(fixture, "scenario");
  await mkdir(root);
  await writeJson(join(fixture, "outside.module.json"), {
    schema: "yellowbird.module.v1",
    parameters: [],
    steps: []
  });
  const escapedScenario = join(root, "escape.scenario.json");
  await writeJson(
    escapedScenario,
    scenario(
      [
        {
          id: "outside",
          action: "module",
          path: "../outside.module.json"
        }
      ],
      { PRODUCT: "Shop", READINESS: "ready" }
    )
  );
  await assert.rejects(
    loadScenarioFile(escapedScenario),
    /module path escapes the scenario directory/
  );

  await writeJson(join(root, "cycle.module.json"), {
    schema: "yellowbird.module.v1",
    parameters: [],
    steps: [
      {
        id: "again",
        action: "module",
        path: "cycle.module.json"
      }
    ]
  });
  const cycleScenario = join(root, "cycle.scenario.json");
  await writeJson(
    cycleScenario,
    scenario(
      [
        {
          id: "cycle",
          action: "module",
          path: "cycle.module.json"
        }
      ],
      { PRODUCT: "Shop", READINESS: "ready" }
    )
  );
  await assert.rejects(
    loadScenarioFile(cycleScenario),
    /recursive module cycle/
  );
});

test("scenario loader rejects unresolved variables and expanded step overflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "yellowbird-scenario-bounds-"));
  const undefinedScenario = join(root, "undefined.scenario.json");
  await writeJson(
    undefinedScenario,
    scenario(
      [
        {
          id: "missing",
          action: "expectText",
          selector: "body",
          text: "{{ vars.MISSING }}"
        }
      ],
      { PRODUCT: "Shop", READINESS: "ready" }
    )
  );
  await assert.rejects(
    loadScenarioFile(undefinedScenario),
    /references undefined variable MISSING/
  );

  await writeJson(join(root, "large.module.json"), {
    schema: "yellowbird.module.v1",
    parameters: [],
    steps: Array.from({ length: 201 }, (_, index) => ({
      id: `check-${index}`,
      action: "expectVisible",
      selector: "body"
    }))
  });
  const largeScenario = join(root, "large.scenario.json");
  await writeJson(
    largeScenario,
    scenario(
      [
        {
          id: "large",
          action: "module",
          path: "large.module.json"
        }
      ],
      { PRODUCT: "Shop", READINESS: "ready" }
    )
  );
  await assert.rejects(
    loadScenarioFile(largeScenario),
    /expanded workflow exceeds the 200-step limit/
  );
});

test("scenario loader renders versioned authorized-agent declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "yellowbird-scenario-agent-"));
  const scenarioPath = join(root, "agent.scenario.json");
  const document = scenario([], {
    PRODUCT: "Shop",
    READINESS: "ready",
    FIELD: "Fixture name",
    VALUE: "isolated fixture",
    RESULT: "Fixture committed"
  });
  document.permissions.push("browser.submit");
  document.agent = {
    schema: "yellowbird.agent.v1",
    mode: "authorized-workflow",
    fields: [
      {
        role: "textbox",
        type: "text",
        name: "{{ vars.FIELD }}",
        value: "{{ vars.VALUE }}"
      }
    ],
    mutationControls: [
      { role: "button", type: "submit", name: "Commit fixture" }
    ],
    mutationRoutes: [
      { method: "POST", url: "/api/{{ vars.STATE }}", maxRequests: 1 }
    ],
    expectedTexts: ["{{ vars.RESULT }}"]
  };
  await writeJson(scenarioPath, document);

  const loaded = await loadScenarioFile(scenarioPath);
  assert.deepEqual(loaded.agent, {
    schema: "yellowbird.agent.v1",
    mode: "authorized-workflow",
    fields: [
      {
        role: "textbox",
        type: "text",
        name: "Fixture name",
        value: "isolated fixture"
      }
    ],
    mutationControls: [
      { role: "button", type: "submit", name: "Commit fixture" }
    ],
    mutationRoutes: [
      { method: "POST", url: "/api/fixed", maxRequests: 1 }
    ],
    expectedTexts: ["Fixture committed"]
  });
});

test("scenario visual baselines cannot escape the scenario directory", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "yellowbird-visual-policy-"));
  const root = join(fixture, "scenario");
  await mkdir(root);
  await writeFile(
    join(fixture, "outside.png"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  );
  const document = scenario(
    [
      {
        id: "visual",
        action: "expectVisual",
        selector: "body",
        baseline: "../outside.png"
      }
    ],
    { PRODUCT: "Shop", READINESS: "ready" }
  );
  const scenarioPath = join(root, "visual.scenario.json");
  await writeJson(scenarioPath, document);

  await assert.rejects(
    loadScenarioFile(scenarioPath),
    /visual baseline escapes the scenario directory/
  );
});
