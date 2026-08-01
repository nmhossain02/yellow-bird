import { cleanDiagnosticText, diagnosticUrl } from "./diagnostics.js";

const SAFE_FILL_TYPES = new Set([
  "email",
  "number",
  "search",
  "tel",
  "text",
  "url"
]);
export const PROHIBITED_AGENT_ACTION_PATTERN = String.raw`(?:^|[^a-z0-9])(?:accept|activate|add|apply|approve|auth(?:enticate|entication|orize|orization)?|buy|check[ -]?(?:now|out)|compile|confirm|create|delete|log[ -]?(?:in|out)|order|pay|pause|purchase|register|reject|remove|resume|run|save|sign[ -]?(?:in|out|up)|submit|subscribe|update|upload)(?=$|[^a-z0-9])`;
const PROHIBITED_ACTION_TEXT = new RegExp(
  PROHIBITED_AGENT_ACTION_PATTERN,
  "i"
);
const READ_ONLY_BUTTON_TEXT =
  /^\s*(?:collapse|details?|expand|hide|inspect|preview|reveal|show|toggle|view)\b/i;
const SNAPSHOT_LIMITS = Object.freeze({
  totalCharacters: 50_000,
  bodyText: 12_000,
  elementCount: 120,
  fieldText: 400,
  url: 4_096,
  optionCount: 40,
  optionLabel: 240,
  optionValue: 200,
  labelCount: 20,
  labelledByCount: 20,
  traversalNodeCount: 5_000
});
export const RENDERED_TEXT_LIMITS = Object.freeze({
  bodyText: SNAPSHOT_LIMITS.bodyText,
  evidenceBodyText: 20_000,
  plannerBodyText: 8_000,
  traversalNodeCount: SNAPSHOT_LIMITS.traversalNodeCount
});

export function browserRenderedTextSnapshot({
  maximum,
  traversalNodeCount
}) {
  const hiddenState = new WeakMap();
  const locallyHidden = (element) => {
    if (
      !element.isConnected ||
      element.hidden ||
      element.inert ||
      element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" ||
      ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(element.tagName) ||
      (element.tagName === "INPUT" &&
        String(element.type).toLowerCase() === "hidden")
    ) {
      return true;
    }
    try {
      const style = globalThis.getComputedStyle(element);
      return (
        style.display === "none" ||
        ["hidden", "collapse"].includes(style.visibility) ||
        style.contentVisibility === "hidden" ||
        Number(style.opacity) === 0
      );
    } catch {
      return true;
    }
  };
  const hiddenInTree = (element) => {
    if (!element) return true;
    if (hiddenState.has(element)) return hiddenState.get(element);
    const ancestry = [];
    let current = element;
    while (current && !hiddenState.has(current)) {
      if (ancestry.length >= traversalNodeCount) return true;
      ancestry.push(current);
      current = current.parentElement;
    }
    let hidden = current ? hiddenState.get(current) : false;
    for (let index = ancestry.length - 1; index >= 0; index -= 1) {
      const candidate = ancestry[index];
      hidden = hidden || locallyHidden(candidate);
      hiddenState.set(candidate, hidden);
    }
    return hiddenState.get(element);
  };
  const hiddenByClosedContainer = (element) => {
    let inspected = 0;
    let current = element;
    while (current) {
      inspected += 1;
      if (inspected > traversalNodeCount) return true;
      if (current.tagName === "DIALOG" && !current.open) return true;
      if (
        current.hasAttribute("popover") &&
        !current.matches(":popover-open")
      ) {
        return true;
      }
      const parent = current.parentElement;
      if (parent?.tagName === "DETAILS" && !parent.open) {
        let summary = parent.firstElementChild;
        while (summary && summary.tagName !== "SUMMARY") {
          inspected += 1;
          if (inspected > traversalNodeCount) return true;
          summary = summary.nextElementSibling;
        }
        if (!summary || current !== summary) return true;
      }
      current = parent;
    }
    return false;
  };
  const positiveArea = (rect) =>
    Number.isFinite(rect?.width) &&
    Number.isFinite(rect?.height) &&
    rect.width > 0 &&
    rect.height > 0;
  const remainsVisibleThroughClipping = (rect, element) => {
    let visibleRect = {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left
    };
    let inspected = 0;
    let current = element;
    while (current) {
      inspected += 1;
      if (inspected > traversalNodeCount) return false;
      let style;
      try {
        style = globalThis.getComputedStyle(current);
      } catch {
        return false;
      }
      if (
        (style.clip && style.clip !== "auto") ||
        (style.clipPath && style.clipPath !== "none") ||
        (style.maskImage && style.maskImage !== "none") ||
        (style.webkitMaskImage && style.webkitMaskImage !== "none") ||
        /opacity\(\s*0(?:\.0*)?\s*\)/i.test(style.filter || "")
      ) {
        return false;
      }
      if (
        [style.overflowX, style.overflowY].some((value) =>
          ["auto", "clip", "hidden", "scroll"].includes(value)
        )
      ) {
        const clippingRect = current.getBoundingClientRect();
        if (!positiveArea(clippingRect)) return false;
        visibleRect = {
          top: Math.max(visibleRect.top, clippingRect.top),
          right: Math.min(visibleRect.right, clippingRect.right),
          bottom: Math.min(visibleRect.bottom, clippingRect.bottom),
          left: Math.max(visibleRect.left, clippingRect.left)
        };
        if (
          visibleRect.right <= visibleRect.left ||
          visibleRect.bottom <= visibleRect.top
        ) {
          return false;
        }
      }
      current = current.parentElement;
    }
    return true;
  };
  const visibleByApi = (element) => {
    if (typeof element.checkVisibility !== "function") return true;
    try {
      return element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true
      });
    } catch {
      return false;
    }
  };
  const renderedTextNode = (textNode) => {
    const parent = textNode?.parentElement;
    if (
      !parent ||
      hiddenInTree(parent) ||
      hiddenByClosedContainer(parent) ||
      !visibleByApi(parent)
    ) {
      return false;
    }
    try {
      const style = globalThis.getComputedStyle(parent);
      if (
        style.fontSize === "0px" ||
        style.color === "transparent" ||
        /rgba\([^)]*,\s*0\s*\)$/i.test(style.color)
      ) {
        return false;
      }
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const rect = range.getBoundingClientRect();
      range.detach();
      return (
        positiveArea(rect) && remainsVisibleThroughClipping(rect, parent)
      );
    } catch {
      return false;
    }
  };
  const root = document.body;
  if (!root || maximum <= 0 || hiddenInTree(root)) return "";
  const chunks = [];
  let characters = 0;
  let visitedNodes = 0;
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
  );
  while (characters < maximum && visitedNodes < traversalNodeCount) {
    const node = walker.nextNode();
    if (!node) break;
    visitedNodes += 1;
    if (node.nodeType === Node.ELEMENT_NODE) {
      hiddenInTree(node);
      continue;
    }
    if (!renderedTextNode(node)) continue;
    const text = node.nodeValue || "";
    if (!text) continue;
    const separatorLength = chunks.length ? 1 : 0;
    const available = maximum - characters - separatorLength;
    if (available <= 0) break;
    chunks.push(text.slice(0, available));
    characters += separatorLength + Math.min(text.length, available);
  }
  return chunks.join(" ");
}
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
  return cleanDiagnosticText(value)
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function decodeAgentText(value) {
  let decoded = String(value ?? "");
  const maximumPasses = decoded.length + 1;
  for (let count = 0; count < maximumPasses; count += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return null;
}

function canonicalizeAgentSemanticText(value) {
  return String(value ?? "")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replaceAll(/([A-Za-z])([0-9])/g, "$1 $2")
    .replaceAll(/([0-9])([A-Za-z])/g, "$1 $2");
}

function hasProhibitedAgentText(value) {
  const decoded = decodeAgentText(value);
  return (
    decoded === null ||
    PROHIBITED_ACTION_TEXT.test(canonicalizeAgentSemanticText(decoded))
  );
}

function decodeAgentUrlText(url) {
  const components = [
    decodeAgentText(url.pathname),
    decodeAgentText(url.search.replaceAll("+", " ")),
    decodeAgentText(url.hash)
  ];
  return components.some((component) => component === null)
    ? null
    : components.join("");
}

export function isAgentUrlAllowed(value, authorizedOrigin) {
  try {
    const url = new URL(value);
    const decoded = decodeAgentUrlText(url);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin === authorizedOrigin &&
      !url.username &&
      !url.password &&
      decoded !== null &&
      !PROHIBITED_ACTION_TEXT.test(canonicalizeAgentSemanticText(decoded))
    );
  } catch {
    return false;
  }
}

export function isAgentRouteAuthorized(value, authorizedRoutes) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const route of authorizedRoutes) {
      if (route.endsWith("*")) {
        if (url.href.startsWith(route.slice(0, -1))) return true;
      } else if (route === url.href) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function hasProhibitedSemantics(element) {
  const values = [
    element.label,
    element.name,
    element.ariaLabel,
    element.href,
    element.formAction,
    element.pageUrl,
    element.placeholder,
    element.id,
    ...(element.labelTexts || []),
    ...(element.options || []).flatMap((option) => [option.label, option.value])
  ];
  return (
    element.formHasPassword ||
    values.some((value) => {
      if (!value) return false;
      return hasProhibitedAgentText(value);
    })
  );
}

function elementAction(element, authorizedOrigin, authorizedNavigationRoutes) {
  if (element.disabled || hasProhibitedSemantics(element)) return null;
  if (element.formAction) {
    if (!isAgentUrlAllowed(element.formAction, authorizedOrigin)) return null;
  }
  if (element.tag === "a") {
    return isAgentUrlAllowed(element.href, authorizedOrigin) &&
      isAgentRouteAuthorized(element.href, authorizedNavigationRoutes)
      ? "visit"
      : null;
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

async function snapshotPage(
  page,
  authorizedOrigin,
  authorizedNavigationRoutes,
  expectedDestinationControls
) {
  const bodyText = await page.evaluate(browserRenderedTextSnapshot, {
    maximum: SNAPSHOT_LIMITS.bodyText,
    traversalNodeCount: SNAPSHOT_LIMITS.traversalNodeCount
  });
  const raw = await page.evaluate(({ bodyTextCharacters, limits, prohibitedPattern }) => {
    let remainingCharacters = limits.totalCharacters - bodyTextCharacters;
    const prohibited = new RegExp(prohibitedPattern, "i");
    const canonicalizeSemanticText = (value) =>
      String(value ?? "")
        .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replaceAll(/([A-Za-z])([0-9])/g, "$1 $2")
        .replaceAll(/([0-9])([A-Za-z])/g, "$1 $2");
    const decodeText = (value) => {
      let decoded = String(value ?? "");
      const maximumPasses = decoded.length + 1;
      for (let count = 0; count < maximumPasses; count += 1) {
        let next;
        try {
          next = decodeURIComponent(decoded);
        } catch {
          return null;
        }
        if (next === decoded) return decoded;
        decoded = next;
      }
      return null;
    };
    const hasProhibitedText = (value) => {
      if (!value) return false;
      const decoded = decodeText(value);
      return (
        decoded === null || prohibited.test(canonicalizeSemanticText(decoded))
      );
    };
    const takeText = (value, maximum) => {
      const text = String(value ?? "");
      const length = Math.min(text.length, maximum, remainingCharacters);
      remainingCharacters -= length;
      return text.slice(0, length);
    };
    const hiddenState = new WeakMap();
    const isLocallyHidden = (element) => {
      if (
        !element.isConnected ||
        element.hidden ||
        element.inert ||
        element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" ||
        ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(element.tagName) ||
        (element.tagName === "INPUT" &&
          String(element.type).toLowerCase() === "hidden")
      ) {
        return true;
      }
      try {
        const style = window.getComputedStyle(element);
        return (
          style.display === "none" ||
          ["hidden", "collapse"].includes(style.visibility) ||
          style.contentVisibility === "hidden" ||
          Number(style.opacity) === 0
        );
      } catch {
        return true;
      }
    };
    const isHiddenInTree = (element) => {
      if (!element) return true;
      if (hiddenState.has(element)) return hiddenState.get(element);
      const ancestry = [];
      let current = element;
      while (current && !hiddenState.has(current)) {
        if (ancestry.length >= limits.traversalNodeCount) return true;
        ancestry.push(current);
        current = current.parentElement;
      }
      let hidden = current ? hiddenState.get(current) : false;
      for (let index = ancestry.length - 1; index >= 0; index -= 1) {
        const candidate = ancestry[index];
        hidden = hidden || isLocallyHidden(candidate);
        hiddenState.set(candidate, hidden);
      }
      return hiddenState.get(element);
    };
    const isHiddenByClosedContainer = (element) => {
      let inspected = 0;
      let current = element;
      while (current) {
        inspected += 1;
        if (inspected > limits.traversalNodeCount) return true;
        if (current.tagName === "DIALOG" && !current.open) return true;
        if (
          current.hasAttribute("popover") &&
          !current.matches(":popover-open")
        ) {
          return true;
        }
        const parent = current.parentElement;
        if (parent?.tagName === "DETAILS" && !parent.open) {
          let summary = parent.firstElementChild;
          while (summary && summary.tagName !== "SUMMARY") {
            inspected += 1;
            if (inspected > limits.traversalNodeCount) return true;
            summary = summary.nextElementSibling;
          }
          if (!summary || current !== summary) {
            return true;
          }
        }
        current = parent;
      }
      return false;
    };
    const positiveArea = (rect) =>
      Number.isFinite(rect?.width) &&
      Number.isFinite(rect?.height) &&
      rect.width > 0 &&
      rect.height > 0;
    const remainsVisibleThroughClipping = (rect, element) => {
      let visibleRect = {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left
      };
      let inspected = 0;
      let current = element;
      while (current) {
        inspected += 1;
        if (inspected > limits.traversalNodeCount) return false;
        let style;
        try {
          style = window.getComputedStyle(current);
        } catch {
          return false;
        }
        if (
          (style.clip && style.clip !== "auto") ||
          (style.clipPath && style.clipPath !== "none") ||
          (style.maskImage && style.maskImage !== "none") ||
          (style.webkitMaskImage && style.webkitMaskImage !== "none") ||
          /opacity\(\s*0(?:\.0*)?\s*\)/i.test(style.filter || "")
        ) {
          return false;
        }
        if (
          [style.overflowX, style.overflowY].some((value) =>
            ["auto", "clip", "hidden", "scroll"].includes(value)
          )
        ) {
          const clippingRect = current.getBoundingClientRect();
          if (!positiveArea(clippingRect)) {
            return false;
          }
          visibleRect = {
            top: Math.max(visibleRect.top, clippingRect.top),
            right: Math.min(visibleRect.right, clippingRect.right),
            bottom: Math.min(visibleRect.bottom, clippingRect.bottom),
            left: Math.max(visibleRect.left, clippingRect.left)
          };
          if (
            visibleRect.right <= visibleRect.left ||
            visibleRect.bottom <= visibleRect.top
          ) {
            return false;
          }
        }
        current = current.parentElement;
      }
      return true;
    };
    const passesVisibilityApi = (element) => {
      if (typeof element.checkVisibility !== "function") return true;
      try {
        return element.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true
        });
      } catch {
        return false;
      }
    };
    const isRenderedElement = (element) => {
      if (
        !element ||
        isHiddenInTree(element) ||
        isHiddenByClosedContainer(element) ||
        !passesVisibilityApi(element)
      ) {
        return false;
      }
      try {
        const rect = element.getBoundingClientRect();
        return (
          positiveArea(rect) &&
          remainsVisibleThroughClipping(rect, element.parentElement)
        );
      } catch {
        return false;
      }
    };
    const isRenderedTextNode = (textNode) => {
      const parent = textNode?.parentElement;
      if (
        !parent ||
        isHiddenInTree(parent) ||
        isHiddenByClosedContainer(parent) ||
        !passesVisibilityApi(parent)
      ) {
        return false;
      }
      try {
        const style = window.getComputedStyle(parent);
        if (
          style.fontSize === "0px" ||
          style.color === "transparent" ||
          /rgba\([^)]*,\s*0\s*\)$/i.test(style.color)
        ) {
          return false;
        }
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const rect = range.getBoundingClientRect();
        range.detach();
        return positiveArea(rect) && remainsVisibleThroughClipping(rect, parent);
      } catch {
        return false;
      }
    };
    const boundedNodeText = (root, maximum) => {
      if (!root || maximum <= 0 || isHiddenInTree(root)) return "";
      const chunks = [];
      let characters = 0;
      let visitedNodes = 0;
      const textWalker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
      );
      while (
        characters < maximum &&
        visitedNodes < limits.traversalNodeCount
      ) {
        const textNode = textWalker.nextNode();
        if (!textNode) break;
        visitedNodes += 1;
        if (textNode.nodeType === Node.ELEMENT_NODE) {
          isHiddenInTree(textNode);
          continue;
        }
        if (!isRenderedTextNode(textNode)) continue;
        const text = String(textNode.nodeValue || "");
        if (!text) continue;
        const separatorLength = chunks.length ? 1 : 0;
        const available = maximum - characters - separatorLength;
        if (available <= 0) break;
        chunks.push(text.slice(0, available));
        characters += separatorLength + Math.min(text.length, available);
      }
      return chunks.join(" ");
    };
    const url = String(window.location.href);
    if (url.length > limits.url || url.length > remainingCharacters) {
      throw new Error("page URL exceeded the snapshot limit");
    }
    remainingCharacters -= url.length;
    const title = takeText(document.title, limits.fieldText);
    const candidateElements = [];
    const walker = document.createTreeWalker(
      document.documentElement,
      NodeFilter.SHOW_ELEMENT
    );
    let visitedElementNodes = 0;
    let candidateTraversalComplete = false;
    while (
      candidateElements.length < limits.elementCount &&
      visitedElementNodes < limits.traversalNodeCount
    ) {
      const candidate = walker.nextNode();
      if (!candidate) {
        candidateTraversalComplete = true;
        break;
      }
      visitedElementNodes += 1;
      if (
        isRenderedElement(candidate) &&
        candidate.matches("a[href], button, input, textarea, select")
      ) {
        candidateElements.push(candidate);
      }
    }
    const replayElements = [];
    const replayWalker = document.createTreeWalker(
      document.documentElement,
      NodeFilter.SHOW_ELEMENT
    );
    let replayTraversalComplete = false;
    while (replayElements.length < limits.traversalNodeCount) {
      const candidate = replayWalker.nextNode();
      if (!candidate) {
        replayTraversalComplete = true;
        break;
      }
      replayElements.push(candidate);
    }
    const structuralReplayLocator = (element) => {
      if (!element.isConnected) return null;
      const segments = [];
      let inspected = 0;
      let current = element;
      while (current && current !== document.documentElement) {
        inspected += 1;
        if (inspected > limits.traversalNodeCount) return null;
        let ordinal = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          inspected += 1;
          if (inspected > limits.traversalNodeCount) return null;
          ordinal += 1;
          sibling = sibling.previousElementSibling;
        }
        segments.push(`${current.tagName.toLowerCase()}:nth-child(${ordinal})`);
        current = current.parentElement;
      }
      if (current !== document.documentElement) return null;
      const selector = `:root > ${segments.reverse().join(" > ")}`;
      return selector.length <= limits.url
        ? { kind: "css", selector, ordinal: 0, matchCount: 1 }
        : null;
    };
    const replayLocator = (element) => {
      if (!replayTraversalComplete) return structuralReplayLocator(element);
      const tag = element.tagName.toLowerCase();
      const candidates = [
        ...(element.id
          ? [`${tag}[id=${JSON.stringify(element.id)}]`]
          : []),
        ...(element.getAttribute("name")
          ? [`${tag}[name=${JSON.stringify(element.getAttribute("name"))}]`]
          : []),
        tag
      ];
      for (const selector of candidates) {
        let matchCount = 0;
        let ordinal = -1;
        try {
          for (const candidate of replayElements) {
            if (!candidate.matches(selector)) continue;
            if (candidate === element) ordinal = matchCount;
            matchCount += 1;
          }
        } catch {
          continue;
        }
        if (ordinal >= 0) {
          return { kind: "css", selector, ordinal, matchCount };
        }
      }
      return structuralReplayLocator(element);
    };
    const elements = candidateElements
      .flatMap((element, index) => {
        if (!element.isConnected || !isRenderedElement(element)) return [];
        const tag = element.tagName.toLowerCase();
        if ((element.labels?.length || 0) > limits.labelCount) return [];
        const labelTexts = Array.from(element.labels || [], (labelElement) =>
          boundedNodeText(labelElement, limits.fieldText + 1)
        );
        const ariaLabel = element.getAttribute("aria-label") || "";
        const ariaLabelledBy = element.getAttribute("aria-labelledby") || "";
        if (ariaLabelledBy.length > limits.fieldText) return [];
        const ariaLabelledByIds = ariaLabelledBy.trim()
          ? ariaLabelledBy.trim().split(/\s+/)
          : [];
        if (ariaLabelledByIds.length > limits.labelledByCount) return [];
        const ariaLabelledByElements = ariaLabelledByIds.map((id) =>
          document.getElementById(id)
        );
        if (ariaLabelledByElements.some((candidate) => !candidate)) return [];
        const ariaLabelledByTexts = ariaLabelledByElements.map((candidate) =>
          boundedNodeText(candidate, limits.fieldText + 1)
        );
        const placeholder = element.getAttribute("placeholder") || "";
        const elementText = boundedNodeText(element, limits.fieldText + 1);
        const label =
          ariaLabel ||
          ariaLabelledByTexts.join(" ") ||
          labelTexts.join(" ") ||
          placeholder ||
          elementText ||
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
        const controlType = String(element.type || "").toLowerCase();
        const form = element.form || element.closest("form");
        let formHasPassword = false;
        if (form) {
          const formElements = form.elements || [];
          if (formElements.length > limits.traversalNodeCount) {
            formHasPassword = true;
          } else {
            for (let formIndex = 0; formIndex < formElements.length; formIndex += 1) {
              const formElement = formElements.item(formIndex);
              if (
                formElement?.tagName === "INPUT" &&
                String(formElement.type).toLowerCase() === "password"
              ) {
                formHasPassword = true;
                break;
              }
            }
          }
        }
        if (tag === "select" && element.options.length > limits.optionCount) {
          return [];
        }
        const optionRecords =
          tag === "select"
            ? Array.from(element.options, (option) => ({
                label:
                  boundedNodeText(option, limits.optionLabel + 1) ||
                  String(option.value),
                value: String(option.value)
              }))
            : [];
        const safetyFields = [
          [label, limits.fieldText],
          ...labelTexts.map((value) => [value, limits.fieldText]),
          [element.getAttribute("name"), limits.fieldText],
          [element.getAttribute("id"), limits.fieldText],
          [ariaLabel, limits.fieldText],
          [ariaLabelledBy, limits.fieldText],
          ...ariaLabelledByTexts.map((value) => [value, limits.fieldText]),
          [placeholder, limits.fieldText],
          [elementText, limits.fieldText],
          [element.href, limits.url],
          [form?.action, limits.url],
          [window.location.href, limits.url],
          ...optionRecords.flatMap((option) => [
            [option.label, limits.optionLabel],
            [option.value, limits.optionValue]
          ])
        ].filter(([value]) => value !== null && value !== undefined);
        if (
          formHasPassword ||
          safetyFields.some(
            ([value, maximum]) =>
              String(value).length > maximum || hasProhibitedText(value)
          )
        ) {
          return [];
        }
        const locator = replayLocator(element);
        if (!locator) return [];
        const ref = `element-${index + 1}`;
        const candidate = {
          ref,
          tag,
          role,
          label: String(label),
          labelTexts,
          placeholder,
          href: element.href ? String(element.href) : null,
          type: String(element.type || ""),
          id: element.getAttribute("id"),
          name: element.getAttribute("name"),
          ariaLabel,
          ariaLabelledBy,
          disabled: Boolean(element.disabled),
          formAction: form?.action ? String(form.action) : null,
          formHasPassword,
          options: optionRecords,
          locator
        };
        const candidateCharacters = JSON.stringify(candidate).length;
        if (candidateCharacters > remainingCharacters) return [];
        remainingCharacters -= candidateCharacters;
        element.setAttribute("data-yellowbird-agent-ref", ref);
        return [candidate];
      });
    return { url, title, candidateTraversalComplete, elements };
  }, {
    bodyTextCharacters: bodyText.length,
    limits: SNAPSHOT_LIMITS,
    prohibitedPattern: PROHIBITED_AGENT_ACTION_PATTERN
  });
  const semanticElements = await Promise.all(
    raw.elements.map(async (rawElement) => {
      try {
        const semanticLocator = page
          .getByRole(rawElement.role, {
            name: normalizeText(rawElement.label, SNAPSHOT_LIMITS.fieldText),
            exact: true
          })
          .and(
            page.locator(
              `[data-yellowbird-agent-ref=${JSON.stringify(rawElement.ref)}]`
            )
          );
        return (await semanticLocator.count()) === 1 &&
          (await semanticLocator.isVisible())
          ? rawElement
          : null;
      } catch {
        return null;
      }
    })
  );
  const controlAssertions = await Promise.all(
    expectedDestinationControls.map(async (expected) => {
      if (!raw.candidateTraversalComplete) {
        return { ...expected, matchCount: 0, satisfied: false };
      }
      try {
        const locator = page.getByRole(expected.role, {
          name: expected.name,
          exact: true
        });
        const matchCount = await locator.count();
        const satisfied =
          matchCount === 1 &&
          (await locator.isVisible()) &&
          (await locator.evaluate(
            (element, expectedType) =>
              String(element.type || "").toLowerCase() === expectedType,
            expected.type
          ));
        return { ...expected, matchCount, satisfied };
      } catch {
        return { ...expected, matchCount: 0, satisfied: false };
      }
    })
  );
  const elements = [];
  for (const rawElement of semanticElements) {
    if (rawElement === null) continue;
    const action = elementAction(
      { ...rawElement, pageUrl: raw.url },
      authorizedOrigin,
      authorizedNavigationRoutes
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
      runtimeSelector: `[data-yellowbird-agent-ref=${JSON.stringify(rawElement.ref)}]`,
      locator: rawElement.locator
    };
    if (!element.locator) continue;
    element.key = [raw.url, rawElement.ref, action].join("|");
    elements.push(element);
  }
  return {
    url: raw.url,
    title: normalizeText(raw.title, 200),
    bodyText: normalizeText(bodyText, RENDERED_TEXT_LIMITS.plannerBodyText),
    controlAssertions,
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
  const normalizedCoverage =
    coverage === "blocked" && steps.some((step) => step.status === "passed")
      ? "partial"
      : coverage;
  const completed = normalizedCoverage === "covered";
  return {
    status: completed ? "completed" : "inconclusive",
    coverage: normalizedCoverage,
    summary,
    steps,
    pages,
    verification,
    issue: completed
      ? null
      : issue || mechanicsIssue(
          "agent-intent-not-fully-covered",
          "The bounded agent could not fully cover the requested intent.",
          summary || `Agent coverage ended as ${normalizedCoverage}`,
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

function verifyOwnedCoverageProfile(
  intent,
  steps,
  pages,
  authorizedPrimaryRoutes,
  expectedDestinationTexts,
  expectedDestinationControls
) {
  const initialInterfaceFlow =
    /^\s*(?:assess|evaluate|inspect|review)(?:\s+the)?\s+initial\s+interface\s+and(?:\s+the)?\s+basic\s+user\s+flow\s*[.!]?\s*$/i.test(
      intent
    );
  if (!initialInterfaceFlow || hasProhibitedSemantics({ label: intent })) {
    return null;
  }
  const passedVisits = steps.filter(
    (step) =>
      step.action === "visit" &&
      step.status === "passed" &&
      isAgentRouteAuthorized(step.url, authorizedPrimaryRoutes)
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
    },
    ...(expectedDestinationTexts.length
      ? [
          {
            id: "owner-declared-destination-text-observed",
            satisfied:
              passedVisit?.destinationAssertions?.length ===
                expectedDestinationTexts.length &&
              passedVisit.destinationAssertions.every(
                (assertion) => assertion.satisfied
              )
          }
        ]
      : []),
    ...(expectedDestinationControls.length
      ? [
          {
            id: "owner-declared-destination-controls-observed",
            satisfied:
              passedVisit?.destinationControlAssertions?.length ===
                expectedDestinationControls.length &&
              passedVisit.destinationControlAssertions.every(
                (assertion) => assertion.satisfied
              )
          }
        ]
      : [])
  ];
  const satisfied = criteria.every((criterion) => criterion.satisfied);
  return {
    profile: "initial-interface-basic-flow.v1",
    authority: "yellowbird-observed-criteria",
    satisfied,
    criteria,
    summary: satisfied
      ? expectedDestinationControls.length
        ? expectedDestinationTexts.length
          ? "YellowBird observed the initial page, visited a distinct authorized setup route, and matched the owner-declared destination text and semantic controls."
          : "YellowBird observed the initial page, visited a distinct authorized setup route, and matched the owner-declared semantic controls."
        : expectedDestinationTexts.length
          ? "YellowBird observed the initial page, visited a distinct authorized setup route, and matched the owner-declared destination text."
        : "YellowBird observed the initial page, visited a distinct authorized setup route, and inventoried safe controls on the destination."
      : "YellowBird could not satisfy every observed criterion for the initial-interface basic-flow profile."
  };
}

function destinationAssertions(snapshot, expectedDestinationTexts) {
  return expectedDestinationTexts.map((text) => ({
    text,
    satisfied: snapshot.bodyText.includes(text)
  }));
}

function unverifiedCoverage(plannerCoverage, steps) {
  if (plannerCoverage !== "covered") return plannerCoverage;
  return steps.some((step) => step.status === "passed")
    ? "partial"
    : "blocked";
}

export async function exploreIntentWithEngine({
  page,
  intent,
  authorizedOrigin,
  engine,
  maxSteps,
  timeoutMs,
  record,
  actionPolicy = null,
  authorizedNavigationRoutes = new Set(),
  authorizedPrimaryRoutes = new Set(),
  expectedDestinationTexts = [],
  expectedDestinationControls = []
}) {
  const steps = [];
  const pages = [];
  const visited = new Set();
  const usedActionKeys = new Set();
  let feedback = "";
  let snapshot;

  try {
    snapshot = await snapshotPage(
      page,
      authorizedOrigin,
      authorizedNavigationRoutes,
      expectedDestinationControls
    );
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
        pages,
        authorizedPrimaryRoutes,
        expectedDestinationTexts,
        expectedDestinationControls
      );
      const coverage = verification
        ? verification.satisfied
          ? "covered"
          : steps.some((step) => step.status === "passed")
            ? "partial"
            : "blocked"
        : unverifiedCoverage(proposed.coverage, steps);
      const summary = verification
        ? verification.summary
        : normalizeText(proposed.summary, 1_000);
      record("info", "agent.completed", "Intent exploration completed", {
        coverage,
        plannerCoverage: proposed.coverage,
        coverageAuthority: verification?.authority || "model-advisory-unverified",
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
    let actionPolicyAttempted = false;
    let actionFailed = false;
    let cleanupError = null;
    let navigationAttempted = false;
    let response = null;
    try {
      actionPolicyAttempted = Boolean(actionPolicy);
      await actionPolicy?.begin({
        id,
        action,
        requestedUrl: selected.href || null
      });
      const locator = page.locator(selected.runtimeSelector);
      if (action === "visit") {
        navigationAttempted = true;
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
      await page.waitForTimeout(actionPolicy?.navigationSettlementMs ?? 150);
      if (action === "visit") await actionPolicy?.resume?.(action);
      const actionPageUrl = page.url();
      if (
        !isAgentUrlAllowed(actionPageUrl, authorizedOrigin) ||
        (action === "visit" &&
          !isAgentRouteAuthorized(
            actionPageUrl,
            authorizedNavigationRoutes
          ))
      ) {
        throw new Error("The interaction reached a URL outside agent policy.");
      }
      snapshot = await snapshotPage(
        page,
        authorizedOrigin,
        authorizedNavigationRoutes,
        expectedDestinationControls
      );
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
        destinationAssertions:
          action === "visit"
            ? destinationAssertions(snapshot, expectedDestinationTexts)
            : [],
        destinationControlAssertions:
          action === "visit" ? snapshot.controlAssertions : [],
        httpStatus: response?.status() ?? null,
        evidence:
          response && response.status() >= 400
            ? `Navigation returned HTTP ${response.status()}`
            : "Authorized safe browser interaction completed",
        rationale: normalizeText(proposed.rationale, 500),
        value: actionValue,
        locator: selected.locator,
        navigationAttempted,
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
      actionFailed = true;
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
        url: diagnosticUrl(page.url()).url,
        title: "",
        destinationControlCount: null,
        destinationAssertions: [],
        destinationControlAssertions: [],
        httpStatus: response?.status() ?? null,
        evidence: detail,
        rationale: normalizeText(proposed.rationale, 500),
        value: actionValue,
        locator: selected.locator,
        navigationAttempted,
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
      if (actionPolicyAttempted) {
        try {
          await actionPolicy.end();
        } catch (error) {
          if (!actionFailed) cleanupError = error;
        }
      }
    }
    if (cleanupError) {
      const detail = safeDetail(cleanupError?.message || cleanupError);
      record(
        "error",
        "agent.action.cleanup.failed",
        "The authorized interaction cleanup failed",
        { id, action, detail }
      );
      return completedExploration({
        coverage: "blocked",
        summary: "An agent interaction completed, but its cleanup could not be confirmed.",
        steps,
        pages,
        issue: mechanicsIssue(
          "agent-action-cleanup-failed",
          "An authorized agent interaction could not be cleaned up safely.",
          detail,
          "Review the browser safety guard diagnostics, then rerun the exploration."
        )
      });
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
