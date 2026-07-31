# Open-model-first agent engine strategy

- Status: **Accepted**
- Date: 2026-07-30
- Product area: agent orchestration, model inference, self-hosting, provider portability

## Question being addressed

How should Yellow Bird integrate Kimi and other open-weight language models first, while still supporting hosted APIs, local inference, multimodal testing, tool use, and future provider-specific capabilities?

This question covers two distinct Kimi deployment modes:

1. Moonshot AI's hosted Kimi API.
2. Customer-hosted Kimi weights served by an inference runtime such as vLLM or SGLang.

It also covers smaller open-weight models served through vLLM, SGLang, llama.cpp, Ollama, a customer gateway, or another compatible runtime.

## Impact of the decision

The engine boundary affects:

- whether Yellow Bird can run locally, in a customer's cloud, or as a managed service;
- whether product source, screenshots, and test observations leave the customer's environment;
- the minimum hardware and operational cost of self-hosting;
- which models can perform reliable tool calls and structured output;
- how much provider-specific behavior leaks into test definitions;
- whether findings remain reproducible when a model or serving runtime changes;
- how easily a product owner can substitute or compare models;
- Yellow Bird's ability to support fully offline execution later.

The central product risk is treating API-shape compatibility as behavioral compatibility. Two servers may both implement `/v1/chat/completions` while differing in tool-call parsing, reasoning state, multimodal formats, cancellation, schema enforcement, and error behavior.

## Decision summary

Yellow Bird will be **Kimi-first and open-model-first, but model-independent**.

The initial implementation order is:

1. a Yellow Bird-owned agent loop and normalized engine contract;
2. a Moonshot-hosted Kimi adapter;
3. a generic OpenAI-compatible endpoint adapter for customer-hosted Kimi and other open-weight models;
4. conformance probes and capability manifests for every configured model/runtime pair;
5. additional native provider adapters only where the common protocol loses a capability Yellow Bird needs;
6. subscription-backed agent CLIs as an optional local compatibility tier, not the core engine.

### Implementation checkpoint: 2026-07-31

The local scout now implements the first usable slice of this decision:

- a Yellow Bird-owned bounded planning and execution loop;
- a generic OpenAI-compatible Chat Completions adapter;
- a harmless strict JSON Schema conformance probe;
- model/runtime provenance and capability state in portable scout evidence;
- exact-origin link visits, deterministic synthetic field values, supplied select
  options, and narrowly filtered non-submit button actions;
- deterministic replay that does not call the planning model;
- an explicit `inconclusive` result when the engine or requested capability is
  unavailable.

The default local binding probes Ollama at `http://127.0.0.1:11434/v1`. The
implementation has been exercised with `qwen3.5:9b`; this is a tested local
binding, not a change to the Kimi-first reference strategy. Native Moonshot/Kimi
transport behavior, tool-call probes, image input, streaming, cancellation, and
production deployment bindings remain future work and are reported as
unverified rather than implied.

Kimi is the first reference model family because its current models are designed for agentic tool use, expose structured output and multimodal capabilities through the hosted API, and publish weights that can be deployed through common inference servers. As of 2026-07-30, Kimi K3 is Moonshot's current flagship and its official repository recommends vLLM, SGLang, or TokenSpeed for deployment. Its hosted API exposes Chat Completions, tools, JSON Schema output, streaming, usage, and reasoning controls ([Kimi API concepts](https://platform.kimi.ai/docs/introduction), [Kimi Chat API](https://platform.kimi.ai/docs/api/chat), [Kimi K3](https://github.com/MoonshotAI/Kimi-K3)).

“Open model” is not a sufficient license description. Yellow Bird will use **open-weight** in product and configuration language, record the exact model artifact and license, and avoid implying that every weight license is OSI-approved or permits every managed-service use.

## High-level design

```text
Test intent and immutable expectations
                  |
                  v
      Yellow Bird agent orchestrator
      - planning and exploration
      - policy and tool authorization
      - retries and test repair
      - evidence and coverage accounting
                  |
                  v
       Normalized EngineRequest API
                  |
          +-------+--------+----------------+
          |                |                |
          v                v                v
   Kimi hosted       Compatible HTTP   Provider-native
   Moonshot API      endpoint          adapter
                     - vLLM
                     - SGLang
                     - llama.cpp
                     - Ollama
                  |
                  v
          Selected model artifact
```

The model proposes decisions and tool calls. Yellow Bird remains responsible for:

- checking a tool call against the Run Grant;
- executing tools through the capability broker;
- deciding what evidence enters a finding;
- retaining immutable expected results;
- enforcing step, token, time, and cost budgets;
- distinguishing test invalidity from product failure;
- recording model/runtime provenance;
- deciding whether a result has enough deterministic evidence to report.

Provider-native agent loops are integrations, not the canonical execution model. They can be useful for local coding workflows but cannot replace Yellow Bird's policy, evidence, and reproducibility semantics.

### Normalized engine request

The stable contract should represent Yellow Bird concepts rather than one provider's SDK:

```yaml
engine_request:
  session_id: engsess_01
  purpose: explore
  messages: []
  tools: []
  output_schema: {}
  modalities: [text, image]
  limits:
    max_output_tokens: 16384
    deadline_ms: 120000
    max_tool_rounds: 20
  sampling:
    profile: exploratory
  continuation:
    provider_state: opaque
```

The normalized response should contain:

```yaml
engine_response:
  message: {}
  requested_tool_calls: []
  structured_output: {}
  finish_reason: stop
  usage: {}
  continuation:
    provider_state: opaque
  provenance:
    adapter: moonshot-chat
    endpoint_class: hosted
    model_requested: kimi-k3
    model_reported: kimi-k3
    runtime: moonshot
    capability_manifest_version: cap_...
```

Yellow Bird must preserve the complete provider continuation state needed for a session without treating hidden reasoning as finding evidence. Kimi K3 requires the complete returned assistant message, including reasoning and tool calls, to be replayed for preserved-thinking multi-turn sessions. That state should be encrypted or kept ephemeral, excluded from normal reports, and governed by the run's retention policy.

### Adapter layers

Use three layers instead of one adapter per model:

1. **Transport adapter** - Chat Completions-compatible HTTP, provider-native HTTP, or local process.
2. **Model-family codec** - message history, reasoning preservation, tool-call formatting, multimodal encoding, recommended sampling.
3. **Deployment binding** - base URL, credential reference, model identifier, data boundary, runtime, and limits.

This lets hosted Kimi and self-hosted Kimi share a model-family codec while differing in transport extensions and operational policy.

### Capability manifest and conformance probe

Each model/runtime binding declares and then proves capabilities:

```yaml
capabilities:
  text: supported
  image_input: supported
  video_input: unavailable
  tool_calls: verified
  parallel_tool_calls: unverified
  json_schema: verified
  preserved_reasoning: supported
  streaming: verified
  cancellation: best_effort
  usage_reporting: supported
```

At setup and after a material model/runtime/version change, Yellow Bird runs harmless probes:

- return output conforming to a small JSON Schema;
- request one tool with nested arguments;
- execute a two-turn tool-result conversation;
- test streaming termination and cancellation;
- test image input when declared;
- verify context and output ceilings conservatively;
- record malformed-output and retry behavior.

A feature remains `unverified` until the binding passes its probe. Best-effort degradation is explicit: a run may fall back from native tool calls to schema-constrained action proposals only if policy allows it, and the coverage report must show the degraded capability.

### Initial engine profiles

| Profile | Binding | Intended use | Initial posture |
| --- | --- | --- | --- |
| Kimi hosted | Moonshot API with a user- or service-owned API key | Easy local onboarding, self-hosted control planes, managed Yellow Bird | First hosted implementation |
| Open-weight endpoint | Customer URL exposing a supported compatible API | Customer cloud, private network, offline-capable environments | First self-hosted implementation |
| Local lightweight endpoint | Ollama or llama.cpp-compatible local server | Development and low-volume local runs | Supported with capability limits |
| Subscription CLI | User-owned Kimi Code, Codex, or another approved CLI | Local convenience | Experimental compatibility tier |
| Other native provider | Provider-specific supported API | Capability or commercial fallback | Added on demand |

Moonshot's API requires an API key. A self-hosted endpoint may use mTLS, workload identity, a narrow bearer token, or loopback-only access; “local” must not automatically mean unauthenticated when the endpoint is reachable outside the runner namespace.

## Meaningful detail decisions

### 1. Kimi is a reference implementation, not a hard-coded model

Repository test intent binds to a role or capability requirement:

```yaml
engine:
  binding: engine://deployment-default
  requires:
    - tool_calls
    - json_schema
  prefers:
    - open_weight_available
    - image_input
```

The control plane resolves that intent to a deployment profile. Tests must not contain Moonshot API keys, provider base URLs, or a mandatory model name unless the owner deliberately pins one for reproducibility.

Alternative: make `kimi-k3` the required model everywhere. This simplifies early code but makes local development expensive, prevents smaller-model use, and turns a product architecture into a vendor/model version.

### 2. The serving protocol is only a baseline

Chat Completions compatibility is the bootstrap protocol because Kimi's hosted API and common open-model runtimes support it. vLLM includes model-specific tool parsers, including Kimi K2-family support; llama.cpp and Ollama expose compatible APIs with tool-calling and structured-output features ([vLLM tool calling](https://docs.vllm.ai/en/latest/features/tool_calling/), [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility)).

Yellow Bird will not assume every optional field is portable. Provider/model codecs may translate:

- `reasoning_content` and preserved thinking;
- JSON Schema dialect and strictness;
- tool-choice and parallel-call behavior;
- image and video content parts;
- cancellation and streaming events;
- prompt caching;
- sampling controls;
- error and rate-limit metadata.

Alternative: use a provider aggregation library as the domain contract. This accelerates breadth but delegates important semantics and security decisions to a dependency. Such a library may be used inside an adapter later, but its types will not become Yellow Bird's public engine contract.

### 3. Local does not mean small

Kimi's frontier open weights are large. Kimi K3 has 2.8 trillion total parameters and 104 billion activated parameters, so self-hosting it is a data-center deployment rather than a typical laptop path. Yellow Bird therefore separates:

- **open-weight portability**, meaning a customer can operate the model on suitable infrastructure;
- **local lightweight inference**, meaning a smaller compatible model can run on a workstation;
- **hosted Kimi access**, meaning developers can use the Kimi family without owning inference hardware.

The same capability probes decide whether a smaller local model is suitable for a particular run profile. Deterministic scenarios may need little or no agent inference; exploratory, multimodal, and adversarial profiles may require a stronger binding.

### 4. Model output is not evidence by itself

Kimi or another model may identify a promising failure, but Yellow Bird reports a product bug only after collecting target observations and replayable actions. A model assertion without target evidence becomes a hypothesis or an inconclusive result.

For high-severity findings, configurable verification should support:

- deterministic replay without the original model;
- a fresh-session repeat;
- a second model or model version;
- owner-required approval before issue creation.

This prevents a Kimi-first strategy from becoming a single-model judge of its own work.

### 5. Reproducibility uses provenance, not false determinism

Record:

- requested and reported model identifiers;
- endpoint class and inference runtime;
- weight revision or digest when self-hosted;
- tokenizer/chat-template revision when available;
- adapter and capability-manifest versions;
- sampling profile and provider-supported parameters;
- prompt/test-definition digest;
- tool definitions and Run Grant digest.

Model inference can remain nondeterministic even with a seed. The reproducible artifact is the product interaction and evidence trail, not a promise that the model will generate identical text.

## Alternatives and tradeoff analysis

Scores are relative: 5 is best. “Implementation simplicity” rewards lower complexity.

| Direction | Portability | Local/privacy fit | Agent capability | Operational accessibility | Implementation simplicity | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Kimi-only SDK integration | 2 | 3 | 5 | 4 | 5 | Reject |
| Generic compatible API with no codecs | 5 | 5 | 2 | 5 | 4 | Reject |
| Yellow Bird contract plus Kimi reference codecs | 5 | 5 | 5 | 4 | 3 | **Choose** |
| Provider-owned agent CLI as core | 2 | 4 | 5 | 4 | 4 | Reject as core |
| Aggregation library as public contract | 4 | 4 | 4 | 5 | 5 | Reject as public contract |
| Hosted Kimi first | 4 | 2 | 5 | 5 | 4 | **Choose as first hosted binding** |
| Self-hosted compatible endpoint first | 5 | 5 | 3 | 2 | 3 | **Choose as first open-weight binding** |
| Require frontier Kimi locally | 1 | 2 | 5 | 1 | 1 | Reject |
| Capability-tested smaller local models | 5 | 5 | 2-4 | 4 | 3 | **Choose** |

## Forward-looking considerations

- Add a public engine-adapter SDK and conformance suite once the normalized contract stabilizes.
- Maintain tested compatibility matrices by model artifact, serving runtime, and runtime version.
- Add model routing by task role, such as planning, exploration, visual inspection, verification, and summarization.
- Benchmark canary-testing outcomes rather than relying on generic model leaderboards.
- Explore speculative or ensemble strategies only after single-engine evidence accounting is reliable.
- Support customer-defined model gateways and air-gapped model registries.
- Add signed model-artifact and container provenance for regulated self-hosted deployments.
- Track model license obligations and managed-service restrictions per deployment binding.
- Add privacy-preserving prompt inspection and configurable redaction before hosted inference.
- Add queueing, admission control, and context caching for large self-hosted models.
- Evaluate Kimi Code as a local subscription adapter separately from the inference API.
- Avoid persisting hidden reasoning by default; define a provider-state retention policy before production use.

## Primary sources

- [Kimi API main concepts](https://platform.kimi.ai/docs/introduction)
- [Kimi Chat Completions API](https://platform.kimi.ai/docs/api/chat)
- [Kimi K3 repository and deployment guidance](https://github.com/MoonshotAI/Kimi-K3)
- [Kimi K2.6 model card and deployment guidance](https://huggingface.co/moonshotai/Kimi-K2.6)
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)
- [vLLM tool-calling documentation](https://docs.vllm.ai/en/latest/features/tool_calling/)
- [SGLang OpenAI-compatible APIs](https://docs.sglang.io/docs/basic_usage/openai_api_completions)
- [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)
- [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling)
