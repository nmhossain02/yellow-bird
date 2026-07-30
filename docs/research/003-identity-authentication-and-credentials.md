# Research 003: Identity, authentication, credentials, and model access

- Status: **Proposed**
- Researched: 2026-07-30
- Product area: control-plane authentication, CI, repository and target credentials, tools, model providers

## Question being addressed

How should Yellow Bird authenticate and authorize:

- product owners and organization administrators;
- manual, scheduled, webhook, and CI triggers;
- hosted and self-hosted runners;
- source repositories;
- the target product and synthetic users;
- model providers and subscription-backed agent CLIs;
- optional tools such as email aliases and issue trackers?

What belongs in version-controlled repository configuration, and what must remain in an external control plane or secret store?

## Impact of the decision

Authentication is a cross-cutting product surface. It affects onboarding, deploy-anywhere portability, enterprise adoption, unattended operation, source privacy, third-party terms, secret exposure, and the tool ecosystem.

A single “API key” abstraction is attractive but hides materially different principals and lifecycles. A user's identity, a Git repository installation, a CI job, a one-run workload, a synthetic test account, and an LLM billing credential should not share the same token or revocation boundary.

## Decision

Create one identity model with typed principals, while keeping authentication mechanisms pluggable:

| Principal | Preferred authentication | Authorization basis |
| --- | --- | --- |
| Human user | OpenID Connect authorization-code flow with PKCE | Organization/project/environment RBAC |
| Enterprise human | Federated OIDC initially; SAML/SCIM through an identity broker when needed | Organization roles and groups |
| CI job | CI-issued OIDC identity exchanged for a short-lived Yellow Bird token | Repository, workflow, ref, environment, and trigger policy |
| Webhook sender | Provider signature/HMAC plus provider installation identity | Registered integration and event policy |
| Scheduled trigger | Internal scheduler workload identity | Stored schedule, policy version, and delegated owner authority |
| Managed runner | One-run workload identity bound to Run Grant | Exact run and capabilities |
| Self-hosted runner | Registration bootstrap followed by renewable workload identity | Runner pool, organization, labels, and posture |
| Repository integration | Provider app installation token | Selected repositories and minimum provider permissions |
| Target synthetic user | Credential broker lease or test-session handle | Target, role/persona, run, and permitted actions |
| Tool integration | OAuth delegation, app installation, or brokered secret | Tool capability grant |
| Model provider | API key, cloud workload identity, custom gateway, local model, or user-owned CLI adapter | Provider/model/budget/data-egress policy |

Use OAuth/OIDC security best practice rather than invent browser login. RFC 9700 is the current OAuth 2.0 security best-current-practice document and covers redirect-flow protections, replay prevention, privilege restriction, and sender/audience-constrained tokens ([RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)).

### Authentication, authorization, and secret delivery are separate

- **Authentication**: who is requesting?
- **Authorization**: what may that identity do here and now?
- **Secret delivery**: what narrow credential or handle is necessary to perform the approved action?

Yellow Bird should not infer authorization merely because a credential works. A target username/password might authenticate a user while the Run Grant still prohibits payment, deletion, or cross-tenant access.

## High-level design

### 1. Human and organization identity

The hosted control plane should support OIDC first. Self-hosted deployments can configure an OIDC issuer and bootstrap a local administrator for initial setup and recovery.

Initial roles:

- `organization_owner`
- `organization_admin`
- `project_admin`
- `test_author`
- `run_operator`
- `finding_viewer`
- `billing_admin`
- `runner_admin`

Environment-sensitive permissions are attributes or role bindings, not separate global roles. For example, a `run_operator` may run staging tests but require a production approver.

Service accounts should be typed automation principals with owners, expiry/review, and narrow permissions. Do not model them as immortal human users.

### 2. CI and trigger identity

Prefer federation over stored CI secrets. GitHub Actions can issue an OIDC token containing repository, actor, ref, environment, audience, issuer, subject, expiry, and other claims. A relying service can exchange this for a short-lived credential restricted to one job ([GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc), [GitHub OIDC concepts](https://docs.github.com/en/actions/concepts/security/openid-connect)).

Yellow Bird should validate at least:

- issuer;
- an exact Yellow Bird audience;
- subject and immutable repository/owner IDs where the provider supports them;
- workflow or reusable-workflow identity;
- ref, pull request, or deployment environment;
- token time claims and unique ID;
- organization allowlist;
- the requested target and run policy.

Webhook signatures authenticate message origin but are not sufficient run authorization. The event must map to an active provider installation, repository, trigger rule, target, and approved policy.

Fallback static trigger tokens may exist for CI systems without federation. They must be narrow, rotatable, revocable, stored outside the repository, and exchanged for a one-run token.

### 3. Runner workload identity

Managed runners receive an ephemeral identity created with the sandbox and destroyed with it. A self-hosted runner uses:

1. an owner-approved, one-time registration token;
2. node or workload attributes;
3. a renewable short-lived identity;
4. a pool membership and security-posture record;
5. a one-run grant for actual work.

SPIFFE is a good optional implementation substrate for sophisticated self-hosted deployments. It defines platform-neutral workload identities and short-lived X.509 or JWT identity documents delivered through a workload API ([SPIFFE concepts](https://spiffe.io/docs/latest/spiffe/concepts/), [SPIFFE Workload API](https://spiffe.io/docs/latest/spiffe-specs/spiffe_workload_api/)). Yellow Bird should not require users to deploy SPIRE for the MVP; its own identity interface should permit SPIFFE-backed and simpler implementations.

### 4. Repository identity

Use provider apps rather than personal access tokens where available. A GitHub App:

- is installed on explicitly selected repositories;
- has declared repository and organization permissions;
- can act independently of an individual user;
- can use short-lived installation tokens.

GitHub specifically recommends minimum permissions and short-lived GitHub App credentials over personal tokens for automation ([GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [GitHub Actions secrets guidance](https://docs.github.com/en/actions/concepts/security/secrets)).

Keep provider authorization adapters separate from the Git transport so GitHub, GitLab, Bitbucket, local filesystem, uploaded archive, and custom source providers can converge on a common repository snapshot model.

### 5. Target authentication

Target authentication is a provider system, not one username/password field.

Initial credential provider types:

- `none`
- `static_secret_reference`
- `service_account`
- `oauth_client`
- `cloud_workload_identity`
- `browser_login_recipe`
- `preauthenticated_session`
- `first_party_test_identity`
- `email_magic_link`

The product owner defines personas such as anonymous user, new customer, member, administrator, or billing owner. A persona maps to a credential provider and policy, not directly to raw credentials.

Order of preference:

1. First-party test identity/session issuance API
2. Short-lived service or OAuth identity
3. Test-owned browser account
4. Pre-authenticated, owner-supplied session
5. Human-assisted bootstrap

MFA and passkeys need explicit treatment:

- Never ask an agent to use a real person's second factor.
- Prefer a test tenant with a test-owned factor or an application-issued test session.
- Permit virtual authenticators only when the owner explicitly declares that capability and the target supports test credentials.
- Treat recovery codes as high-sensitivity secrets.
- Keep a persona's state isolated by run unless the test explicitly covers account history.

### 6. Tool ecosystem authentication

Tools are brokered capabilities. Installing a tool does not automatically grant it to every agent or run.

An email-alias tool illustrates the model:

```yaml
capability: email_alias
permissions:
  - create_alias
  - receive
denied:
  - send
limits:
  aliases: 3
  messages: 20
  retention: 24h
```

The runner receives an alias and message data, not the provider's mailbox credential. Adding `send` is a separate capability because it has a different abuse and reputation impact.

Other tools—SMS, payment sandboxes, issue trackers, feature-flag services, database fixtures, cloud consoles—use the same pattern:

1. owner connects or configures a provider;
2. provider credential stays in a broker or customer secret store;
3. policy declares semantic capabilities;
4. the Run Grant selects a subset;
5. broker performs or delegates the operation;
6. audit records the semantic action and provider result.

### 7. Model and agent-engine authentication

Support five engine classes:

1. Direct provider API key
2. Cloud platform identity, such as a provider model through the customer's cloud account
3. Customer LLM gateway
4. Local or offline model
5. User-owned agent CLI authenticated through an existing subscription

The provider adapter contract should expose:

- supported input modalities;
- structured-output capability;
- tool-call model;
- context and output limits;
- whether state can be resumed;
- authentication mode;
- data destination and retention descriptor;
- cost/usage reporting availability;
- cancellation behavior;
- whether unattended execution is supported;
- whether the adapter can obey Yellow Bird's capability broker or only its own permission system.

The first stable implementations should prioritize Kimi and open-weight deployments:

- Moonshot-hosted Kimi authenticated with a customer- or service-owned API key;
- customer-hosted Kimi or another open-weight model behind a compatible endpoint;
- local lightweight inference behind the same normalized Yellow Bird contract.

The common HTTP protocol is a bootstrap boundary, not a claim that providers or inference runtimes behave identically. Every model/runtime binding needs a capability manifest and conformance probes. See [004 — Open-model-first agent engine strategy](./004-open-model-first-engine-strategy.md).

#### Subscription-backed CLI decision

Support subscription-backed CLIs as a **local/self-hosted experimental compatibility tier**, not as the stable managed-service engine contract.

As of 2026-07-30:

- Codex supports ChatGPT subscription login and API-key login for local CLI use. It also provides non-interactive `codex exec`. OpenAI recommends API keys as the default for automation, while ChatGPT-managed authentication is an advanced path for trusted private runners ([Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex availability](https://openai.com/index/introducing-the-codex-app/)).
- Claude Code supports paid Claude account login and a non-interactive print mode. The combination makes a local adapter technically plausible, but it should not be interpreted as a permanent unattended-service contract without provider confirmation ([Claude Code setup](https://code.claude.com/docs/en/getting-started), [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)).
- Cursor CLI supports browser login and non-interactive/headless execution, but its documented CI path uses an API key. Treat account-backed unattended use as local and experimental ([Cursor CLI authentication](https://docs.cursor.com/en/cli/reference/authentication), [Cursor headless CLI](https://docs.cursor.com/en/cli/headless), [Cursor in GitHub Actions](https://docs.cursor.com/en/cli/github-actions)).

Rules for these adapters:

- Yellow Bird invokes an installed, user-selected CLI; it does not imitate a private API.
- Yellow Bird does not scrape, export, upload, or centrally store the CLI's cached OAuth credentials.
- The adapter runs on a machine the user controls.
- The user is responsible for the provider account, plan, terms, and usage limits.
- The adapter reports “usage unavailable” rather than inventing token cost.
- Provider login expiry or rate limits produce a visible capability failure, not a test pass.
- Automated managed-service use requires a provider-supported API, enterprise token, cloud identity, or explicit provider agreement.
- Each adapter is versioned and tested because CLI behavior and output formats can change.

This preserves the low-friction indie-developer path without making Yellow Bird's core reliability depend on consumer login sessions.

### 8. Secret storage and delivery

Repository configuration contains references:

```yaml
personas:
  member:
    credential_provider: secret://yellowbird/targets/staging/member
models:
  default:
    provider: moonshot
    model: kimi-k3
    credential: secret://local-keychain/moonshot/default
```

Secret resolution is deployment-specific:

- local: OS keychain, user-owned agent session, local encrypted store, or explicit environment reference;
- self-hosted: Vault, cloud secret manager, Kubernetes CSI integration, or custom broker;
- managed: tenant-isolated encrypted storage backed by a managed KMS.

Prefer dynamic credentials and short leases. Vault documents that dynamic secrets are created on demand and can be revoked after use, reducing the period in which a stolen credential remains useful ([Vault dynamic secrets](https://developer.hashicorp.com/vault/tutorials/get-started/understand-static-dynamic-secrets)).

Secret values must not appear in:

- repository configuration;
- Run Grants;
- prompts unless the target interaction strictly requires them;
- agent-visible command history;
- logs, screenshots, or reports;
- issue-tracker exports.

Redaction is defense in depth, not the primary control. GitHub notes that secret-log redaction cannot cover every transformed value ([GitHub Actions secrets](https://docs.github.com/en/actions/concepts/security/secrets)).

## Repository versus control-plane configuration

The necessity test is:

> Put reviewable, portable test intent in the repository. Put identity, proof, secrets, mutable operations, and organization governance in the control plane.

| Configuration | Repository | Control plane / secret store | Reason |
| --- | ---: | ---: | --- |
| Test goals, invariants, and instructions | Yes | Optional override | Reviewable product intent |
| Generated deterministic test code | Yes or exported artifact | Cached copy allowed | Must be reviewable and portable |
| Symbolic target IDs and environment names | Yes | Resolution required | Avoid hard dependency on one deployment |
| Non-sensitive local target URL | Yes | Optional | Developer convenience |
| Production target origin and ownership proof | Reference only | Yes | Operational and security state |
| Requested test capabilities | Yes | Organization may narrow | Reviewable least-privilege intent |
| Organization deny policy | No | Yes | Repository must not weaken governance |
| Schedules | Optional desired state | Yes for execution | Requires timezone, ownership, pausing, and audit |
| CI trigger declaration | Yes | Registration and policy | Both code review and external trust are needed |
| Provider/model preference | Yes | Availability and billing binding | Portable intent, deployment-specific account |
| Secret values or OAuth refresh tokens | No | Yes | Confidential and independently revocable |
| Secret references | Yes | Resolver binding | Portable without exposing values |
| Retention and evidence defaults | Yes | Organization may narrow | Product ownership with governance floor |
| Human approvals and audit history | No | Yes | Mutable, identity-bound records |

Resolution order should be deterministic:

1. hard platform safety constraints;
2. organization policy;
3. project/environment policy;
4. repository policy;
5. test request;
6. agent-selected action.

Each layer may narrow the permissions granted by the preceding authority available to it. An agent cannot widen policy, and a repository cannot override an organization deny rule.

## Alternatives considered

| Alternative | Advantages | Disadvantages | Decision |
| --- | --- | --- | --- |
| One Yellow Bird API key for everything | Simple onboarding | Conflates principals, broad blast radius, poor audit | Reject |
| OIDC/OAuth plus typed service principals | Standard, federated, short-lived | More domain-model work | **Choose** |
| Personal access tokens for Git providers | Broad compatibility | User-tied and often long-lived | Fallback only |
| Provider app installations | Fine-grained and organization-owned | Provider-specific adapters | **Choose where available** |
| Raw target credentials injected into runner | Universal | High exfiltration risk | Compatibility fallback |
| Credential/capability broker | Narrow authority and strong audit | Operational complexity | **Choose** |
| Kimi and open-weight compatible APIs | Hosted accessibility plus self-hosting portability | Compatibility needs model/runtime probes | **Choose as stable initial tier** |
| Proprietary API-only model access | Reliable and supportable | Higher indie setup and billing friction, no open-weight path | Later compatibility tier |
| Subscription CLI as core engine | Very easy locally | Provider/session/terms instability | Reject as core; support experimentally |
| All configuration in repository | Portable and reviewable | Secrets and governance risk | Reject |
| All configuration in control plane | Secure operations | Poor portability and code review | Reject |
| Split desired state from operational bindings | Portable and governable | Requires resolution UX | **Choose** |

## Tradeoff analysis

Scores are relative: 5 is best. “Implementation simplicity” rewards lower complexity.

| Decision | Security | Indie onboarding | Enterprise fit | Deploy-anywhere fit | Implementation simplicity |
| --- | ---: | ---: | ---: | ---: | ---: |
| Typed principals with federated identity | 5 | 4 | 5 | 5 | 2 |
| One long-lived product API key | 1 | 5 | 1 | 4 | 5 |
| Capability and credential broker | 5 | 4 | 5 | 4 | 2 |
| Direct secret injection | 1 | 5 | 2 | 5 | 5 |
| Kimi plus open-weight endpoint adapters | 4 | 4 | 4 | 5 | 3 |
| Proprietary provider API adapters | 4 | 3 | 5 | 4 | 4 |
| Experimental local subscription adapters | 2 | 5 | 2 | 4 | 3 |
| Repository/control-plane configuration split | 5 | 4 | 5 | 5 | 3 |
| Repository-only configuration | 2 | 5 | 2 | 5 | 5 |

## Best-effort behavior

- Missing optional target credentials should skip affected personas and quantify coverage loss.
- Expired human or model-provider login should pause that capability and request reauthentication; it must not change expected results.
- A tool may return a capability-unavailable result, after which the agent may choose another already-granted method.
- Failed principal authentication, invalid Run Grant, or denied secret lease fails closed.
- If a self-hosted installation cannot support federation, a narrow static credential is permitted with an explicit posture warning.
- A provider adapter may degrade model features, but must report which modalities, tools, or structured-output guarantees were unavailable.

## Forward-looking considerations

- Add SAML/SCIM and group-to-role mapping when enterprise demand justifies it.
- Define a portable credential-provider plugin protocol without standardizing secret values.
- Add delegated administration for agencies that manage client products without owning the client organization.
- Support passkey/WebAuthn test fixtures and virtual authenticators safely.
- Add synthetic-user lifecycle APIs for provisioning, state reset, and teardown.
- Ask providers for explicit supported patterns for subscription-backed unattended local runs.
- Add provider data-residency and retention policy checks during engine selection.
- Support customer-controlled model gateways and fully offline models without weakening report provenance.
- Maintain a model/runtime capability matrix rather than treating compatible API shapes as equivalent behavior.
- Record the exact model artifact and license; use “open-weight” instead of assuming every published weight is open source under the same terms.
- Add break-glass access with short expiry, explicit reason, second-party notification, and enhanced audit.
- Build an authorization simulator that shows exactly what a CI event, runner, persona, tool, and model can access before a run.

## Primary sources

- [OAuth 2.0 Security Best Current Practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub Actions OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [SPIFFE concepts](https://spiffe.io/docs/latest/spiffe/concepts/)
- [SPIFFE Workload API](https://spiffe.io/docs/latest/spiffe-specs/spiffe_workload_api/)
- [Vault response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping)
- [Vault dynamic secrets](https://developer.hashicorp.com/vault/tutorials/get-started/understand-static-dynamic-secrets)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude Code setup](https://code.claude.com/docs/en/getting-started)
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Cursor CLI authentication](https://docs.cursor.com/en/cli/reference/authentication)
- [Cursor headless CLI](https://docs.cursor.com/en/cli/headless)
- [Kimi API main concepts](https://platform.kimi.ai/docs/introduction)
- [Kimi Chat Completions API](https://platform.kimi.ai/docs/api/chat)
- [Kimi K3 repository](https://github.com/MoonshotAI/Kimi-K3)
- [vLLM tool calling](https://docs.vllm.ai/en/latest/features/tool_calling/)
