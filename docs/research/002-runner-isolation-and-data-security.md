# Research 002: Runner isolation and data security

- Status: **Proposed**
- Researched: 2026-07-30
- Product area: runner, sandbox, network, secrets, artifacts, managed service

## Question being addressed

How can Yellow Bird safely execute arbitrary customer code, generated tests, browser automation, and agent-selected tools across:

- a developer's local machine;
- a customer's cloud or self-hosted environment; and
- a multi-tenant Yellow Bird managed service?

The runner must assume that a repository, dependency, build script, target response, generated test, or tool result may be malicious. Agentic behavior increases the paths through which untrusted content can influence execution; it does not reduce the need for conventional isolation.

## Impact of the decision

This decision determines:

- whether managed Yellow Bird can safely accept arbitrary repositories;
- which workloads are compatible with each deployment mode;
- how much setup self-hosted users need;
- whether secrets and source code can cross customer boundaries;
- the usefulness and risk of public internet access;
- the fidelity of browser, API, mobile, CLI, and background-job testing;
- managed-service infrastructure cost and startup latency;
- whether evidence collection creates a second sensitive-data store.

A container-only managed service is simpler but shares a host kernel with untrusted code. A strong VM boundary costs more and may reduce compatibility. Yellow Bird should expose this as a deliberate execution profile rather than imply all deployment modes have equivalent assurance.

## Decision

### Managed service

Run each customer run in a fresh, single-run microVM boundary. A container or process namespace may be used *inside* the microVM for packaging, but a general-purpose container must not be the only tenant boundary.

The microVM:

- is never reused across organizations;
- has an ephemeral writable overlay and no host filesystem mounts;
- receives no host container socket or cluster credential;
- has CPU, memory, process, disk, time, network, and concurrency limits;
- reaches external systems only through policy-enforcing brokers;
- is destroyed after evidence export and cleanup.

Firecracker is a strong candidate because it is designed for multi-tenant microVM services, uses KVM, minimizes the device model, and adds process-level defense in depth through its jailer. Its own design explicitly states that it does not filter guest network traffic, so host-level egress enforcement remains mandatory ([Firecracker overview](https://firecracker-microvm.github.io/), [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)).

This is a design direction, not a final runtime selection. Kata Containers or a cloud provider's isolated job primitive may offer a better operational path while preserving a hardware-virtualized tenant boundary.

### Self-hosted service

Provide pluggable runtime backends and report their posture:

1. `microvm`
2. `sandboxed-container` such as gVisor or Kata
3. `restricted-container`
4. `host-process`

Self-hosted operators choose based on their platform and threat model. Organization policy may refuse runs below a required posture.

gVisor is a useful self-hosted option because it intercepts the application system-call interface in a userspace application kernel rather than passing calls directly to the host kernel. Its different kernel surface improves isolation but creates compatibility and performance tradeoffs, and separate customers must still run in separate sandboxes ([gVisor security introduction](https://gvisor.dev/docs/architecture_guide/intro/), [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/)).

### Local service

Optimize for onboarding while remaining explicit:

- Prefer an available OS sandbox, rootless container, or sandboxed container.
- Permit a host-process mode only after visible confirmation.
- Default repository access to a writable worktree or overlay, not the user's entire filesystem.
- Reuse the user's locally authenticated agent CLI only through a declared adapter.
- Label the resulting report with the actual isolation and credential posture.

Local mode protects the user's environment from mistakes where possible. It is not a multi-tenant security boundary.

## Threat model

In scope:

- malicious repository code and dependency lifecycle scripts;
- sandbox escape and cross-tenant access;
- prompt injection delivered by source, documentation, target UI, email, or tool output;
- credential theft from files, process environment, logs, or browser state;
- unauthorized network scanning, SSRF, DNS rebinding, and cloud metadata access;
- resource exhaustion and denial of service;
- persistence between runs;
- source, test-data, and evidence leakage;
- a compromised runner trying to widen its own permissions;
- model or tool requests sending data outside customer privacy policy.

Not completely solved by the runner:

- hardware side channels;
- malicious cloud or host administrators;
- vulnerabilities in the control plane or pre-sandbox image setup;
- harm performed through capabilities the owner intentionally granted;
- legal authorization beyond technical proof of control.

No sandbox is a substitute for secure architecture. gVisor's own threat model notes that higher-level services, side channels, and resources intentionally exposed to a sandbox remain relevant ([gVisor limitations](https://gvisor.dev/docs/architecture_guide/intro/#what-does-gvisor-not-protect-against)).

## High-level design

### Trust boundary

```text
Control plane / policy engine
           |
           v
Scheduler creates one-run runtime -----> Evidence sink
           |                                  ^
           v                                  |
  untrusted execution sandbox ----------------+
     |          |           |
     v          v           v
 Egress      Capability   Model
 gateway       broker     gateway
     |          |           |
  targets    tools and    provider or
             secrets      local model
```

The untrusted sandbox does not receive:

- model-provider master credentials;
- control-plane database credentials;
- organization-wide integration tokens;
- cloud-node or Kubernetes service-account tokens;
- a generic secret-store credential;
- authority to mint or modify its Run Grant.

The sandbox receives narrow handles or leases. The brokers validate the Run Grant independently before honoring a request.

### Control plane and execution plane separation

The control plane stores desired state, registration, policy, schedules, and report metadata. The execution plane runs product code and test instructions.

The agent loop may be implemented in either plane, but privileged operations must cross the capability boundary. A model-generated command is untrusted input even when the model is operated by Yellow Bird.

### Filesystem

Managed defaults:

- immutable runner image;
- read-only base filesystem;
- repository snapshot plus writable copy-on-write overlay;
- per-run temporary storage;
- no parent-directory, host-device, host-socket, or arbitrary volume mounts;
- explicit size and inode quotas;
- artifact export through a broker;
- cryptographic erasure through destruction of per-run storage keys where supported.

Self-healed deterministic tests should be exported as explicit proposed artifacts or repository patches. They should not silently persist through a reused runner filesystem.

### Process and kernel controls

For container-compatible backends:

- run as a non-root UID;
- disallow privilege escalation;
- drop Linux capabilities;
- use a read-only root filesystem where compatible;
- deny host PID, IPC, user, and network namespaces;
- apply seccomp and AppArmor/SELinux profiles;
- use user namespaces where supported;
- set CPU, memory, process, and disk quotas;
- do not auto-mount service-account tokens.

Kubernetes' restricted Pod Security Standard captures many of these baseline controls. Kubernetes also recommends separate nodes or sandboxed runtimes for sensitive workloads, default-deny networking, blocking cloud metadata access, and time-bound service-account credentials ([Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/), [Kubernetes security checklist](https://kubernetes.io/docs/concepts/security/security-checklist/)).

These controls are defense in depth. For a hosted arbitrary-code service, they do not replace the microVM boundary.

### Network permission profiles

| Profile | Intended use | Allowed access |
| --- | --- | --- |
| `offline` | Source-only analysis, generated tests, offline models | No network other than in-runtime loopback |
| `target-only` | Most canary runs | Registered target origins and required Yellow Bird control channels |
| `target-and-declared-tools` | Sign-up, email, model, issue tracker, test fixtures | Targets plus capability-broker and declared provider endpoints |
| `public-read` | Research and exploratory context | Brokered HTTP(S) retrieval with unsafe networks and active methods restricted |
| `public-unrestricted` | Self-hosted or exceptionally reviewed enterprise workflows | Broad TCP/HTTP egress subject to port, address, rate, and legal-policy restrictions |

Network access defaults to `target-only` for active runs and `offline` where the target is local to the runtime.

“Public internet” must be a visible permission. Even in `public-unrestricted` mode:

- cloud metadata, link-local, multicast, and infrastructure control networks remain blocked;
- destination and resource budgets remain enforced;
- public reachability does not grant permission to adversarially test arbitrary third parties;
- the report records the widened risk;
- organization policy may prohibit the profile.

The initial multi-tenant managed service should not offer raw `public-unrestricted` egress. It can provide `public-read` through a broker and add narrowly reviewed destinations to `target-and-declared-tools`. A self-hosted operator may deliberately enable raw egress because that traffic leaves infrastructure they control; a future managed enterprise tier would require separate abuse controls and review.

Kubernetes NetworkPolicy is useful for layer 3/4 controls but depends on a network plugin that actually enforces it. Domain- and redirect-aware policy therefore requires an egress proxy or gateway in addition to cluster network policy ([Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)).

### Secret delivery

1. Configuration contains a secret reference, not a value.
2. The scheduler authenticates the one-run workload.
3. The credential broker evaluates the Run Grant and requested capability.
4. It obtains or creates the narrowest credential possible.
5. The runner receives a one-time handle, short lease, scoped token, browser session, or memory-backed file.
6. The broker revokes or expires the lease at run termination.
7. Logs and artifacts pass through redaction and sensitivity classification.

Prefer brokered requests over exposing credentials. For example, the email tool can poll a mailbox on the runner's behalf without revealing the mailbox provider's account token.

When a process must receive a secret, prefer a memory-backed file or dedicated file descriptor over a process-wide environment variable. Kubernetes notes that environment variables can leak through crash dumps and logs more readily than permission-controlled files ([Kubernetes security checklist — secrets](https://kubernetes.io/docs/concepts/security/security-checklist/#secrets)).

One-time wrapped secret delivery is a useful self-hosted integration pattern. Vault response wrapping provides a single-use, short-lived reference whose unexpected prior use can be detected ([Vault response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping)).

### Model gateway and privacy boundary

Provider credentials remain outside the untrusted runtime. The model gateway:

- validates provider and model permissions;
- applies token and cost budgets;
- redacts or blocks disallowed data classes;
- records provider, region, retention posture, and account owner;
- forwards only the context required by the agent step;
- supports a local/provider adapter where calls originate from the user's environment.

Yellow Bird must show a pre-run data-egress summary. A generic disclaimer is insufficient because provider products have different retention rules. For example, OpenAI API data has configurable controls and is not used for training by default unless the customer opts in, while default abuse-monitoring logs may be retained for up to 30 days; endpoint application-state rules also vary ([OpenAI API data controls](https://platform.openai.com/docs/guides/your-data)). Anthropic documents different retention behavior for API and consumer/subscription products, and its zero-data-retention arrangements do not generally cover Claude Max ([Anthropic retention](https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [Anthropic zero data retention](https://privacy.anthropic.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to)).

### Evidence and artifact handling

Potential evidence includes source snippets, prompts, responses, screenshots, video, DOM snapshots, request bodies, headers, cookies, traces, logs, database fixtures, and generated tests. Evidence can be more sensitive than the final finding.

Requirements:

- assign a sensitivity class before upload;
- strip authorization headers, cookies, API keys, and known secret patterns;
- minimize reproduction data to the failing case;
- encrypt in transit and at rest;
- isolate storage and encryption context by organization;
- use explicit retention periods and deletion controls;
- make raw video, network bodies, and full prompts opt-in by policy;
- record which evidence was omitted or redacted;
- never use customer artifacts to improve models without explicit, separate consent.

### Image and supply-chain integrity

The runner image and deterministic helper tools are trusted computing base components. Yellow Bird should:

- pin versions and digests;
- publish an SBOM for open components;
- sign release artifacts and runner images;
- verify signatures before scheduling;
- minimize packages and background services;
- patch hosts, kernels, firmware, runtimes, and guest images;
- retain a reproducible mapping from run to image digest.

## Alternatives considered

| Runtime boundary | Isolation | Compatibility | Startup/cost | Self-host ease | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| Host process | Very low | Excellent | Excellent | Excellent | Local escape hatch only |
| Restricted container | Low-medium | Excellent | Excellent | Excellent | Local/self-host compatibility tier |
| gVisor sandbox | Medium-high | Good, not universal | Good | Good | Recommended self-host option |
| Kata/VM-backed container | High | Very good | Moderate | Moderate | Strong candidate |
| Firecracker microVM | High | Good for Linux workloads | Good at scale, operationally complex | Poor-moderate | Managed-service candidate |
| Dedicated VM per run from cloud API | High | Excellent | Slower and costly | Moderate | Managed fallback / enterprise tier |
| Dedicated physical host | Very high tenant separation | Excellent | Very costly | Poor | Exceptional regulated tier |

## Tradeoff analysis

Scores are relative: 5 is best. “Operational simplicity” rewards lower complexity.

| Decision | Tenant isolation | Compatibility | Local usability | Cost efficiency | Operational simplicity |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ephemeral microVM for managed runs | 5 | 4 | 1 | 4 | 2 |
| Container-only managed runs | 2 | 5 | 2 | 5 | 5 |
| Pluggable self-host runtimes with posture labels | 4 | 5 | 5 | 4 | 2 |
| One required runtime everywhere | 4 | 2 | 2 | 3 | 4 |
| External capability/model/egress brokers | 5 | 4 | 4 | 3 | 2 |
| Credentials directly in runner environment | 1 | 5 | 5 | 5 | 5 |
| Default-deny tiered egress | 5 | 4 | 4 | 4 | 3 |
| Broad internet access by default | 1 | 5 | 5 | 3 | 5 |

## Best-effort behavior

Best effort must never silently weaken a security boundary.

- If one test cannot run under the granted permissions, continue with other tests and report it as not tested.
- If a requested runtime feature is incompatible with the strongest sandbox, an owner may select a weaker posture in local/self-hosted mode; the report must identify the downgrade.
- A managed multi-tenant run must fail closed if its isolation, credential broker, or egress policy cannot be established.
- A missing evidence source may reduce confidence, but absence of evidence must not become a pass.
- Cleanup should retry and alert, but access leases must expire independently of successful cleanup.

## Open-source boundary

To preserve user trust and deploy-anywhere ownership, the following should be open:

- runner protocol and reference runner;
- policy and Run Grant schemas;
- runtime adapters;
- egress and capability interfaces;
- redaction and report schemas;
- self-hosted deployment manifests;
- security posture reporting.

Managed scheduling, fleet optimization, abuse detection, and service operations may remain private. Customer source, prompts, artifacts, and generated tests must follow the customer's configured privacy boundary regardless of which service components are public.

## Forward-looking considerations

- Benchmark Firecracker, Kata, gVisor, and cloud-isolated jobs against representative web, API, browser, CLI, and container workloads.
- Define a compatibility probe that predicts which sandbox profile a repository requires before a paid run.
- Add offline model and embedding adapters without changing the runner protocol.
- Explore confidential-computing runners for customers that do not want the managed host to inspect source or evidence.
- Add regional execution and evidence residency.
- Design mobile-device and hardware-in-the-loop runners as separately attested execution backends.
- Build prompt-injection-aware taint tracking for content that crosses from target/tool output into privileged agent decisions.
- Formalize evidence minimization and automatic secret detection with measurable recall.
- Commission external review of the managed runner threat model before accepting hostile public repositories.

## Primary sources

- [Firecracker overview](https://firecracker-microvm.github.io/)
- [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)
- [gVisor security introduction](https://gvisor.dev/docs/architecture_guide/intro/)
- [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/)
- [Kubernetes security checklist](https://kubernetes.io/docs/concepts/security/security-checklist/)
- [Kubernetes Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Vault response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping)
