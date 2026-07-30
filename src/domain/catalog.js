const now = () => new Date().toISOString();

export const capabilityCatalog = [
  {
    id: "browser.navigate",
    label: "Browser navigation",
    description: "Navigate and inspect pages on the registered target.",
    risk: "low"
  },
  {
    id: "http.read",
    label: "Read target APIs",
    description: "Make safe HTTP reads against registered target origins.",
    risk: "low"
  },
  {
    id: "http.write",
    label: "Write target APIs",
    description: "Submit forms and create target-owned application state.",
    risk: "medium"
  },
  {
    id: "test_data.create",
    label: "Create test data",
    description: "Create data marked as owned by this canary run.",
    risk: "medium"
  },
  {
    id: "test_data.delete_owned",
    label: "Clean up test data",
    description: "Delete only data created by this canary run.",
    risk: "medium"
  },
  {
    id: "email_alias.receive",
    label: "Receive test email",
    description: "Create an alias and receive product-generated messages.",
    risk: "medium"
  },
  {
    id: "public_internet.read",
    label: "Read public internet",
    description: "Brokered read-only access to non-target public pages.",
    risk: "high"
  }
];

export const defaultPolicy = {
  id: "pol_default",
  name: "Local owner policy",
  revision: 3,
  allowedCapabilities: [
    "browser.navigate",
    "http.read",
    "http.write",
    "test_data.create",
    "test_data.delete_owned",
    "email_alias.receive"
  ],
  deniedCapabilities: ["public_internet.read"],
  networkProfiles: ["offline", "target-only", "target-and-declared-tools"],
  productionRequiresApproval: true,
  maxRunSeconds: 3600,
  maxRequests: 2000,
  evidenceRetentionDays: 14,
  updatedAt: now()
};

export function scenarioCatalog(projectId = "prj_feather") {
  return [
    {
      id: "scn_checkout",
      projectId,
      title: "Checkout remains idempotent",
      category: "expected",
      mode: "scripted",
      intent: "A repeated checkout submission creates exactly one order and one charge.",
      expected: {
        invariant: "order_count_delta == 1 && charge_count_delta == 1",
        ownerEditable: true
      },
      requiredCapabilities: ["browser.navigate", "http.read", "http.write", "test_data.create"],
      steps: [
        { id: "open-cart", executor: "script", action: "Open a seeded cart" },
        { id: "submit-checkout", executor: "script", action: "Submit checkout twice with one idempotency key" },
        { id: "inspect-orders", executor: "script", action: "Compare resulting orders and charges" }
      ],
      fixture: "duplicate-order"
    },
    {
      id: "scn_signup",
      projectId,
      title: "New customer signup and verification",
      category: "edge-case",
      mode: "hybrid",
      intent: "A new customer can register, receive a verification message, and reach an authenticated session.",
      expected: {
        invariant: "account.verified == true && session.authenticated == true",
        ownerEditable: true
      },
      requiredCapabilities: [
        "browser.navigate",
        "http.write",
        "test_data.create",
        "email_alias.receive",
        "test_data.delete_owned"
      ],
      steps: [
        { id: "discover-signup", executor: "agent", action: "Find the current signup entry point" },
        { id: "create-account", executor: "script", action: "Register with a run-owned email alias" },
        { id: "verify-email", executor: "agent", action: "Interpret the verification message and follow the valid link" },
        { id: "assert-session", executor: "script", action: "Assert the account and session invariants" }
      ],
      fixture: "healed-selector"
    },
    {
      id: "scn_tenant_boundary",
      projectId,
      title: "Tenant data boundary exploration",
      category: "adversarial",
      mode: "exploratory",
      intent: "An authenticated customer must not observe resources belonging to another tenant.",
      expected: {
        invariant: "cross_tenant_resources_visible == 0",
        ownerEditable: true
      },
      requiredCapabilities: ["browser.navigate", "http.read"],
      steps: [
        { id: "map-resources", executor: "agent", action: "Map identifiers visible to the current synthetic user" },
        { id: "vary-identifiers", executor: "agent", action: "Explore adjacent resource references within request limits" },
        { id: "validate-boundary", executor: "script", action: "Assert that no foreign resource body is returned" }
      ],
      fixture: "tenant-leak"
    },
    {
      id: "scn_offline_contract",
      projectId,
      title: "Generated API contract checks",
      category: "expected",
      mode: "scripted",
      intent: "Committed API response shapes continue to match the product contract.",
      expected: {
        invariant: "schema_violations == 0",
        ownerEditable: true
      },
      requiredCapabilities: ["http.read"],
      steps: [
        { id: "load-contract", executor: "script", action: "Load the repository's generated contract assertions" },
        { id: "sample-responses", executor: "script", action: "Exercise documented read endpoints" },
        { id: "validate-schema", executor: "script", action: "Validate response structure and required fields" }
      ],
      fixture: "pass"
    }
  ];
}

export function createSeedState() {
  const createdAt = now();
  const projectId = "prj_feather";
  const scenarios = scenarioCatalog(projectId);

  const previousRun = {
    id: "run_demo_7f3a",
    projectId,
    targetId: "tgt_local",
    trigger: "ci",
    profile: "balanced",
    networkProfile: "target-and-declared-tools",
    status: "completed",
    outcome: "attention",
    requestedCapabilities: defaultPolicy.allowedCapabilities,
    grantedCapabilities: defaultPolicy.allowedCapabilities,
    deniedCapabilities: [],
    progress: 100,
    stage: "Complete",
    scenarioIds: scenarios.map((scenario) => scenario.id),
    coverage: {
      total: 4,
      passed: 2,
      failed: 2,
      skipped: 0,
      untested: 0
    },
    scenarioResults: [
      { scenarioId: "scn_checkout", status: "failed", healed: false, durationMs: 8400 },
      { scenarioId: "scn_signup", status: "passed", healed: true, durationMs: 12100 },
      { scenarioId: "scn_tenant_boundary", status: "failed", healed: false, durationMs: 9300 },
      { scenarioId: "scn_offline_contract", status: "passed", healed: false, durationMs: 3100 }
    ],
    findingIds: ["fnd_duplicate_order", "fnd_tenant_leak"],
    coverageGaps: [],
    createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
    durationMs: 32900,
    grant: {
      id: "grant_demo",
      expiresAt: createdAt,
      assurance: "local",
      policyDigest: "sha256:demo",
      tokenPreview: "eyJhbGciOiJFZERTQSJ9.…stub"
    }
  };

  return {
    schemaVersion: 1,
    product: {
      name: "Yellow Bird",
      version: "0.1.0-stub",
      deploymentMode: "local",
      engine: "simulated",
      engineStrategy: "kimi-and-open-weight-first",
      authentication: "development-principal",
      startedAt: createdAt
    },
    principal: {
      id: "usr_local_owner",
      name: "Local Owner",
      email: "owner@yellowbird.local",
      role: "organization_owner"
    },
    projects: [
      {
        id: projectId,
        name: "Feather Shop",
        description: "Demo commerce product used to exercise the Yellow Bird canary workflow.",
        kind: "web-app",
        repository: {
          provider: "local",
          display: "acme/feather-shop",
          defaultBranch: "main",
          revision: "7de21af",
          access: "read"
        },
        health: "ready",
        scenarioCount: scenarios.length,
        createdAt,
        updatedAt: createdAt
      }
    ],
    targets: [
      {
        id: "tgt_local",
        projectId,
        name: "Local development",
        url: "http://localhost:4173",
        kind: "web-origin",
        environment: "local",
        health: "ready",
        proof: {
          status: "verified",
          method: "local",
          assurance: "local",
          verifiedAt: createdAt,
          expiresAt: null
        },
        capabilities: defaultPolicy.allowedCapabilities
      },
      {
        id: "tgt_staging",
        projectId,
        name: "Staging",
        url: "https://staging.feather.example",
        kind: "web-origin",
        environment: "staging",
        health: "unverified",
        proof: {
          status: "pending",
          method: "http-challenge",
          assurance: null,
          verifiedAt: null,
          expiresAt: null
        },
        capabilities: defaultPolicy.allowedCapabilities
      }
    ],
    policies: [defaultPolicy],
    triggers: [
      {
        id: "trg_manual",
        projectId,
        type: "manual",
        name: "Owner initiated",
        status: "available",
        configuration: {}
      },
      {
        id: "trg_ci",
        projectId,
        type: "ci",
        name: "GitHub pull request",
        status: "stubbed",
        configuration: {
          provider: "github",
          events: ["pull_request.ready_for_review"],
          identity: "oidc"
        }
      },
      {
        id: "trg_nightly",
        projectId,
        type: "schedule",
        name: "Nightly edge sweep",
        status: "stubbed",
        configuration: {
          expression: "0 3 * * *",
          timezone: "America/Los_Angeles",
          enabled: false
        }
      }
    ],
    engineProfiles: [
      {
        id: "eng_simulated",
        name: "Fixture simulator",
        kind: "simulated",
        status: "active",
        dataBoundary: "local"
      },
      {
        id: "eng_kimi_hosted",
        name: "Kimi hosted API",
        kind: "provider-api",
        provider: "moonshot",
        protocol: "openai-chat-completions",
        model: "kimi-k3",
        status: "unconfigured",
        authentication: "api-key",
        dataBoundary: "provider-specific",
        capabilityDiscovery: "probe-required",
        openWeightAvailable: true
      },
      {
        id: "eng_open_weight_endpoint",
        name: "Open-weight compatible endpoint",
        kind: "compatible-api",
        provider: "customer-managed",
        protocol: "openai-chat-completions",
        model: "deployment-selected",
        status: "unconfigured",
        authentication: "deployment-managed",
        dataBoundary: "customer-controlled",
        capabilityDiscovery: "probe-required",
        openWeightAvailable: true
      },
      {
        id: "eng_local_cli",
        name: "User-owned agent CLI",
        kind: "subscription-cli",
        provider: "user-selected",
        protocol: "local-process",
        model: "cli-selected",
        status: "unconfigured",
        authentication: "cli-owned-session",
        dataBoundary: "user-machine",
        capabilityDiscovery: "adapter-declared",
        experimental: true
      }
    ],
    scenarios,
    runs: [previousRun],
    findings: [
      {
        id: "fnd_tenant_leak",
        runId: previousRun.id,
        projectId,
        scenarioId: "scn_tenant_boundary",
        title: "Cross-tenant invoice accessible by identifier",
        summary: "A member session retrieved an invoice fixture owned by a different tenant after changing the invoice identifier.",
        severity: "high",
        confidence: 0.91,
        status: "open",
        evidence: [
          { kind: "request", label: "GET /api/invoices/inv_2049", detail: "Authenticated as tenant bluebird" },
          { kind: "response", label: "200 OK", detail: "Body contains tenant sunfinch billing fixture" },
          { kind: "assertion", label: "Ownership mismatch", detail: "response.tenant_id != session.tenant_id" }
        ],
        reproduction: [
          "Sign in as the run-owned member for tenant bluebird.",
          "Open an invoice belonging to the current tenant and record its identifier format.",
          "Request `/api/invoices/inv_2049` using the same authenticated session.",
          "Observe a 200 response containing the sunfinch tenant fixture; expected 403 or 404."
        ],
        createdAt
      },
      {
        id: "fnd_duplicate_order",
        runId: previousRun.id,
        projectId,
        scenarioId: "scn_checkout",
        title: "Repeated checkout creates a duplicate order",
        summary: "Two near-simultaneous submissions with the same idempotency key created separate order records.",
        severity: "medium",
        confidence: 0.84,
        status: "open",
        evidence: [
          { kind: "trace", label: "Checkout pair", detail: "Requests separated by 43 ms with identical idempotency key" },
          { kind: "database", label: "Order delta", detail: "Expected +1 order; observed +2 orders" }
        ],
        reproduction: [
          "Create a cart containing one in-stock item.",
          "Submit checkout twice within 100 ms using the same idempotency key.",
          "Query the run-owned customer's recent orders.",
          "Observe two order records; expected exactly one."
        ],
        createdAt
      }
    ],
    auditEvents: [
      {
        id: "evt_seed",
        type: "workspace.seeded",
        actor: "system",
        message: "Created the local demonstration workspace.",
        createdAt
      }
    ]
  };
}
