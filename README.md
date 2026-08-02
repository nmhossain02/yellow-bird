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
the harmless conformance probe. The first probe may wait up to two minutes for a
local model to load cold. A scout running intent exploration is `inconclusive`
with exit code `3` if no compatible engine is available.

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

The scout reports `attention` and exits `2` when it finds product failures, or
reports `inconclusive` and exits `3` when test mechanics prevent a trustworthy
result. Product findings take precedence when both occur, while the mechanics
issue remains explicit in the report. Invalid input or configuration and
evidence-bundle persistence failures remain fatal and exit `1`.

The human report leads with an operational assessment separate from the stable
machine outcome. `ERROR` means YellowBird could not complete a trustworthy
evaluation and should be treated as an operational concern until diagnosed.
`LIMITED` means the runner completed without mechanics errors, but only a smoke
check or bounded safe exploration ran without a declared functional workflow.
`ATTENTION` identifies observed product failure signals, and combines with
`ERROR` when both product findings and run-integrity problems occur. `CLEAR` is
reserved for completed declared functional workflows. The effective scope
counts every enforced product assertion, including the expected HTTP status.
The same summary states the YellowBird run status, product signal, and effective
scope so a narrow `clear` evidence outcome cannot read as broad product health.

Runs that reach finalization write an evidence bundle under
`.yellowbird/scout/<run-id>/`:

- `report.md` - human-readable findings, reproduction steps, and coverage gaps
- `evidence.json` - versioned machine-readable observations and provenance
- `page.png` - bounded viewport visual evidence when screenshot capture succeeds
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

The demo has a fixed state at `http://127.0.0.1:4321/?fixed`. To verify the fixed
assertions as an initial-page smoke check, use that target without `--intent`
and add `--no-agent`; the run should complete with `clear`.

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
  --agent-primary-route /monitors/new \
  --agent-expect-text "Track any public product page" \
  --agent-expect-control "textbox:url:Product URL" \
  --agent-expect-control "textbox:textarea:Tracking instruction" \
  --agent-expect-control "combobox:select-one:Frequency" \
  --agent-expect-control "button:submit:Compile monitor" \
  --output yellowbird-report.md \
  --verbose
```

Outside a versioned scenario, an explicit `--intent` enables bounded agent
exploration. `--agent` opts into the same loop with the default initial-page
intent. The interaction budget defaults to four steps; `--max-agent-steps`
accepts values from `1` through `20`. An explicit `--intent` takes precedence
over `--no-agent`; YellowBird never turns a requested intent into an
initial-page-only clear result. `--no-agent` can suppress a default loop
requested only through `--agent`. Use a versioned `--scenario` when the owner
needs an exact deterministic workflow, including an empty initial-page smoke
check or mutation-capable actions with explicit assertions.

Agent document visits require repeated `--agent-primary-route` or
`--agent-navigation-route` declarations. Primary routes are the owner-identified
destinations that may satisfy an owned coverage profile. Navigation routes are
safe to visit but cannot satisfy the primary-route criterion. Same-origin load
requests made by `fetch`, XHR, event streams, or other active data channels are
blocked unless their URLs are declared with repeated `--agent-load-route`
options. Same-origin scripts, stylesheets, images, fonts, media, manifests, and
text tracks load automatically so a modern application can render. Their
follow-on effects remain subject to the active request policy. Load declarations
may end in `*` for an explicit path prefix. Relative declarations resolve
against the target, and every declaration must remain on its exact origin.

Repeated `--agent-expect-text` declarations bind the owned coverage profile to
text the owner expects on the visited primary destination. YellowBird records
whether each bounded destination assertion was satisfied and preserves the same
assertions in the portable replay. Repeated `--agent-expect-control`
declarations use `role:type:name` and require one visible semantic control with
that exact accessible name and DOM control type. These structural assertions
prevent static copy from impersonating a working form, and replay preserves the
same role, name, visibility, uniqueness, and type checks.
Native search inputs and multi-select controls retain the declaration roles
`textbox` and `combobox` while browser accessibility roles are verified.

The compatible endpoint can be selected per command:

```bash
yellowbird scout \
  --target http://127.0.0.1:3000 \
  --intent "Assess the initial interface and basic user flow" \
  --agent-primary-route /monitors/new \
  --engine-base-url http://127.0.0.1:11434/v1 \
  --engine-model qwen3.5:9b
```

The equivalent environment variables are `YELLOWBIRD_ENGINE_BASE_URL`,
`YELLOWBIRD_ENGINE_MODEL`, and `YELLOWBIRD_ENGINE_API_KEY`. The API key is sent
only as a bearer token and is never written to the evidence bundle. Configured
and provider-reported model identifiers must be nonempty printable text, at most
200 UTF-16 code units, with no surrounding whitespace. Invalid identifiers are
rejected before they enter terminal, Markdown, diagnostic, or evidence output.

An existing directory whose name ends in `.md` is diagnosed as legacy output;
rename or remove it, choose a new Markdown filename, or pass a directory path
without a `.md` suffix. Verbose mode renders a live view of the same structured
lifecycle events retained in `diagnostics.jsonl`. Exit `0` means no failure was
observed within the tested scope; consult the coverage gaps before treating that
as broader product health.

The repository also provides an identity-checked local validation against the
real Price Scout checkout and its portable replay. See
[`docs/validation/price-scout-e2e.md`](./docs/validation/price-scout-e2e.md).

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

An explicit natural-language intent may visit owner-declared exact-origin links,
fill eligible fields with YellowBird-owned synthetic values, select supplied
options, and use a narrow allowlist of read-only non-submit buttons whose labels
begin with `collapse`, `detail`, `details`, `expand`, `hide`, `inspect`,
`preview`, `reveal`, `show`, `toggle`, or `view`. YellowBird applies the same
semantic denial to every control type and blocks non-read HTTP methods,
destructive request URLs, and WebSocket, WebTransport, and WebRTC connections
throughout agent exploration. Dedicated and shared worker creation is also
policy-blocked because a worker can open WebTransport before a page-level
observer can constrain it. Form submission,
authentication, credential use, cross-origin navigation, and destructive
controls are not available to the model as actions. The model proposes one
supplied element at a time; YellowBird validates and executes the action. Model
text is coverage guidance, never product-failure evidence. Planner output alone
cannot authorize `covered` coverage. An intent-exploration run can be `clear`
only when a named YellowBird-owned profile satisfies every machine-readable
observed criterion. The initial-interface basic-flow profile, for example,
requires the initial page, a passed visit to a distinct authorized route, safe
controls observed on that destination, and no failed agent action. Intents that
do not match an owned profile, need server-side mutation, or require another
action outside the safe interaction authority produce an `inconclusive` result
instead of an unverified pass. After at least one authorized step passes, a
later planner, action, cleanup, policy, or browser-operation failure preserves
the earlier steps and page observations as `partial` coverage.

Before authorizing controls or requests, YellowBird repeatedly percent-decodes
URL and control semantics, normalizes case and letter-digit boundaries so names
such as `delete2FA` remain prohibited, considers computed accessible names
including `aria-labelledby`, and fails closed when encoded text or a referenced
label cannot be resolved. Browser guards are installed before destination scripts
run, keep their enforcement state outside page-accessible objects, and report
blocked browser operations through a per-run channel. Agent document visits
intercept every redirect response so an unsafe destination is blocked before the
browser follows it. Policy-rejected `fetch` calls are recorded and rejected
before dispatch. During the initial target load and each authorized visit,
owner-declared exact-origin `GET` and `HEAD` non-document request URLs, including
`EventSource`, are allowed only through a 150 ms settlement interval after
`DOMContentLoaded`.
Allowed response bodies continue streaming without YellowBird buffering them.
Later network requests outside an explicitly mediated visit document chain are
blocked, and the non-HTTP transports above remain blocked throughout agent mode.
The evidence JSON and Markdown report retain the normalized primary, navigation,
and load-route declarations used for both the coverage decision and browser
enforcement.

The generated regression re-enforces the live scout's exact-origin, read-only,
redirect, and 150 ms visit-settlement guards, including submission and the same
non-HTTP transport blocking, without calling the model. Every authorized visit
attempt is retained for replay, including one that failed during the live scout.
Recorded non-navigation actions also replay through verified locators and assert
their match counts before using the recorded ordinal. The replay also fails for
the same exact-origin HTTP response and request failures that produce live
product findings.

Fetch errors caused by policy enforcement are correlated to the exact blocked
request occurrence and excluded from product-failure evidence. Independent
console, page, and request errors, including another failure at the same URL,
remain product signals.

A bounded snapshot of the current page URL, title, text, and control inventory,
including supplied link URLs and select options, is sent to the configured model
endpoint. Text and controls must pass ancestor visibility, rendered geometry,
closed-container, and clipping checks before entering that snapshot. URLs are
sent exactly and can include query values. The default endpoint is loopback.
Planning requests never follow endpoint redirects. Operators choosing a remote
endpoint are responsible for that data boundary. Query values and console
contents remain out of operational diagnostics.

Owner-declared scenarios retain their explicit permission model for exact
`fill`, `click`, `expectText`, and `expectVisible` steps. A failed action is
reported as `inconclusive`, not as a product pass or product bug, because selector
healing has not been implemented. That distinction is part of the evidence
contract. Assertions wait up to the configured browser timeout for async page
transitions and rendering before they fail.

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
`runScout(input)` uses the real Playwright Chromium launcher. The runner's
`timeoutMs` input defaults to 15 seconds and is passed to Playwright when Chromium
launches.

An isolated browser-context creation failure is also finalized as
`inconclusive`. The report marks navigation and declared workflow steps skipped,
keeps the screenshot artifact `null`, and retains an actionable operational
diagnostic.

A screenshot capture failure likewise finalizes with a test-mechanics issue,
keeps `artifacts.screenshot` set to `null`, records the visual-evidence coverage
gap, and preserves the remaining evidence bundle. With no product findings, the
outcome is `inconclusive`.

A browser cleanup failure is recorded at the same finalization boundary. The
completed product observations and available artifacts are retained, cleanup is
reported as test mechanics, and a run without product findings is
`inconclusive`.

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
