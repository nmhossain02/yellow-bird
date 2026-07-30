# Research 001: Target ownership and run authorization

- Status: **Proposed**
- Researched: 2026-07-30
- Product area: target enrollment, policy, runner authorization, abuse prevention

## Question being addressed

How can Yellow Bird establish that a user is authorized to canary test a repository and/or deployed environment, then ensure that a test runner only performs the approved actions against the approved targets?

This is not one problem:

1. **Repository authorization** establishes access to source and repository events.
2. **Target-control proof** establishes control over a deployment, hostname, cloud resource, or private environment.
3. **Run authorization** records what may happen during one specific run.
4. **Runtime enforcement** prevents the runner from silently exceeding that authorization.

Repository control does not prove control over the URL in a repository's documentation. Domain control also does not establish legal permission to test every application or tenant served by that domain. Yellow Bird can establish strong technical evidence of control and consent, but it cannot cryptographically prove legal authority.

“Local” is a property of a connection from a particular network namespace, not a property of a URL or of the Yellow Bird installation. A local runner may legitimately test a loopback process while also being able to reach arbitrary public systems. Local deployment therefore changes the available proof method; it does not remove the need to classify and authorize the destination.

## Impact of the decision

This decision affects:

- whether Yellow Bird can safely offer adversarial testing as a hosted service;
- onboarding friction for local, preview, staging, and production environments;
- the policy and configuration domain model;
- network routing and sandbox design;
- incident response, auditability, and revocation;
- whether a compromised repository or runner can turn Yellow Bird into an SSRF, scanning, or denial-of-service service;
- how confidently a target can recognize a Yellow Bird run.

Weak enrollment permits testing third-party systems. Strong enrollment with only one proof method makes local and private-network use impractical. A signed grant without independent enforcement is merely documentation, while enforcement without an intelligible grant undermines product-owner control.

## Decision

Use a layered **prove, grant, enforce** model:

1. Register a target with one or more proof methods appropriate to its environment.
2. Require an authorized product owner to approve a versioned policy.
3. Mint a short-lived, one-run **Run Grant** bound to an ephemeral runner identity.
4. Enforce the grant outside the untrusted test process through the scheduler, capability broker, and egress gateway.
5. Preserve the grant, policy digest, proof record, and enforcement events with the run evidence.

Yellow Bird should support multiple proof methods rather than require first-party application integration. First-party support can improve assurance and observability, but it must remain optional.

## High-level design

### 1. Target registration

A `TargetRegistration` represents something that may be tested:

```yaml
id: target_01
project: project_01
kind: web-origin
environment: staging
canonical_origin: https://staging.example.com
proof:
  method: http-challenge
  verified_at: 2026-07-30T17:00:00Z
  expires_at: 2026-10-28T17:00:00Z
owner_principal: organization_01
```

The exact schema can evolve, but target identity must use canonical, immutable internal IDs. Display names, repository names, and URLs are mutable attributes rather than identity. For a local or private target, the registration must also bind the endpoint to a runner or runner group and to a network scope. `localhost`, a container service name, and a private IP are not globally meaningful target identities.

### 2. Proof methods

| Situation                       | Recommended proof                                                            | What it establishes                                                           | Important limitation                                                    |
| ------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Loopback process                | Interactive local consent plus OS process/socket binding                      | A local operator approved the process listening in the runner's network scope | Local access is low assurance and does not authorize any referenced URL |
| Run-created container or VM     | Orchestrator provenance plus container/VM and isolated-network binding        | Yellow Bird launched the exact disposable resource being tested               | A pre-existing container or VM needs separate consent or challenge      |
| Pre-existing local container/VM | Local consent plus runtime identity or one-time service challenge             | The local operator approved a particular runtime resource                     | Runtime IPs and names are mutable and network-scoped                    |
| Repository-only analysis        | Git provider app installation                                                | An administrator granted access to a specific repository                      | Does not prove control over a deployment                                |
| Public HTTP target              | Temporary `/.well-known/yellowbird-challenge/<nonce>` response               | Control over content served at the origin                                     | CDN, routing, and multi-tenant boundaries require care                  |
| Public domain                   | DNS TXT challenge                                                            | Control over the relevant DNS zone or delegated challenge zone                | May be higher-friction and broader than app-level control               |
| Cloud deployment                | Cloud/deployment-platform connector                                          | Control over a specific deployment or account resource                        | Requires provider-specific adapters and permissions                     |
| Private LAN or private cloud    | Environment-admin approval or service challenge, bound to an attested runner | An approved runner may test a named internal service                          | Reachability and private addressing alone do not prove ownership        |
| Yellow Bird-aware application   | Signed challenge/consent endpoint                                            | Application-level control and optional run-token recognition                  | Requires first-party integration and cannot be the default              |

The HTTP and DNS methods adapt the proven ACME control pattern: HTTP-01 places a token under a well-known path, while DNS-01 places a token-derived value in DNS. The methods have different deployment and credential tradeoffs, so Yellow Bird should not collapse them into one path ([Let's Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/)).

For GitHub, a GitHub App installation gives repository-scoped access with explicitly granted permissions. GitHub recommends minimum permissions, and administrators choose the repositories available to the installation ([GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)).

### 2.1 Local deployment authorization

An ACME-style HTTP or DNS challenge is usually the wrong default for a loopback service. It adds application work while proving little beyond control of the same machine. Yellow Bird should instead create a low-assurance **Local Target Attestation** through trusted runner-control code, outside the agent and test process.

The local enrollment flow is:

1. The CLI or local daemon authenticates the interactive OS user and displays the exact endpoint, resolved locality, requested actions, and whether Yellow Bird launched the target.
2. It resolves the endpoint from the same network namespace that will enforce the run. A loopback exception applies only when the connection-time destination remains loopback in that namespace. `localhost` is specified to resolve to loopback, but a container has its own loopback and network namespace ([RFC 6761, section 6.3](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3), [Docker networking](https://docs.docker.com/engine/network/)).
3. It binds the target to the strongest available local identity:
   - for a process, OS user, executable identity where available, PID plus process start time, transport, and port or socket;
   - for a container, runtime and immutable container ID, network ID, port, and image digest where available;
   - for a VM, hypervisor instance ID, virtual network, and port;
   - for a resource Yellow Bird just created, the orchestrator's launch record and run ownership.
4. The trusted local control component signs the attestation with the registered runner key. The record includes the approving principal, endpoint, network scope, resource binding, policy digest, issue time, and expiry.
5. A local control plane may consume that attestation on the same machine. A hosted control plane accepts it only from an enrolled runner over an authenticated, runner-initiated outbound channel and may issue grants only back to that runner or runner group.
6. The runner's gateway enforces the endpoint and resource binding. A process/container/VM restart, listener change, network change, runner deregistration, or policy widening invalidates or renews the attestation.

The local attestation says “this registered local operator approved this resource from this runner.” It is deliberately reported as `local` assurance; the hosted service cannot independently prove ownership of an endpoint it cannot reach.

When the platform cannot reliably identify the listener or runtime resource, Yellow Bird may fall back to an endpoint-only, short-lived local approval, but must lower the assurance reported for the run. Non-interactive local or CI runs reuse a previously approved registration; they do not infer approval from checked-in configuration.

The following topology rules prevent “self-hosted” from becoming a blanket proof exception:

| Topology                                         | Authorization rule                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runner and target in one host/network namespace | Allow local attestation only for a verified loopback destination or a locally bound socket/process.                                                     |
| Runner in Docker/VM, target on its host          | Treat the host endpoint as a separate network scope; require an explicit host-service registration. `localhost` inside the runner does not mean host.  |
| Runner and target in sibling containers/VMs      | Prefer a Yellow Bird-created isolated network and orchestrator provenance; otherwise bind approval to both runtime identities and the network.          |
| Runner and target on a private LAN               | Require environment-admin approval or a service challenge. Private addressing and reachability do not establish ownership ([RFC 1918](https://www.rfc-editor.org/rfc/rfc1918.html)). |
| Local runner testing a public origin             | Require the same origin, platform, or application proof as a hosted runner. Local execution creates no proof exception.                                 |
| Hosted control plane dispatching locally         | Enroll the runner, use its outbound authenticated channel, validate its local attestation, and bind the Run Grant to that runner's ephemeral public key. |

Repository and project configuration is untrusted desired state, not an authorization source. It may refer to an existing target ID or request enrollment, but it cannot create a verified registration, approve itself, expand a CIDR, mark a public endpoint as local, or convert a dependency into a test target. Non-interactive agent/test code must not have access to the local enrollment credential or approval socket.

All supported binaries should apply these rules in local and self-hosted modes. A machine owner can modify an open-source runner or use another tool, so Yellow Bird cannot cryptographically prevent a privileged machine owner from bypassing local safeguards. The relevant product boundary is that an untrusted repository or agent cannot make the unmodified runner, hosted control plane, managed credentials, or Yellow Bird tool services attack an unproved third party. Any explicit developer override should be unavailable to hosted/managed runs, should never unlock managed credentials or tools, and should permanently mark resulting evidence as unverified.

### 3. Proof strength and renewal

Each registration receives an assurance level:

- `local`: evidence exists only on the local runner;
- `repository`: a source provider authorized the repository;
- `origin`: a challenge established control of a network origin;
- `platform`: a deployment or cloud provider established resource control;
- `application`: the target application explicitly participates in authorization.

Production and adversarial profiles should require `origin`, `platform`, or `application` assurance plus an organization role permitted to approve production runs. Proofs expire and must be renewed. Changing the canonical origin, tenant identifier, environment classification, or owning organization invalidates the proof.

Proof strength should be reported, not presented as certainty. A valid DNS proof for `example.com` does not prove that the user may disrupt every tenant under that domain.

Local proof lifetime follows the bound resource rather than a long calendar interval. A local process or pre-existing container registration expires when its recorded identity changes; a run-created disposable resource expires at teardown. Private-LAN approvals should have an explicit renewal period and be invalidated by endpoint, network-scope, runner-group, or environment-owner changes.

### 4. Run Grant

A Run Grant is a signed, immutable authorization for one run. A strict JWT/JWS profile is a practical first representation because audience, expiry, not-before, and unique token identifiers are standardized claims ([JWT, RFC 7519](https://www.rfc-editor.org/rfc/rfc7519.html)). The domain object must not depend on JWT, so a future deployment may use an opaque token with introspection.

Minimum grant content:

```yaml
issuer: yellowbird-control-plane
subject: principal_or_trigger_identity
audience:
  - runner_credential_broker
  - run_egress_gateway
run_id: run_01
grant_id: one_time_unique_id
not_before: 2026-07-30T17:00:00Z
expires_at: 2026-07-30T18:00:00Z
project_id: project_01
target_ids:
  - target_01
target_bindings:
  target_01:
    endpoint: https://staging.example.com:443
    network_scope: public
    proof_record_digest: sha256:...
repository:
  provider: github
  immutable_repository_id: "456789"
  revision: commit_sha
environment: staging
capabilities:
  target:
    - browser.navigate
    - http.read
    - http.write
    - test_data.create
    - test_data.delete_owned
  tools:
    - email_alias.receive
network_profile: target-and-declared-tools
budgets:
  wall_time_seconds: 3600
  requests: 2000
  concurrent_sessions: 4
  egress_bytes: 500000000
policy_digest: sha256:...
runner_key_thumbprint: ...
```

The grant should use:

- one audience per enforcement service where practical;
- a short lifetime and unique grant ID;
- a digest of the fully resolved policy;
- an immutable repository ID and revision rather than repository name alone;
- an environment classification;
- a resolved endpoint, network scope, and proof-record binding for every target;
- explicit target and tool capabilities;
- resource, concurrency, and time budgets;
- a key binding to an ephemeral runner key.

OAuth Resource Indicators standardize restricting a token to a particular resource and warn that multi-audience bearer tokens increase trust between recipients ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)). OAuth Rich Authorization Requests provide a useful semantic model for locations, actions, datatypes, and privileges even if Yellow Bird does not implement the complete OAuth extension in version one ([RFC 9396](https://www.rfc-editor.org/rfc/rfc9396.html)).

The grant should be sender-constrained for managed and production runs. DPoP demonstrates how a token can be bound to a key and how method, URI, time, unique ID, and server nonce checks limit replay ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html)). Yellow Bird can adopt these properties without claiming that every Run Grant is an OAuth DPoP token.

### 5. Run authorization flow

1. A manual, scheduled, webhook, or CI principal requests a run.
2. The control plane authenticates that principal.
3. The policy engine resolves repository policy, organization policy, target registration, trigger restrictions, and requested capabilities.
4. Any permission widening or production-sensitive operation requires the configured approval.
5. The scheduler creates an isolated runner with an ephemeral key pair.
6. The control plane issues a Run Grant bound to the public key.
7. The credential broker and egress gateway validate the grant independently.
8. The runner requests capabilities; brokers permit, narrow, or deny them.
9. Grant expiry or revocation terminates privileged operations and network access.
10. The report distinguishes completed, denied, unavailable, skipped, and untested actions.

### 6. Network and redirect enforcement

Origin verification alone is insufficient. The egress gateway must:

- canonicalize scheme, host, port, and path boundaries;
- resolve and enforce local/private bindings from the gateway's own network namespace, not from the agent's view of `localhost`;
- reject userinfo, ambiguous URL encodings, unsupported protocols, and unsafe ports;
- prevent redirects from widening the approved target set;
- block cloud metadata, link-local, loopback, multicast, and private address ranges unless the target registration explicitly authorizes the relevant private destination;
- protect against DNS rebinding by validating resolutions at connection time and applying destination policy after resolution;
- constrain request rate, concurrency, bandwidth, and total run duration;
- log allowed and denied destinations without leaking credentials;
- treat third-party dependencies as separately declared destinations.

The gateway's allowlist is compiled from verified target registrations and the signed grant, never directly from repository configuration. If a requested connection cannot be matched to a target binding after resolution, it is denied even when the repository requested “public internet access.”

A third-party destination can be classified as:

- `target`: active testing is authorized;
- `dependency`: only the declared product flow may interact with it;
- `tool-endpoint`: access is mediated by a Yellow Bird tool;
- `model-endpoint`: accessible only through the model broker;
- `control-endpoint`: required for runner operation.

“Public internet access” is a separate permission, not evidence that active testing of arbitrary internet applications is authorized.

### 7. Revocation and audit

Target proofs, policy versions, runner registrations, grants, and integration credentials must be revocable. Revocation should reach enforcement services promptly; short token lifetimes limit exposure if propagation is delayed.

The audit record should include:

- who or what requested and approved the run;
- proof method and assurance level;
- resolved policy and digest;
- grant ID and runner identity;
- capabilities requested, permitted, denied, or narrowed;
- target destinations and redirect decisions;
- secret lease identifiers, never secret values;
- termination reason and cleanup status.

## Alternatives considered

### Ownership and consent alternatives

| Alternative                                 |           Security strength |    Onboarding |           Coverage | Decision                           |
| ------------------------------------------- | --------------------------: | ------------: | -----------------: | ---------------------------------- |
| Trust any URL entered by a user             |                    Very low |     Excellent |          Excellent | Reject                             |
| Repository installation only                |    Low for deployed targets |     Excellent |               Good | Use only for repository operations |
| HTTP challenge only                         |                 Medium-high |          Good |   Public HTTP only | Support                            |
| DNS challenge only                          |     High for domain control | Moderate-poor |     Public domains | Support, not default               |
| Cloud platform integration only             |                        High |      Moderate | Provider-dependent | Support incrementally              |
| Required Yellow Bird application middleware |           High at app layer |          Poor |            Limited | Optional enhancement               |
| Multiple proofs selected by target type     | High when correctly applied |          Good |          Excellent | **Choose**                         |

### Local authorization alternatives

| Alternative                                      | Advantages                                         | Disadvantages                                                                 | Decision                                    |
| ------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
| Treat every self-hosted destination as authorized | No enrollment friction                             | Lets malicious repositories use the runner as a scanner or third-party request source | Reject                               |
| Require HTTP/DNS proof for every local target     | One conceptual proof flow                          | Breaks zero-integration localhost use and cannot represent container locality | Reject as default                           |
| Interactive consent only                          | Simple and application-agnostic                    | Approval can silently drift to a different process after a restart            | Insufficient alone                          |
| Local attestation with resource/network binding   | Low integration cost with enforceable narrow scope | Platform-specific process/runtime inspection and renewal logic                 | **Choose for local targets**                |
| Treat private-LAN reachability as local proof      | Easy internal onboarding                           | Any compromised runner could scan peer services; private IPs are not unique   | Reject                                      |
| Environment approval or challenge for LAN targets | Represents actual administrative control           | More setup and organization-specific identity integration                     | **Choose for LAN/private-cloud targets**    |

### Run credential alternatives

| Alternative                               | Advantages                                 | Disadvantages                                            | Decision                                                   |
| ----------------------------------------- | ------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------- |
| Long-lived runner API key                 | Simple                                     | Broad blast radius, weak per-run intent, difficult audit | Reject for run authority                                   |
| Unbound signed bearer token               | Stateless and interoperable                | Stolen token can be replayed until expiry                | Accept only for low-risk/local compatibility               |
| Sender-constrained signed grant           | Strong per-run binding and audit           | More key lifecycle and gateway work                      | **Choose for managed/production**                            |
| Opaque grant with introspection           | Immediate revocation and centralized logic | Control-plane dependency and latency                     | Keep as deployment option                                  |
| mTLS certificate encoding all permissions | Strong workload identity                   | Poor fit for rich, changing authorization detail         | Use for workload identity, not as the sole policy document |

## Tradeoff analysis

Scores are relative: 5 is best. “Implementation simplicity” rewards lower complexity.

| Decision                                        | Abuse resistance | User ownership | Deploy-anywhere fit | Implementation simplicity | Extensibility |
| ----------------------------------------------- | ---------------: | -------------: | ------------------: | ------------------------: | ------------: |
| Proof selected by target type                   |                5 |              5 |                   5 |                         2 |             5 |
| Local attestation plus resource/network binding |                4 |              5 |                   5 |                         2 |             4 |
| HTTP/DNS challenge required for localhost       |                3 |              2 |                   2 |                         3 |             3 |
| Private reachability treated as ownership       |                1 |              3 |                   4 |                         5 |             2 |
| One mandatory first-party integration           |                5 |              3 |                   1 |                         3 |             2 |
| Repository authorization alone                  |                2 |              4 |                   4 |                         5 |             3 |
| Sender-constrained Run Grant                    |                5 |              5 |                   4 |                         2 |             5 |
| Long-lived runner credential                    |                1 |              2 |                   5 |                         5 |             2 |
| Broker/gateway enforcement outside test process |                5 |              4 |                   4 |                         2 |             5 |
| Policy enforced only inside agent instructions  |                1 |              3 |                   5 |                         5 |             3 |

## Best-effort behavior

Best effort applies to test coverage, not to authorization.

- If a test cannot obtain a permitted capability, continue with other tests and report the coverage loss.
- If target ownership proof is absent or expired, do not actively test a non-local target.
- If a local attestation is absent, stale, or no longer matches the listener/runtime identity, pause that target and request re-approval; do not silently reclassify it as local.
- If the grant cannot be validated, fail the privileged operation.
- If the egress gateway cannot enforce the destination policy, a managed runner must not receive broad network access.
- If a self-hosted operator selects a weaker enforcement mode, label the run's assurance and preserve that fact in the report.

## Forward-looking considerations

- Standardize a public Run Grant and target-consent profile so self-hosted runners and targets can interoperate.
- Add deployment-platform proofs for common preview providers and cloud environments.
- Explore remote workload attestation for managed and customer-hosted runners.
- Define portable local resource bindings for Linux, macOS, Windows, common container runtimes, and VM managers; unavailable binding signals must lower assurance rather than be fabricated.
- Design delegated private-environment approver roles and runner groups so LAN registration does not require hosted control-plane reachability.
- Allow a Yellow Bird-aware application to validate run identity and expose test-only fixtures without making integration mandatory.
- Develop tenant-aware targets for shared SaaS domains where hostname proof is too broad.
- Add human-readable authorization diffs so owners approve semantic changes rather than raw policy documents.
- Define re-authorization rules for agent-discovered targets and tools; an agent must never widen its own grant.
- Evaluate whether production adversarial runs need a second approver, maintenance window, or automated blast-radius simulation.

## Primary sources

- [Let's Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/)
- [Special-use `localhost` names, RFC 6761](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3)
- [Private address allocation, RFC 1918](https://www.rfc-editor.org/rfc/rfc1918.html)
- [Docker networking](https://docs.docker.com/engine/network/)
- [Docker host network driver](https://docs.docker.com/engine/network/drivers/host/)
- [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub Actions OIDC claims](https://docs.github.com/en/actions/reference/security/oidc)
- [JWT, RFC 7519](https://www.rfc-editor.org/rfc/rfc7519.html)
- [OAuth Resource Indicators, RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)
- [OAuth Rich Authorization Requests, RFC 9396](https://www.rfc-editor.org/rfc/rfc9396.html)
- [OAuth DPoP, RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html)
- [SPIFFE workload identity concepts](https://spiffe.io/docs/latest/spiffe/concepts/)
