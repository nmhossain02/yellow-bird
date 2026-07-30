# Yellow Bird research reports

These reports preserve the reasoning behind early Yellow Bird product and architecture decisions. They are decision-oriented research notes, not final implementation specifications.

| Report | Question |
| --- | --- |
| [001 — Target ownership and run authorization](./001-target-and-run-authorization.md) | How does Yellow Bird establish that a user may test a target, and how is each run constrained? |
| [002 — Runner isolation and data security](./002-runner-isolation-and-data-security.md) | How can Yellow Bird safely execute arbitrary customer code and agent-selected tools across local, self-hosted, and managed deployments? |
| [003 — Identity, authentication, credentials, and model access](./003-identity-authentication-and-credentials.md) | How should humans, automation, runners, repositories, targets, tools, and model providers authenticate? |
| [004 — Open-model-first agent engine strategy](./004-open-model-first-engine-strategy.md) | How should Yellow Bird integrate Kimi and other open-weight models without coupling orchestration to one provider or runtime? |
| [005 — Market value and competitive landscape](./005-market-value-and-competitive-landscape.md) | How much customer value and differentiation can Yellow Bird create across AI QA, synthetic monitoring, browser agents, and autonomous security testing? |

Status labels:

- **Proposed**: recommended direction, suitable for product planning but not yet validated by an implementation.
- **Accepted**: adopted into the product specification.
- **Superseded**: retained for narrative history but replaced by a later decision.
