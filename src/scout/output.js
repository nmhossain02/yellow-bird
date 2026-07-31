import { stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

export async function resolveOutputOption(value) {
  if (!value) return {};

  const output = resolve(value);
  if (extname(output).toLowerCase() !== ".md") {
    return { outputDirectory: output };
  }

  try {
    const existing = await stat(output);
    if (existing.isDirectory()) {
      throw new Error(
        `--output ${value} is an existing directory created by older YellowBird behavior; rename or remove that directory, choose a new .md filename, or pass a directory path without a .md suffix`
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const stem = basename(output, extname(output));
  return {
    outputDirectory: join(dirname(output), `${stem}.assets`),
    reportPath: output
  };
}
