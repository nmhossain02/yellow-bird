# Contributing to YellowBird

YellowBird is early-stage software. Small, reviewable changes that preserve
permission boundaries, evidence integrity, and honest coverage reporting are
especially welcome.

## Development setup

Install [Bun](https://bun.sh/) 1.3 or newer, then run:

```bash
bun install
bun run setup:browsers
bun run check
```

To exercise the real browser scout:

```bash
bun run demo:target
```

In another terminal:

```bash
bun run scout -- \
  --target http://127.0.0.1:4321 \
  --expect-title "Feather Shop" \
  --expect-text "Checkout ready"
```

Or execute the multi-step example:

```bash
bun run scout -- --scenario examples/checkout.scenario.json
```

## Pull requests

- Open an issue before making a large architectural or policy change.
- Add or update tests for behavioral changes.
- Do not weaken target authorization, network isolation, or permission checks
  merely to make a test pass.
- Do not silently change an owner's expected result while repairing test
  mechanics.
- Update the versioned evidence schema when changing its public contract.
- Describe material security and privacy implications in the pull request.

By contributing, you agree that your contribution is licensed under the
Apache License 2.0.

## Security reports

Do not report vulnerabilities in public issues. Follow
[SECURITY.md](./SECURITY.md) instead.
