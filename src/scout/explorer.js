import { cleanDiagnosticText, diagnosticUrl } from "./diagnostics.js";

const SAFE_FILL_TYPES = new Set([
  "email",
  "number",
  "search",
  "tel",
  "text",
  "url"
]);
const PROHIBITED_ACTION_TEXT =
  /\b(?:accept|activate|add|apply|approve|authenticate|authorize|buy|check[ -]?(?:now|out)|compile|confirm|create|delete|log[ -]?(?:in|out)|order|pay|pause|purchase|register|reject|remove|resume|run|save|sign[ -]?(?:in|out|up)|submit|subscribe|update|upload)\b/i;
const AUTHENTICATION_CONTEXT =
  /\b(?:auth(?:enticate|orize)?|log[ -]?(?:in|out)|register|sign[ -]?(?:in|out|up))\b/i;
const READ_ONLY_BUTTON_TEXT =
  /^\s*(?:collapse|details?|expand|hide|inspect|preview|reveal|show|toggle|view)\b/i;
const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "elementRef",
    "value",
    "rationale",
    "coverage",
    "summary"
  ],
  properties: {
    action: {
      type: "string",
      enum: ["act", "finish"]
    },
    elementRef: { type: ["string", "null"] },
    value: { type: ["string", "null"] },
    rationale: { type: "string" },
    coverage: {
      type: "string",
      enum: ["continue", "covered", "partial", "blocked"]
    },
    summary: { type: "string" }
  }
};

function mechanicsIssue(id, title, evidence, remediation) {
  return {
    id,
    classification: "test-mechanics",
    title,
    evidence: safeDetail(evidence).slice(0, 500),
    remediation
  };
}

function safeDetail(value) {
  return cleanDiagnosticText(value).replace(
    /https?:\/\/[^\s"'<>]+/g,
    (candidate) => diagnosticUrl(candidate).url
  );
}

function normalizeText(value, limit) {
  return String(value || "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function hasProhibitedSemantics(element) {
  const values = [
    element.label,
    element.name,
    element.ariaLabel,
    element.href
  ];
  return (
    element.formHasPassword ||
    AUTHENTICATION_CONTEXT.test(element.formAction || "") ||
    AUTHENTICATION_CONTEXT.test(element.pageUrl || "") ||
    values.some((value) => {
      if (!value) return false;
      try {
        return PROHIBITED_ACTION_TEXT.test(decodeURIComponent(value));
      } catch {
        return PROHIBITED_ACTION_TEXT.test(value);
      }
    })
  );
}

function elementAction(element, authorizedOrigin) {
  if (element.disabled || hasProhibitedSemantics(element)) return null;
  if (element.formAction) {
    try {
      if (new URL(element.formAction).origin !== authorizedOrigin) return null;
    } catch {
      return null;
    }
  }
  if (element.tag === "a") {
    try {
      return new URL(element.href).origin === authorizedOrigin ? "visit" : null;
    } catch {
      return null;
    }
  }
  if (element.tag === "textarea") return "fill";
  if (element.tag === "input" && SAFE_FILL_TYPES.has(element.type)) {
    return "fill";
  }
  if (element.tag === "select") return "select";
  if (
    element.tag === "button" &&
    element.type === "button" &&
    READ_ONLY_BUTTON_TEXT.test(
      element.label || element.ariaLabel || element.name || ""
    )
  ) {
    return "click";
  }
  return null;
}

async function replayLocator(page, element) {
  const candidates = [
    ...(element.id
      ? [{ kind: "css", selector: `${element.tag}[id=${JSON.stringify(element.id)}]` }]
      : []),
    ...(element.name
      ? [
          {
            kind: "css",
            selector: `${element.tag}[name=${JSON.stringify(element.name)}]`
          }
        ]
      : []),
    ...(element.ariaLabel
      ? [{ kind: "role", role: element.role, name: element.ariaLabel }]
      : []),
    ...(element.label
      ? [{ kind: "role", role: element.role, name: element.label }]
      : []),
    { kind: "css", selector: element.tag }
  ];
  for (const candidate of candidates) {
    const locator =
      candidate.kind === "css"
        ? page.locator(candidate.selector)
        : page.getByRole(candidate.role, { name: candidate.name, exact: true });
    let refs;
    try {
      refs = await locator.evaluateAll((elements) =>
        elements.map((candidateElement) =>
          candidateElement.getAttribute("data-yellowbird-agent-ref")
        )
      );
    } catch {
      continue;
    }
    const ordinal = refs.indexOf(element.ref);
    if (ordinal >= 0) {
      return { ...candidate, ordinal, matchCount: refs.length };
    }
  }
  return null;
}

function syntheticValue(element) {
  if (element.type === "email" || /\bemail\b/i.test(element.label)) {
    return "yellowbird@example.test";
  }
  if (element.type === "number") return "1";
  if (element.type === "tel") return "5550100";
  if (element.type === "url" || /\burl\b/i.test(element.label)) {
    return "https://example.test/product";
  }
  if (element.type === "search") return "YellowBird test search";
  return "YellowBird synthetic test value";
}

async function snapshotPage(page, authorizedOrigin) {
  const raw = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    bodyText: document.body?.innerText || "",
    elements: [
      ...document.querySelectorAll("a[href], button, input, textarea, select")
    ]
      .slice(0, 120)
      .map((element, index) => {
        const ref = `element-${index + 1}`;
        element.setAttribute("data-yellowbird-agent-ref", ref);
        const tag = element.tagName.toLowerCase();
        const label =
          element.getAttribute("aria-label") ||
          element.labels?.[0]?.querySelector("span")?.textContent ||
          element.labels?.[0]?.innerText ||
          element.getAttribute("placeholder") ||
          element.textContent ||
          element.getAttribute("name") ||
          tag;
        const role =
          tag === "a"
            ? "link"
            : tag === "button"
              ? "button"
              : tag === "select"
                ? "combobox"
                : tag === "input" && element.type === "number"
                  ? "spinbutton"
                  : "textbox";
        const form = element.form || element.closest("form");
        return {
          ref,
          tag,
          role,
          label,
          href: element.href || null,
          type: element.type || null,
          id: element.getAttribute("id"),
          name: element.getAttribute("name"),
          ariaLabel: element.getAttribute("aria-label"),
          disabled: Boolean(element.disabled),
          formAction: form?.action || null,
          formHasPassword: Boolean(form?.querySelector('input[type="password"]')),
          options:
            tag === "select"
              ? [...element.options].map((option) => ({
                  label: option.textContent || option.value,
                  value: option.value
                }))
              : []
        };
      })
  }));
  const elements = [];
  for (const rawElement of raw.elements) {
    const action = elementAction(
      { ...rawElement, pageUrl: raw.url },
      authorizedOrigin
    );
    if (!action) continue;
    let href = rawElement.href;
    if (action === "visit") {
      const url = new URL(href);
      url.hash = "";
      href = url.href;
    }
    const element = {
      ref: rawElement.ref,
      action,
      tag: rawElement.tag,
      role: rawElement.role,
      label: normalizeText(rawElement.label, 160),
      href,
      type: rawElement.type,
      options: rawElement.options.map((option) => ({
        label: normalizeText(option.label, 120),
        value: String(option.value).slice(0, 200)
      })),
      runtimeSelector: `[data-yellowbird-agent-ref=${JSON.stringify(rawElement.ref)}]`
    };
    element.locator = await replayLocator(page, {
      ...rawElement,
      label: element.label
    });
    if (!element.locator) continue;
    element.key = [raw.url, rawElement.ref, action].join("|");
    elements.push(element);
  }
  return {
    url: raw.url,
    title: normalizeText(raw.title, 200),
    bodyText: normalizeText(raw.bodyText, 8_000),
    elements: elements.slice(0, 60)
  };
}

function validateAction(value) {
  if (!value || typeof value !== "object") {
    throw new Error("agent output was not an object");
  }
  if (!["act", "finish"].includes(value.action)) {
    throw new Error("agent output used an unsupported action");
  }
  if (!["continue", "covered", "partial", "blocked"].includes(value.coverage)) {
    throw new Error("agent output used an unsupported coverage state");
  }
  if (typeof value.rationale !== "string" || typeof value.summary !== "string") {
    throw new Error("agent output omitted rationale or summary text");
  }
  if (
    value.action === "act" &&
    (typeof value.elementRef !== "string" || !value.elementRef)
  ) {
    throw new Error("agent action omitted elementRef");
  }
  if (value.action === "finish" && value.coverage === "continue") {
    throw new Error("agent finish action retained continue coverage");
  }
  return value;
}

function availableElements(snapshot, usedActionKeys, visited) {
  return snapshot.elements
    .filter((element) => !usedActionKeys.has(element.key))
    .filter((element) => element.action !== "visit" || !visited.has(element.href))
    .map(({ runtimeSelector, locator, key, action, ...element }) => ({
      ...element,
      allowedAction: action
    }));
}

function deterministicVisitFallback(elements) {
  const visits = elements.filter((element) => element.allowedAction === "visit");
  const primarySetupVisits = visits.filter((element) =>
    /\b(?:begin|new|onboard|setup|start)\b/i.test(element.label || "")
  );
  if (primarySetupVisits.length === 1) return primarySetupVisits[0];
  return visits.length === 1 ? visits[0] : null;
}

function plannerMessages({
  intent,
  snapshot,
  elements,
  visited,
  stepsTaken,
  maxSteps,
  requireAction,
  feedback
}) {
  return [
    {
      role: "system",
      content: `You are YellowBird's bounded safe-interaction web test planner. Choose action act with exactly one supplied elementRef, or choose finish. YellowBird, not you, enforces each element's allowedAction. Set value to null for fill actions because YellowBird supplies a deterministic synthetic value. For select actions, value must exactly match a supplied option value. You may not invent elements or URLs, use real personal data or credentials, submit forms, mutate server state, authenticate, change expected results, or report product bugs. Prefer supplied read-only setup or navigation paths over existing-record detail pages when the owner asks to assess a basic user flow. An element supplied with allowedAction visit is a YellowBird-authorized read-only GET navigation; opening a path labeled New, Start, or Setup observes a form and does not submit it. Visiting a supplied link is a browser action. When requireAtLeastOneAction is true, finish is invalid until you select an authorized action. When the owner asks to assess, review, or inspect a basic flow, loading the relevant primary route and observing its controls may support covered coverage; preserve partial coverage whenever any requested area remains unverified. Safely exercising fields can add coverage but is not required unless the intent asks about form interaction. If the intent explicitly asks to create, submit, mutate, authenticate, or complete another prohibited effect, finish with partial or blocked coverage. Product findings require browser evidence outside your output.`
    },
    {
      role: "user",
      content: JSON.stringify({
        intent,
        policy: {
          mode: "safe-same-origin-interaction",
          stepsTaken,
          maxSteps,
          requireAtLeastOneAction: requireAction,
          syntheticValuesOnly: true,
          formSubmissionAllowed: false
        },
        page: {
          url: snapshot.url,
          title: snapshot.title,
          text: snapshot.bodyText,
          availableElements: elements
        },
        visited: [...visited],
        ...(feedback ? { correction: feedback } : {})
      })
    }
  ];
}

function completedExploration({
  coverage,
  summary,
  steps,
  pages,
  issue,
  verification = null
}) {
  const completed = coverage === "covered";
  return {
    status: completed ? "completed" : "inconclusive",
    coverage,
    summary,
    steps,
    pages,
    verification,
    issue: completed
      ? null
      : issue || mechanicsIssue(
          "agent-intent-not-fully-covered",
          "The bounded agent could not fully cover the requested intent.",
          summary || `Agent coverage ended as ${coverage}`,
          "Grant a suitable deterministic scenario or refine the intent to fit safe, non-submitting browser interaction."
        )
  };
}

function normalizedObservedUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function verifyOwnedCoverageProfile(intent, steps, pages) {
  const initialInterfaceFlow =
    /^\s*(?:assess|evaluate|inspect|review)(?:\s+the)?\s+initial\s+interface\s+and(?:\s+the)?\s+basic\s+user\s+flow\s*[.!]?\s*$/i.test(
      intent
    );
  if (!initialInterfaceFlow || hasProhibitedSemantics({ label: intent })) {
    return null;
  }
  const passedVisits = steps.filter(
    (step) => step.action === "visit" && step.status === "passed"
  );
  const passedVisit =
    passedVisits.find((step) => {
      const source = normalizedObservedUrl(step.sourceUrl);
      const destination = normalizedObservedUrl(step.url);
      return (
        source &&
        destination &&
        source !== destination &&
        step.destinationControlCount > 0
      );
    }) || passedVisits[0];
  const visitSource = normalizedObservedUrl(passedVisit?.sourceUrl);
  const visitDestination = normalizedObservedUrl(passedVisit?.url);
  const criteria = [
    {
      id: "initial-page-observed",
      satisfied: pages.length >= 1
    },
    {
      id: "primary-route-visited",
      satisfied: Boolean(passedVisit)
    },
    {
      id: "distinct-destination-observed",
      satisfied:
        Boolean(passedVisit) &&
        Boolean(visitSource) &&
        Boolean(visitDestination) &&
        visitSource !== visitDestination
    },
    {
      id: "destination-controls-observed",
      satisfied:
        Boolean(passedVisit) && passedVisit.destinationControlCount > 0
    },
    {
      id: "authorized-actions-passed",
      satisfied:
        steps.length > 0 && steps.every((step) => step.status === "passed")
    }
  ];
  const satisfied = criteria.every((criterion) => criterion.satisfied);
  return {
    profile: "initial-interface-basic-flow.v1",
    authority: "yellowbird-observed-criteria",
    satisfied,
    criteria,
    summary: satisfied
      ? "YellowBird observed the initial page, visited a distinct authorized setup route, and inventoried safe controls on the destination."
      : "YellowBird could not satisfy every observed criterion for the initial-interface basic-flow profile."
  };
}

function normalizedCoverage(intent, plannerCoverage, steps) {
  if (hasProhibitedSemantics({ label: intent }) && plannerCoverage === "covered") {
    return steps.some((step) => step.status === "passed") ? "partial" : "blocked";
  }
  if (
    plannerCoverage === "covered" &&
    !steps.some((step) => step.status === "passed")
  ) {
    return "blocked";
  }
  return plannerCoverage;
}

export async function exploreIntentWithEngine({
  page,
  intent,
  authorizedOrigin,
  engine,
  maxSteps,
  timeoutMs,
  record,
  actionPolicy = null
}) {
  const steps = [];
  const pages = [];
  const visited = new Set();
  const usedActionKeys = new Set();
  let feedback = "";
  let snapshot;

  try {
    snapshot = await snapshotPage(page, authorizedOrigin);
    visited.add(new URL(snapshot.url).href);
    pages.push({
      url: snapshot.url,
      title: snapshot.title,
      authorizedControlCount: snapshot.elements.length
    });
  } catch (error) {
    return completedExploration({
      coverage: "blocked",
      summary: "The initial page could not be converted into an agent snapshot.",
      steps,
      pages,
      issue: mechanicsIssue(
        "agent-snapshot-failed",
        "YellowBird could not prepare the page for intent exploration.",
        error?.message || error,
        "Review the page runtime and diagnostics, then rerun or provide a deterministic scenario."
      )
    });
  }

  const initialElements = availableElements(snapshot, usedActionKeys, visited);
  const intentRequiresInteraction =
    /\b(?:flow|form|interaction|journey|navigate|workflow)\b/i.test(intent);
  if (intentRequiresInteraction && initialElements.length === 0) {
    return completedExploration({
      coverage: "blocked",
      summary:
        "The requested flow could not begin because the page exposed no authorized interaction.",
      steps,
      pages,
      issue: mechanicsIssue(
        "agent-no-authorized-actions",
        "No authorized browser action was available for the requested flow.",
        "The initial page exposed no eligible exact-origin link or bounded safe control.",
        "Provide an owner-declared scenario or make a safe navigation control available."
      )
    });
  }
  const requireAction = initialElements.length > 0;
  const maxPlanningRounds = maxSteps + 4;
  for (let round = 1; round <= maxPlanningRounds; round += 1) {
    const mustFinish = steps.length >= maxSteps;
    const elements = mustFinish
      ? []
      : availableElements(snapshot, usedActionKeys, visited);
    record("debug", "agent.planning.started", "Planning the next bounded action", {
      round,
      stepsTaken: steps.length,
      maxSteps
    });
    let proposed;
    try {
      const response = await engine.completeStructured({
        purpose: "safe_interaction_exploration",
        messages: plannerMessages({
          intent,
          snapshot,
          elements,
          visited,
          stepsTaken: steps.length,
          maxSteps,
          requireAction: requireAction && steps.length === 0,
          feedback: mustFinish
            ? "The interaction budget is exhausted. Finish now and assess coverage truthfully."
            : feedback
        }),
        schema: ACTION_SCHEMA,
        maxTokens: 512
      });
      proposed = validateAction(response.output);
    } catch (error) {
      const detail = safeDetail(error?.message || error);
      record("error", "agent.planning.failed", "The agent did not return a valid action", {
        round,
        detail
      });
      return completedExploration({
        coverage: "blocked",
        summary: "The configured engine did not return a valid exploration action.",
        steps,
        pages,
        issue: mechanicsIssue(
          "agent-output-invalid",
          "The agent engine returned an invalid exploration action.",
          detail,
          "Run the engine capability probe, choose a stronger compatible model, or provide a deterministic scenario."
        )
      });
    }
    record("info", "agent.planning.completed", "The agent proposed a bounded action", {
      round,
      action: proposed.action,
      coverage: proposed.coverage
    });

    if (
      proposed.action === "finish" &&
      requireAction &&
      steps.length === 0 &&
      elements.length
    ) {
      const fallback = round > 1 ? deterministicVisitFallback(elements) : null;
      if (fallback) {
        proposed = {
          action: "act",
          elementRef: fallback.ref,
          value: null,
          rationale:
            "YellowBird selected the only unambiguous authorized setup navigation after the planner attempted to finish before required exploration.",
          coverage: "continue",
          summary: ""
        };
        record(
          "warn",
          "agent.planning.corrected",
          "Applied a deterministic authorized navigation fallback",
          { round, elementRef: fallback.ref, action: fallback.allowedAction }
        );
      } else {
        feedback =
          "Finish is invalid because no browser action was exercised. Choose action act and select one supplied allowedAction visit, preferring a New, Start, or Setup path that materially assesses the requested flow.";
        continue;
      }
    }
    if (proposed.action === "finish") {
      const verification = verifyOwnedCoverageProfile(
        intent,
        steps,
        pages
      );
      const coverage = verification?.satisfied
        ? "covered"
        : normalizedCoverage(intent, proposed.coverage, steps);
      const summary = verification?.satisfied
        ? verification.summary
        : normalizeText(proposed.summary, 1_000);
      record("info", "agent.completed", "Intent exploration completed", {
        coverage,
        plannerCoverage: proposed.coverage,
        coverageAuthority: verification?.satisfied
          ? verification.authority
          : "model-guided",
        coverageProfile: verification?.profile || null,
        visitedPageCount: pages.length,
        stepCount: steps.length
      });
      return completedExploration({
        coverage,
        summary,
        steps,
        pages,
        verification
      });
    }
    if (mustFinish) {
      return completedExploration({
        coverage: "partial",
        summary: "The agent exhausted its interaction budget before completing coverage.",
        steps,
        pages,
        issue: mechanicsIssue(
          "agent-step-budget-exhausted",
          "The agent exhausted its bounded exploration budget.",
          `${steps.length} interaction(s) completed`,
          "Increase --max-agent-steps or provide a deterministic scenario for the required flow."
        )
      });
    }

    const selected = snapshot.elements.find(
      (element) =>
        element.ref === proposed.elementRef &&
        !usedActionKeys.has(element.key) &&
        (element.action !== "visit" || !visited.has(element.href))
    );
    if (!selected) {
      feedback = `The requested elementRef ${JSON.stringify(proposed.elementRef)} is unavailable. Choose exactly one supplied element reference.`;
      if (round < maxPlanningRounds) continue;
      return completedExploration({
        coverage: "blocked",
        summary: "The agent repeatedly selected an unavailable action.",
        steps,
        pages,
        issue: mechanicsIssue(
          "agent-action-invalid",
          "The agent selected an action outside the authorized page snapshot.",
          feedback,
          "Choose a model that follows structured action constraints or provide a deterministic scenario."
        )
      });
    }
    const action = selected.action;
    if (
      action === "select" &&
      (typeof proposed.value !== "string" ||
        !proposed.value ||
        proposed.value.length > 500)
    ) {
      feedback = `${selected.ref} requires one of its supplied option values.`;
      continue;
    }
    if (
      action === "select" &&
      !selected.options.some((option) => option.value === proposed.value)
    ) {
      feedback = `The selected option value is unavailable. Choose an exact value supplied for ${selected.ref}.`;
      continue;
    }

    const startedAt = Date.now();
    const id = `agent-${action}-${steps.length + 1}`;
    const actionValue =
      action === "fill"
        ? syntheticValue(selected)
        : action === "select"
          ? proposed.value
          : null;
    const sourceUrl = page.url();
    record("info", "agent.action.started", "Executing an authorized safe interaction", {
      id,
      action,
      ...(selected.href ? diagnosticUrl(selected.href) : {})
    });
    let actionPolicyStarted = false;
    try {
      await actionPolicy?.begin({
        id,
        action,
        requestedUrl: selected.href || null
      });
      actionPolicyStarted = Boolean(actionPolicy);
      let response = null;
      const locator = page.locator(selected.runtimeSelector);
      if (action === "visit") {
        response = await page.goto(selected.href, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs
        });
        visited.add(selected.href);
      } else if (action === "fill") {
        await locator.fill(actionValue);
      } else if (action === "select") {
        await locator.selectOption(actionValue);
      } else if (action === "click") {
        await locator.click();
      }
      await page.waitForTimeout(150);
      const actionPageUrl = page.url();
      snapshot = await snapshotPage(page, authorizedOrigin);
      if (!pages.some((entry) => entry.url === snapshot.url)) {
        pages.push({
          url: snapshot.url,
          title: snapshot.title,
          authorizedControlCount: snapshot.elements.length
        });
      }
      usedActionKeys.add(selected.key);
      const step = {
        id,
        action,
        status: response && response.status() >= 400 ? "failed" : "passed",
        sourceUrl,
        requestedUrl: selected.href || null,
        url: actionPageUrl,
        title: snapshot.title,
        destinationControlCount: snapshot.elements.length,
        httpStatus: response?.status() ?? null,
        evidence:
          response && response.status() >= 400
            ? `Navigation returned HTTP ${response.status()}`
            : "Authorized safe browser interaction completed",
        rationale: normalizeText(proposed.rationale, 500),
        value: actionValue,
        locator: selected.locator,
        durationMs: Date.now() - startedAt
      };
      steps.push(step);
      record(
        step.status === "passed" ? "info" : "error",
        "agent.action.completed",
        step.evidence,
        {
          id: step.id,
          action: step.action,
          status: step.status,
          httpStatus: step.httpStatus,
          durationMs: step.durationMs,
          ...diagnosticUrl(actionPageUrl)
        }
      );
      feedback = "";
    } catch (error) {
      const detail = safeDetail(error?.message || error);
      record("error", "agent.action.failed", "The authorized interaction failed", {
        id,
        action,
        detail
      });
      steps.push({
        id,
        action,
        status: "invalid",
        sourceUrl,
        requestedUrl: selected.href || null,
        url: page.url(),
        title: "",
        destinationControlCount: null,
        httpStatus: null,
        evidence: detail,
        rationale: normalizeText(proposed.rationale, 500),
        value: actionValue,
        locator: selected.locator,
        durationMs: Date.now() - startedAt
      });
      return completedExploration({
        coverage: "blocked",
        summary: "An agent-selected safe interaction could not be completed.",
        steps,
        pages,
        issue: mechanicsIssue(
          "agent-action-failed",
          "An authorized agent interaction could not be completed.",
          detail,
          "Review the selected control and diagnostics or provide a deterministic scenario."
        )
      });
    } finally {
      if (actionPolicyStarted) await actionPolicy.end();
    }
  }

  return completedExploration({
    coverage: "partial",
    summary: "The agent did not complete within its planning-round budget.",
    steps,
    pages,
    issue: mechanicsIssue(
      "agent-planning-budget-exhausted",
      "The agent exhausted its planning-round budget.",
      `${steps.length} interaction(s) completed`,
      "Use a more capable compatible model or provide a deterministic scenario."
    )
  });
}
