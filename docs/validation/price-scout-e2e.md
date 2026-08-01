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
match `https://github.com/nmhossain02/price-scout`. It resolves the checkout to
its physical worktree root, clears ambient Git configuration and repository
overrides, and requires it to contain the trusted repository's remote `HEAD`.
An operator can instead authorize one immutable revision with
`YELLOWBIRD_PRICE_SCOUT_COMMIT=<full-commit-digest>`. The validator creates a
temporary shared clone with no working tree, checks out that digest detached,
and executes only from the resulting fresh index and worktree. Dirty source
files, untracked dotenv files, and source index flags therefore cannot enter the
validated tree. The validator also refuses a non-loopback planning-engine
endpoint.

Before startup, the validator creates a unique Compose project with unique image
tags and assigns free loopback-only host ports to the API and fixture services.
It renders and checks that configuration before running `make up` from the
fresh authorized checkout. Checkout, Compose, Git, install, and replay children
receive only a small allowlist of process variables. Compose implicit dotenv
loading is disabled, service env files are reset, and every service's rendered
environment must exactly match isolated fixture values. The YellowBird engine
API key is not passed to the checkout or Compose commands; the scout is the only
child process that receives it. After startup, the validator rechecks both the
revision and cleanliness, then checks them again immediately before the scout.
It tears down the isolated containers, network, volumes, and images after either
success or failure. It also removes the temporary authorized checkout after
teardown.

The validator runs the intent scout from the Price Scout working directory with
`/monitors/new` declared as the primary read-only agent route, the application's
asset prefixes declared as prefix load routes, and `/api/v1/monitors` plus
`/api/v1/events` declared as exact load routes. It verifies loopback engine
provenance and requires the observed
`initial-interface-basic-flow.v1` profile, requires a passed visit to
`/monitors/new`, requires the destination to expose the Price Scout form's
heading text, and requires exactly one visible `Product URL` URL textbox,
`Tracking instruction` textarea, `Frequency` combobox, and `Compile monitor`
submit button. It also verifies that the evidence retains the declared primary
and API load-route authority. Those destination assertions are preserved as
role, accessible-name, visibility, uniqueness, and control-type checks in the
generated replay before the validator installs and runs it from its independent
temporary artifact directory. The validator leaves that artifact directory
intact. On success, it prints the path together with the verified Price Scout
commit and Compose project name.

The default external checkout remains uncommitted because
`test/fixtures/external/` is ignored. Target and health endpoint overrides are
rejected so the configured URL cannot be redirected to a service unrelated to
the stack started by this gate.
