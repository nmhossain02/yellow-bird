# YellowBird

YellowBird is an open-source, deploy-anywhere canary testing project. Its goal is
to discover product failures before customers do, preserve the product owner's
expected results, and return evidence that can be reproduced without YellowBird.

The executable product is a local browser scout. It checks a loopback web target,
can explore a bounded non-submitting flow from natural-language intent, captures
runtime evidence, and generates a portable Playwright regression. The dashboard
still demonstrates the larger orchestration model while that model is implemented
incrementally.

## Try the real scout

YellowBird uses [Bun](https://bun.sh/) 1.3 or newer.

```bash
bun install
bun run setup:browsers
```

Natural-language exploration uses an OpenAI-compatible chat endpoint. By default,
YellowBird probes Ollama at `http://127.0.0.1:11434/v1` and selects its first
available model. For the currently tested local setup, install Ollama, make sure
its service is running, and pull the model:

```bash
ollama pull qwen3.5:9b
bun run doctor
```

`doctor` reports the selected model and whether strict JSON Schema output passed
the harmless conformance probe. A scout with explicit `--intent` is
`inconclusive` with exit code `3` if no compatible engine is available. It never
falls back to an initial-page `clear` result that did not cover the intent.

Start the deliberately broken demo product:

```bash
bun run demo:target
```

In another terminal, tell YellowBird what the owner expects:

```bash
bun run scout -- \
  --target http://127.0.0.1:4321 \
  --intent "A shopper can reach checkout" \
  --expect-title "Feather Shop" \
  --expect-text "Checkout ready"
```

The scout exits `2` when it finds asserted failures and `3` when test mechanics
make the result inconclusive. It writes an evidence bundle under
`.yellowbird/scout/<run-id>/`:

- `report.md` - human-readable findings, reproduction steps, and coverage gaps
- `evidence.json` - versioned machine-readable observations and provenance
- `page.png` - full-page visual evidence when a browser page was available
- `regression.spec.js` - deterministic Playwright assertions suitable for review
- `playwright.config.js` - makes the regression immediately replayable from the
  hidden evidence directory
- `package.json` - pins the Playwright dependency needed to replay from any
  product repository
- `diagnostics.jsonl` - ordered, run-correlated operational events conforming to
  [`schemas/diagnostic-event.v1.schema.json`](./schemas/diagnostic-event.v1.schema.json),
  with URL query values and console contents omitted

The current machine-readable format is published as
[`schemas/scout-evidence.v2.schema.json`](./schemas/scout-evidence.v2.schema.json).
The original
[`schemas/scout-evidence.v1.schema.json`](./schemas/scout-evidence.v1.schema.json)
remains available unchanged for historical evidence, so integrations can migrate
between explicit contract versions without depending on YellowBird internals.

The demo has a fixed state at `http://127.0.0.1:4321/?fixed`, so the same command
with that target should complete with `clear`.

To run a real multi-step canary, use the versioned example scenario:

```bash
bun run scout -- --scenario examples/checkout.scenario.json
```

That workflow declares `browser.fill` and `browser.click` before the run, enters
an email, prepares an order, and asserts that the product reaches `Order ready`.
Its actions and assertions are also written into the generated regression.
The public format is
[`schemas/scenario.v1.schema.json`](./schemas/scenario.v1.schema.json).

## Use YellowBird from another repository

Install the local checkout once:

```bash
bun install --global /path/to/yellow-bird
```

Then run it from the product repository. `--output report.md` writes that exact
Markdown file and places the remaining evidence in `report.assets/`:

```bash
cd /path/to/product
yellowbird scout \
  --target http://127.0.0.1:3000 \
  --intent "Assess the initial interface and basic user flow" \
  --output yellowbird-report.md \
  --verbose
```

An explicit `--intent` enables bounded agent exploration. Use `--no-agent` for
an initial-page smoke check, or a versioned `--scenario` when the owner needs an
exact workflow with mutation-capable actions and explicit assertions.

The compatible endpoint can be selected per command:

```bash
yellowbird scout \
  --target http://127.0.0.1:3000 \
  --intent "Assess the basic setup flow" \
  --engine-base-url http://127.0.0.1:11434/v1 \
  --engine-model qwen3.5:9b
```

The equivalent environment variables are `YELLOWBIRD_ENGINE_BASE_URL`,
`YELLOWBIRD_ENGINE_MODEL`, and `YELLOWBIRD_ENGINE_API_KEY`. The API key is sent
only as a bearer token and is never written to the evidence bundle.

An existing directory whose name ends in `.md` is diagnosed as legacy output;
rename or remove it, choose a new Markdown filename, or pass a directory path
without a `.md` suffix. Verbose mode renders a live view of the same structured
lifecycle events retained in `diagnostics.jsonl`. Exit `0` means no failure was
observed within the tested scope; consult the coverage gaps before treating that
as broader product health.

## Scout safety boundary

The alpha accepts only `localhost`, `127.0.0.1`, and `::1`. Browser requests are
restricted to the target's exact origin; cross-origin requests are blocked and
reported as coverage gaps. Local control is the authorization proof for this
mode.

For loopback targets only, YellowBird makes a bounded, best-effort repair if an
HTTPS transport probe fails and the same host, effective port (including 443
when HTTPS omits it), path, and query responds over HTTP. It records both URLs
and the unchanged expected result. It does not silently ignore certificate
errors or repair remote targets.

This is a useful development boundary, not production target authorization.
Remote staging and production targets will require explicit challenge proofs,
scoped run grants, sandboxing, and policy approval before they are enabled.

An explicit natural-language intent may visit supplied exact-origin links, fill
eligible fields with YellowBird-owned synthetic values, select supplied options,
and use non-submit buttons whose labels do not indicate a destructive or
mutation-oriented action. Form submission, authentication, credentials,
cross-origin navigation, and destructive controls are not exposed to the model.
The model proposes one supplied element at a time; YellowBird validates and
executes the action. Model text is coverage guidance, never product-failure
evidence. If the intent needs an action outside this profile, the result is
`inconclusive` instead of a false pass.

Page text and the bounded control inventory are sent to the configured model
endpoint. The default endpoint is loopback. Operators choosing a remote endpoint
are responsible for that data boundary. Query values and console contents remain
out of operational diagnostics.

Owner-declared scenarios retain their explicit permission model for exact
`fill`, `click`, `expectText`, and `expectVisible` steps. A failed action is
reported as `inconclusive`, not as a product pass or product bug, because selector
healing has not been implemented. That distinction is part of the evidence
contract.

Navigation and transport failures are also `inconclusive` test mechanics rather
than product findings. The report provides a diagnostic code, remediation, and
structured event log instead of duplicating the failed navigation as a product
request failure.

Browser launch failures follow the same contract. YellowBird distinguishes a
missing Chromium executable, missing host dependencies, and other launch
failures, then writes the report, evidence, diagnostics, generated regression,
Playwright configuration, and replay package. Navigation and declared workflow
steps are marked skipped with reason `browser-unavailable`, and the report says
the product was not evaluated. Since no page existed, `artifacts.screenshot` is
`null` and no screenshot file is claimed. Applications embedding the scout can
inject a browser launcher with `createScoutRunner({ launchBrowser })`;
`runScout(input)` uses the real Playwright Chromium launcher.

## Run the dashboard

```bash
bun start
```

Open [http://localhost:4310](http://localhost:4310). For auto-reload:

```bash
bun run dev
```

The local state file is created at `.yellowbird/state.json`. Set
`YELLOWBIRD_DATA_PATH` to use a different location.

[`yellowbird.example.json`](./yellowbird.example.json) sketches the
version-controlled configuration split: test intent, symbolic target and engine
bindings, requested capabilities, and trigger desired state. Proof records,
credentials, approvals, and operational bindings stay outside the product repo.

## CLI

```bash
bun run doctor
bun bin/yellowbird.js serve --port 4310
bun bin/yellowbird.js run --project prj_feather --target tgt_local --profile balanced
bun bin/yellowbird.js scout --target http://127.0.0.1:4321 --expect-text "Checkout ready"
bun bin/yellowbird.js scout --scenario examples/checkout.scenario.json
```

`run` talks to an already-running dashboard server. `scout` performs the real
local browser check.

## What is real

- Loopback-only target authorization and exact-origin browser network policy
- Initial-page navigation with status, title, text, console, exception, failed
  request, screenshot, and interactive-element evidence
- Intent-driven bounded exploration through a probed OpenAI-compatible local or
  hosted endpoint
- YellowBird-enforced same-origin action policy, synthetic form values, truthful
  coverage accounting, engine provenance, and model-free replay
- Permission-declared `fill`, `click`, `expectText`, and `expectVisible` workflow
  steps with `inconclusive` handling for invalid test mechanics
- Loopback transport diagnosis and evidence-backed HTTPS-to-HTTP scheme repair
- Ordered JSONL diagnostics correlated by run ID, with a live `--verbose` view
- Owner-authored assertions that YellowBird does not rewrite
- Machine-readable evidence, a human report, and a generated Playwright regression
- Persistent dashboard projects, targets, scenarios, runs, findings, and audit events
- Policy evaluation with capability narrowing
- Short-lived signed run grants with ephemeral runner-key binding
- Best-effort skipped and untested reporting
- Finding confidence, severity, evidence, and reproduction procedures

## What remains simulated

- Dashboard runs advance through realistic lifecycle stages but do not execute
  customer code.
- Dashboard findings and evidence are deterministic demo fixtures.
- Remote target verification records proof state without making a network challenge.
- A generic OpenAI-compatible model endpoint is real. A native hosted Kimi
  adapter, email, source provider, secret store, issue tracker, and production
  sandbox integrations remain adapter boundaries.
- Dashboard authentication uses a fixed development principal.

These seams are visible in API output and the UI so the product does not imply
security or coverage it has not earned.

## Engine direction

YellowBird is Kimi-first and open-model-first, but its test domain is not coupled
to one model. The local scout now owns its first agent loop, action authorization,
evidence rules, and expected-result integrity. The compatible adapter verifies
strict JSON Schema output and records other capabilities as unverified. Additional
probes remain necessary because an API shape alone does not guarantee equivalent
tool calling, multimodal input, streaming, or cancellation behavior.

See [the engine strategy report](./docs/research/004-open-model-first-engine-strategy.md).

## Project structure

```text
bin/yellowbird.js       Local CLI
examples/               Runnable target used to demonstrate scout behavior
src/scout/              Real local browser scout and evidence generation
src/server.js           Dashboard HTTP server and API routes
src/domain/             Seed data and test/run domain model
src/services/           Store, policy, grants, and simulated runner
src/public/             Dependency-free dashboard
schemas/                Versioned public evidence contracts
test/                   Bun tests for the scout, domain, policy, runner, and API
docs/research/          Product research and decision narrative
```

## Open-source direction

The executable runner, evidence schemas, provider interfaces, policy model, CLI,
and self-hosting path belong in the public core. A hosted YellowBird service may
add private operational infrastructure, but evidence and generated regressions
must remain portable so users are not locked into that service.

YellowBird is licensed under [Apache License 2.0](./LICENSE). Contributions are
welcome through the process in [CONTRIBUTING.md](./CONTRIBUTING.md), and security
issues should follow the private reporting path in [SECURITY.md](./SECURITY.md).
Hosted-service-only infrastructure should live outside this public repository
rather than being obfuscated inside it.

## Research

The security, identity, engine, and market decisions are documented in
[docs/research](./docs/research/README.md).
