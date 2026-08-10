import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "bun:test";
import {
  collectFirstRunCommand,
  DEFAULT_WIZARD_INTENT,
  formatWizardCommand,
  shellQuote
} from "../src/cli/wizard.js";

function scriptedWizard(answers) {
  const remaining = [...answers];
  const prompts = [];
  let output = "";
  return {
    prompts,
    output: () => output,
    run: () =>
      collectFirstRunCommand({
        ask: async (prompt) => {
          prompts.push(prompt);
          assert.ok(remaining.length, `no answer supplied for ${prompt}`);
          return remaining.shift();
        },
        write: (value) => {
          output += value;
        }
      })
  };
}

test("first-run wizard builds and confirms an intent command", async () => {
  const wizard = scriptedWizard([
    "",
    "http://localhost:4173",
    "",
    "yes",
    "reports/first run.md",
    ""
  ]);
  const args = await wizard.run();

  assert.deepEqual(args, [
    "scout",
    "--target",
    "http://localhost:4173",
    "--intent",
    DEFAULT_WIZARD_INTENT,
    "--headed",
    "--output",
    "reports/first run.md"
  ]);
  assert.match(wizard.output(), /Intent-guided browser flow/);
  assert.match(
    wizard.output(),
    /yellowbird scout --target http:\/\/localhost:4173 --intent 'Assess the initial interface and basic user flow' --headed --output 'reports\/first run.md'/
  );
  assert.match(wizard.output(), /Starting Yellowbird/);
});

test("wizard validates smoke-check input and can stop after preparing it", async () => {
  const wizard = scriptedWizard([
    "2",
    "https://example.com",
    "http://127.0.0.1:4321",
    "700",
    "204",
    "Ready",
    "maybe",
    "no",
    "",
    "no"
  ]);
  const args = await wizard.run();

  assert.equal(args, null);
  assert.match(wizard.output(), /supports localhost/);
  assert.match(wizard.output(), /HTTP status from 100 to 599/);
  assert.match(wizard.output(), /Answer yes or no/);
  assert.match(
    wizard.output(),
    /yellowbird scout --target http:\/\/127.0.0.1:4321 --expect-status 204 --expect-text Ready/
  );
  assert.match(wizard.output(), /Command prepared but not run/);
});

test("wizard builds a scenario command", async () => {
  const wizard = scriptedWizard([
    "3",
    "examples/checkout.scenario.json",
    "",
    "artifacts/wizard",
    "yes"
  ]);
  assert.deepEqual(await wizard.run(), [
    "scout",
    "--scenario",
    "examples/checkout.scenario.json",
    "--output",
    "artifacts/wizard"
  ]);
});

test("wizard command formatting quotes shell-sensitive values", () => {
  assert.equal(shellQuote("safe/value"), "safe/value");
  assert.equal(shellQuote("it's ready"), `'it'"'"'s ready'`);
  assert.equal(
    formatWizardCommand(["scout", "--intent", "Check user's cart"]),
    `yellowbird scout --intent 'Check user'"'"'s cart'`
  );
});

async function runWizardInPty() {
  const child = Bun.spawn({
    cmd: [process.execPath, resolve("test/fixtures/wizard-pty-e2e.js")],
    cwd: resolve("."),
    stdout: "pipe",
    stderr: "pipe"
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { exitCode, stdout, stderr };
}

test("running yellowbird in a terminal completes the wizard and scout flow", async () => {
  const result = await runWizardInPty();

  assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Yellowbird first-run wizard/);
  assert.match(result.stdout, /Scout scout_/);
  assert.match(result.stdout, /Findings: 0/);
  const resultLine = result.stdout.match(/WIZARD_E2E_RESULT (\{.*\})/);
  assert.ok(resultLine, result.stdout);
  const { evidence } = JSON.parse(resultLine[1]);
  assert.equal(evidence.outcome, "clear");
  assert.deepEqual(evidence.assertions.expectedTexts, ["Wizard ready"]);
}, 60_000);

test("no-argument non-terminal use prints help without waiting for input", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, resolve("bin/yellowbird.js")],
    cwd: resolve("."),
    stdout: "pipe",
    stderr: "pipe"
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /yellowbird\s+Start the first-run wizard/);
  assert.doesNotMatch(stdout, /Choose a run type/);
});
