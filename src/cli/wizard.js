import { createInterface } from "node:readline/promises";

export const DEFAULT_WIZARD_INTENT =
  "Assess the initial interface and basic user flow";
export const DEFAULT_WIZARD_TARGET = "http://127.0.0.1:3000";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function targetValidationError(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return "Enter an absolute URL such as http://127.0.0.1:3000.";
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    return "The target must use http or https.";
  }
  if (target.username || target.password) {
    return "Do not embed credentials in the target URL.";
  }
  if (!LOOPBACK_HOSTS.has(target.hostname)) {
    return "This Yellowbird version supports localhost, 127.0.0.1, and ::1 targets.";
  }
  return null;
}

async function promptValue({ ask, write, label, fallback, validate }) {
  while (true) {
    const suffix = fallback === undefined ? "" : ` [${fallback}]`;
    const answer = String(await ask(`${label}${suffix}: `)).trim();
    const value = answer || fallback || "";
    const issue = validate?.(value) || null;
    if (!issue) return value;
    write(`  ! ${issue}\n`);
  }
}

async function promptChoice({ ask, write }) {
  const choices = new Map([
    ["1", "intent"],
    ["intent", "intent"],
    ["2", "smoke"],
    ["smoke", "smoke"],
    ["3", "scenario"],
    ["scenario", "scenario"]
  ]);
  while (true) {
    const answer = String(await ask("Choose a run type [1]: "))
      .trim()
      .toLowerCase();
    const choice = choices.get(answer || "1");
    if (choice) return choice;
    write("  ! Choose 1, 2, or 3.\n");
  }
}

async function promptYesNo({ ask, write, label, fallback = false }) {
  const hint = fallback ? "Y/n" : "y/N";
  while (true) {
    const answer = String(await ask(`${label} [${hint}]: `))
      .trim()
      .toLowerCase();
    if (!answer) return fallback;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
    write("  ! Answer yes or no.\n");
  }
}

export function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

export function formatWizardCommand(args) {
  return ["yellowbird", ...args].map(shellQuote).join(" ");
}

export async function collectFirstRunCommand({ ask, write }) {
  if (typeof ask !== "function" || typeof write !== "function") {
    throw new TypeError("collectFirstRunCommand requires ask and write functions");
  }

  write("Yellowbird first-run wizard\n");
  write("Create a browser check now. You can use the full CLI later.\n\n");
  write("  1. Intent-guided browser flow (recommended)\n");
  write("  2. Initial-page smoke check\n");
  write("  3. Existing scenario file\n\n");

  const runType = await promptChoice({ ask, write });
  const args = ["scout"];

  if (runType === "scenario") {
    const scenario = await promptValue({
      ask,
      write,
      label: "Scenario JSON path",
      validate: (value) =>
        value ? null : "Enter the path to a Yellowbird scenario file."
    });
    args.push("--scenario", scenario);
  } else {
    const target = await promptValue({
      ask,
      write,
      label: "Local target URL",
      fallback: DEFAULT_WIZARD_TARGET,
      validate: targetValidationError
    });
    args.push("--target", target);

    if (runType === "intent") {
      const intent = await promptValue({
        ask,
        write,
        label: "What should Yellowbird verify?",
        fallback: DEFAULT_WIZARD_INTENT,
        validate: (value) =>
          value ? null : "Describe the browser flow to verify."
      });
      args.push("--intent", intent);
    } else {
      const status = await promptValue({
        ask,
        write,
        label: "Expected HTTP status",
        fallback: "200",
        validate: (value) => {
          const number = Number(value);
          return Number.isInteger(number) && number >= 100 && number <= 599
            ? null
            : "Enter an HTTP status from 100 to 599.";
        }
      });
      args.push("--expect-status", status);
      const expectedText = await promptValue({
        ask,
        write,
        label: "Expected page text (optional)"
      });
      if (expectedText) args.push("--expect-text", expectedText);
    }
  }

  if (
    await promptYesNo({
      ask,
      write,
      label: "Show the browser while the check runs"
    })
  ) {
    args.push("--headed");
  }
  const output = await promptValue({
    ask,
    write,
    label: "Report path or evidence directory (optional)"
  });
  if (output) args.push("--output", output);

  write(`\nCommand\n  ${formatWizardCommand(args)}\n\n`);
  const confirmed = await promptYesNo({
    ask,
    write,
    label: "Run this check now?",
    fallback: true
  });
  if (!confirmed) {
    write("Command prepared but not run.\n");
    return null;
  }
  write("\nStarting Yellowbird...\n\n");
  return args;
}

export async function runFirstRunWizard({
  input = process.stdin,
  output = process.stdout
} = {}) {
  const readline = createInterface({ input, output, terminal: true });
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  readline.on("SIGINT", cancel);
  if (output.isTTY) output.write("\u001b[2J\u001b[H");
  try {
    return await collectFirstRunCommand({
      ask: (prompt) => readline.question(prompt, { signal: cancellation.signal }),
      write: (value) => output.write(value)
    });
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
    output.write("\nWizard cancelled.\n");
    return null;
  } finally {
    readline.off("SIGINT", cancel);
    readline.close();
  }
}
