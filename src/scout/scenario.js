import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const SCENARIO_MAX_BYTES = 1024 * 1024;
const MODULE_MAX_BYTES = 256 * 1024;
const MODULE_MAX_DEPTH = 10;
const MODULE_MAX_FILES = 50;
const WORKFLOW_MAX_STEPS = 200;
const VISUAL_BASELINE_MAX_BYTES = 2 * 1024 * 1024;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VARIABLE_TEMPLATE = /\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function parseObject(value, description) {
  requireCondition(
    value && typeof value === "object" && !Array.isArray(value),
    `${description} must be an object`
  );
  return value;
}

async function readJson(path, maximumBytes, description) {
  const file = await stat(path);
  requireCondition(file.isFile(), `${description} must be a regular file`);
  requireCondition(
    file.size <= maximumBytes,
    `${description} exceeds the ${maximumBytes}-byte limit`
  );
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${description} is not valid JSON: ${error.message}`);
  }
}

function normalizeVariables(value, description) {
  if (value === undefined) return {};
  parseObject(value, description);
  const variables = {};
  for (const [name, entry] of Object.entries(value)) {
    requireCondition(
      VARIABLE_NAME.test(name),
      `${description} contains invalid variable name ${name}`
    );
    requireCondition(
      typeof entry === "string",
      `${description}.${name} must be a string`
    );
    requireCondition(
      entry.length <= 4_000,
      `${description}.${name} exceeds the 4000-character limit`
    );
    variables[name] = entry;
  }
  return variables;
}

function renderTemplate(value, variables, description) {
  if (typeof value !== "string") return value;
  const rendered = value.replace(VARIABLE_TEMPLATE, (_match, name) => {
    requireCondition(
      Object.hasOwn(variables, name),
      `${description} references undefined variable ${name}`
    );
    return variables[name];
  });
  requireCondition(
    !rendered.includes("{{") && !rendered.includes("}}"),
    `${description} contains an unsupported variable template`
  );
  return rendered;
}

function renderStep(step, variables, description) {
  parseObject(step, description);
  const rendered = { ...step };
  for (const property of ["selector", "value", "text", "key", "baseline"]) {
    if (rendered[property] !== undefined) {
      rendered[property] = renderTemplate(
        rendered[property],
        variables,
        `${description}.${property}`
      );
    }
  }
  if (rendered.target !== undefined) {
    parseObject(rendered.target, `${description}.target`);
    rendered.target = { ...rendered.target };
    if (rendered.target.name !== undefined) {
      rendered.target.name = renderTemplate(
        rendered.target.name,
        variables,
        `${description}.target.name`
      );
    }
  }
  return rendered;
}

function renderAgent(agent, variables) {
  if (agent === undefined) return undefined;
  parseObject(agent, "scenario agent");
  return {
    ...agent,
    fields: (agent.fields || []).map((field, index) => ({
      ...field,
      name: renderTemplate(
        field.name,
        variables,
        `scenario agent field ${index + 1}.name`
      ),
      value: renderTemplate(
        field.value,
        variables,
        `scenario agent field ${index + 1}.value`
      )
    })),
    mutationControls: (agent.mutationControls || []).map((control, index) => ({
      ...control,
      name: renderTemplate(
        control.name,
        variables,
        `scenario agent mutation control ${index + 1}.name`
      )
    })),
    mutationRoutes: (agent.mutationRoutes || []).map((route, index) => ({
      ...route,
      url: renderTemplate(
        route.url,
        variables,
        `scenario agent mutation route ${index + 1}.url`
      )
    })),
    expectedTexts: (agent.expectedTexts || []).map((entry, index) =>
      renderTemplate(
        entry,
        variables,
        `scenario agent expected text ${index + 1}`
      )
    )
  };
}

function withinRoot(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function moduleParameters(module, invocation, parentVariables, description) {
  const parameters = module.parameters;
  requireCondition(
    Array.isArray(parameters) && parameters.length <= 50,
    `${description}.parameters must be an array with at most 50 entries`
  );
  const uniqueParameters = new Set();
  for (const parameter of parameters) {
    requireCondition(
      typeof parameter === "string" && VARIABLE_NAME.test(parameter),
      `${description} contains an invalid parameter`
    );
    requireCondition(
      !uniqueParameters.has(parameter),
      `${description} contains duplicate parameter ${parameter}`
    );
    uniqueParameters.add(parameter);
  }
  const defaults = normalizeVariables(
    module.defaults,
    `${description}.defaults`
  );
  const inputs = normalizeVariables(
    invocation.inputs,
    `${description} invocation inputs`
  );
  for (const name of [...Object.keys(defaults), ...Object.keys(inputs)]) {
    requireCondition(
      uniqueParameters.has(name),
      `${description} received undeclared parameter ${name}`
    );
  }
  const bindings = {};
  for (const parameter of parameters) {
    const rawValue = Object.hasOwn(inputs, parameter)
      ? inputs[parameter]
      : defaults[parameter];
    requireCondition(
      rawValue !== undefined,
      `${description} requires input ${parameter}`
    );
    bindings[parameter] = renderTemplate(
      rawValue,
      parentVariables,
      `${description} input ${parameter}`
    );
  }
  return { ...parentVariables, ...bindings };
}

export async function loadScenarioFile(value) {
  const requestedPath = resolve(value);
  const scenarioPath = await realpath(requestedPath);
  const scenarioRoot = dirname(scenarioPath);
  const scenario = parseObject(
    await readJson(scenarioPath, SCENARIO_MAX_BYTES, "scenario"),
    "scenario"
  );
  requireCondition(
    scenario.schema === "yellowbird.scenario.v1",
    "scenario must declare schema yellowbird.scenario.v1"
  );
  requireCondition(Array.isArray(scenario.steps), "scenario steps must be an array");
  const scenarioVariables = normalizeVariables(
    scenario.variables,
    "scenario variables"
  );
  const expandedSteps = [];
  const loadedModules = new Set();

  const expandSteps = async ({
    steps,
    variables,
    currentDirectory,
    idPrefix,
    stack
  }) => {
    requireCondition(
      stack.length <= MODULE_MAX_DEPTH,
      `module nesting exceeds the depth limit of ${MODULE_MAX_DEPTH}`
    );
    for (let index = 0; index < steps.length; index += 1) {
      const description = `${stack.length ? "module" : "scenario"} step ${index + 1}`;
      const step = parseObject(steps[index], description);
      requireCondition(
        typeof step.id === "string" && step.id,
        `${description} requires id`
      );
      const expandedId = idPrefix ? `${idPrefix}.${step.id}` : step.id;
      if (step.action !== "module") {
        const expandedStep = {
          ...renderStep(step, variables, description),
          id: expandedId
        };
        if (expandedStep.action === "expectVisual") {
          requireCondition(
            typeof expandedStep.baseline === "string" &&
              expandedStep.baseline &&
              !isAbsolute(expandedStep.baseline),
            `${description} visual baseline must be a non-empty relative path`
          );
          const baselinePath = await realpath(
            resolve(currentDirectory, expandedStep.baseline)
          );
          requireCondition(
            withinRoot(scenarioRoot, baselinePath),
            `${description} visual baseline escapes the scenario directory`
          );
          const baselineFile = await stat(baselinePath);
          requireCondition(
            baselineFile.isFile() &&
              baselineFile.size > 0 &&
              baselineFile.size <= VISUAL_BASELINE_MAX_BYTES,
            `${description} visual baseline must be a PNG no larger than ${VISUAL_BASELINE_MAX_BYTES} bytes`
          );
          const baselineBytes = await readFile(baselinePath);
          requireCondition(
            baselineBytes.subarray(0, 8).equals(
              Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
            ),
            `${description} visual baseline must be a PNG`
          );
          expandedStep.baselineData = baselineBytes.toString("base64");
        }
        expandedSteps.push(expandedStep);
        requireCondition(
          expandedSteps.length <= WORKFLOW_MAX_STEPS,
          `expanded workflow exceeds the ${WORKFLOW_MAX_STEPS}-step limit`
        );
        continue;
      }

      requireCondition(
        typeof step.path === "string" && step.path && !isAbsolute(step.path),
        `${description} module path must be a non-empty relative path`
      );
      const modulePath = await realpath(resolve(currentDirectory, step.path));
      requireCondition(
        withinRoot(scenarioRoot, modulePath),
        `${description} module path escapes the scenario directory`
      );
      requireCondition(
        !stack.includes(modulePath),
        `${description} creates a recursive module cycle`
      );
      loadedModules.add(modulePath);
      requireCondition(
        loadedModules.size <= MODULE_MAX_FILES,
        `scenario exceeds the ${MODULE_MAX_FILES}-module file limit`
      );
      const module = parseObject(
        await readJson(modulePath, MODULE_MAX_BYTES, `module ${step.path}`),
        `module ${step.path}`
      );
      requireCondition(
        module.schema === "yellowbird.module.v1",
        `module ${step.path} must declare schema yellowbird.module.v1`
      );
      requireCondition(
        Array.isArray(module.steps),
        `module ${step.path} steps must be an array`
      );
      await expandSteps({
        steps: module.steps,
        variables: moduleParameters(
          module,
          step,
          variables,
          `module ${step.path}`
        ),
        currentDirectory: dirname(modulePath),
        idPrefix: expandedId,
        stack: [...stack, modulePath]
      });
    }
  };

  await expandSteps({
    steps: scenario.steps,
    variables: scenarioVariables,
    currentDirectory: scenarioRoot,
    idPrefix: "",
    stack: []
  });

  const renderedScenario = {
    ...scenario,
    target: renderTemplate(scenario.target, scenarioVariables, "scenario target"),
    intent: renderTemplate(scenario.intent, scenarioVariables, "scenario intent"),
    assertions: scenario.assertions
      ? {
          ...scenario.assertions,
          expectedTitle: renderTemplate(
            scenario.assertions.expectedTitle,
            scenarioVariables,
            "scenario expected title"
          ),
          expectedTexts: (scenario.assertions.expectedTexts || []).map(
            (text, index) =>
              renderTemplate(
                text,
                scenarioVariables,
                `scenario expected text ${index + 1}`
              )
          )
        }
      : scenario.assertions,
    agent: renderAgent(scenario.agent, scenarioVariables),
    steps: expandedSteps
  };
  delete renderedScenario.variables;
  return renderedScenario;
}
