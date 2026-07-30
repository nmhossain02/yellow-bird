# YellowBird

YellowBird is an open-source, deploy-anywhere canary testing project. Its goal is
to discover product failures before customers do, preserve the product owner's
expected results, and return evidence that can be reproduced without YellowBird.

The first executable slice is intentionally small: a local browser scout. It
checks a loopback web target, captures runtime evidence, and generates a portable
Playwright regression. The dashboard still demonstrates the larger orchestration
model while that model is implemented incrementally.

## Try the real scout

YellowBird uses [Bun](https://bun.sh/) 1.3 or newer.

```bash
bun install
bun run setup:browsers
```

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

The scout exits `2` when it finds asserted failures. It writes an evidence bundle
under `.yellowbird/scout/<run-id>/`:

- `report.md` — human-readable findings, reproduction steps, and coverage gaps
- `evidence.json` — versioned machine-readable observations and provenance
- `page.png` — full-page visual evidence
- `regression.spec.js` — deterministic Playwright assertions suitable for review
- `playwright.config.js` — makes the regression immediately replayable from the
  hidden evidence directory

The machine-readable format is published as
[`schemas/scout-evidence.v1.schema.json`](./schemas/scout-evidence.v1.schema.json)
so issue trackers, CI reporters, and other tools can integrate without depending
on YellowBird internals.

The demo has a fixed state at `http://127.0.0.1:4321/?fixed`, so the same command
with that target should complete with `clear`.

## Scout safety boundary

The alpha accepts only `localhost`, `127.0.0.1`, and `::1`. Browser requests are
restricted to the target's exact origin; cross-origin requests are blocked and
reported as coverage gaps. Local control is the authorization proof for this
mode.

This is a useful development boundary, not production target authorization.
Remote staging and production targets will require explicit challenge proofs,
scoped run grants, sandboxing, and policy approval before they are enabled.

The scout does not currently click controls, sign up users, mutate data, or use
an LLM. It inventories interactive elements and says that they were not tested.
That honesty is part of the evidence contract, not an incidental limitation.

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
```

`run` talks to an already-running dashboard server. `scout` performs the real
local browser check.

## What is real

- Loopback-only target authorization and exact-origin browser network policy
- Initial-page navigation with status, title, text, console, exception, failed
  request, screenshot, and interactive-element evidence
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
- Kimi, open-weight model endpoints, email, source provider, secret store, issue
  tracker, and production sandbox integrations remain adapter boundaries.
- Dashboard authentication uses a fixed development principal.

These seams are visible in API output and the UI so the product does not imply
security or coverage it has not earned.

## Engine direction

YellowBird is Kimi-first and open-model-first, but its test domain is not coupled
to one model. YellowBird will own the agent loop, tool authorization, evidence
rules, and expected-result integrity. Model/runtime pairs must pass capability
probes because an API shape alone does not guarantee equivalent tool calling,
structured output, multimodal input, or cancellation behavior.

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
