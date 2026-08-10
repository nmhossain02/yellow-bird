import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shellQuote } from "../../src/cli/wizard.js";

const fixtureServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><html><head><title>Wizard fixture</title></head><body><h1>Wizard ready</h1></body></html>"
  );
});

await new Promise((resolveListening) =>
  fixtureServer.listen(0, "127.0.0.1", resolveListening)
);

const fixtureTarget = `http://127.0.0.1:${fixtureServer.address().port}`;
const outputDirectory = await mkdtemp(join(tmpdir(), "yellowbird-wizard-e2e-"));
const answers = [
  "2",
  fixtureTarget,
  "200",
  "Wizard ready",
  "no",
  outputDirectory,
  "yes"
];
const prompts = [
  "Choose a run type [1]:",
  "Local target URL [http://127.0.0.1:3000]:",
  "Expected HTTP status [200]:",
  "Expected page text (optional):",
  "Show the browser while the check runs [y/N]:",
  "Report path or evidence directory (optional):",
  "Run this check now? [Y/n]:"
];

let child;
let transcript = "";
let stderr = "";
try {
  child = Bun.spawn({
    cmd: [
      "script",
      "-qec",
      `${shellQuote(process.execPath)} ${shellQuote(resolve("bin/yellowbird.js"))}`,
      "/dev/null"
    ],
    cwd: resolve("."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const readOutput = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      transcript += decoder.decode(value, { stream: true });
    }
  })();

  for (let index = 0; index < answers.length; index += 1) {
    const deadline = Date.now() + 10_000;
    while (!transcript.includes(prompts[index])) {
      if (Date.now() >= deadline) {
        throw new Error(`wizard did not display ${prompts[index]}\n${transcript}`);
      }
      await Bun.sleep(20);
    }
    await Bun.sleep(75);
    child.stdin.write(`${answers[index]}\n`);
    await child.stdin.flush();
  }
  child.stdin.end();
  [stderr] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
    readOutput
  ]);
  if (child.exitCode !== 0) {
    throw new Error(`wizard exited ${child.exitCode}\n${transcript}\n${stderr}`);
  }

  const evidence = JSON.parse(
    await readFile(join(outputDirectory, "evidence.json"), "utf8")
  );
  process.stdout.write(transcript);
  process.stdout.write(
    `\nWIZARD_E2E_RESULT ${JSON.stringify({ outputDirectory, evidence })}\n`
  );
} finally {
  if (child?.exitCode === null) child.kill();
  await new Promise((resolveClosed, rejectClosed) =>
    fixtureServer.close((error) =>
      error ? rejectClosed(error) : resolveClosed()
    )
  );
  await rm(outputDirectory, { force: true, recursive: true });
}
