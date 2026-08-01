# Real Price Scout end-to-end validation

The repository unit and integration suite uses controlled fixtures. It does not
claim that those fixtures are Price Scout. Real Price Scout coverage is a separate
local end-to-end gate against the application repository and its generated
portable replay. CI keeps running the controlled suite, while this local gate owns
the external checkout, Compose stack, and planning-engine dependencies.

Clone the external application into the ignored fixture directory:

```bash
git clone https://github.com/nmhossain02/price-scout.git \
  test/fixtures/external/price-scout
```

Prepare the local compatible planning engine described in the main README, then
run:

```bash
bun run test:price-scout
```

To use an existing checkout in another directory:

```bash
YELLOWBIRD_PRICE_SCOUT_DIR=/path/to/price-scout \
bun run test:price-scout
```

The validator canonicalizes `.git` suffixes, trailing slashes, and
`git@github.com:` SSH origins, then refuses any checkout whose `origin` does not
match `https://github.com/nmhossain02/price-scout`. It requires a clean checkout,
records its revision, starts the target with `make up` from that verified
checkout, and confirms that the revision did not change during startup. It also
refuses a non-loopback planning-engine endpoint and verifies loopback engine
provenance in the resulting evidence. It then runs the same intent scout from
the Price Scout working directory with `/monitors/new` declared as the primary
read-only agent route and the application's asset prefixes declared as load
routes, requires the observed
`initial-interface-basic-flow.v1` profile, requires a passed visit to
`/monitors/new`, installs the generated replay bundle, and runs that replay from
its independent temporary artifact directory. The default external checkout
remains uncommitted because `test/fixtures/external/` is ignored.
Target and health endpoint overrides are rejected so the configured URL cannot
be redirected to a service unrelated to the stack started by this gate.

On July 31, 2026, this flow passed against Price Scout commit
`9422d8e0224ece6a19c4b8e1cdbd1d7d1b217501` using YellowBird commit
`b548fa72792e173b32c07b78525b8fe9ec250f6e`. The scout returned `clear`, recorded
the HTTPS-to-HTTP loopback repair, satisfied the owned coverage profile, visited
`/monitors/new`, and the generated replay passed outside both repositories.
