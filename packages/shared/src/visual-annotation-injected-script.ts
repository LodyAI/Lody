export const STATIC_HTML_PREVIEW_DOCUMENT_MARKER = 'data-lody-static-html-preview-document';

export const VISUAL_ANNOTATION_INSPECTOR_BROWSER_SCRIPT = String.raw`
(function () {
  "use strict";

  var SET_MODE = "SET_ANNOTATION_MODE";
  var TARGET = "VISUAL_ANNOTATION_TARGET";
  var RESOLVE = "RESOLVE_VISUAL_ANNOTATION_ANCHORS";
  var RESOLVED = "VISUAL_ANNOTATION_ANCHORS_RESOLVED";
  var BROWSER_COMMAND = "LODY_MANAGED_BROWSER_COMMAND";
  var BROWSER_STATE = "LODY_MANAGED_BROWSER_STATE";
  var BROWSER_READY = "LODY_MANAGED_BROWSER_READY";
  var BROWSER_NAVIGATION_REQUEST = "LODY_MANAGED_BROWSER_NAVIGATION_REQUEST";
  var STATIC_HTML_PREVIEW_DOCUMENT_MARKER = "${STATIC_HTML_PREVIEW_DOCUMENT_MARKER}";
  var STATIC_HTML_PREVIEW_NAVIGATION_BASE = "https://html-file-preview.invalid/";
  var OVERLAY_ATTR = "data-lody-visual-annotation-overlay";
  var INTERACTION_LAYER_ATTR = "data-lody-visual-annotation-interaction-layer";
  var MAX_PARENT_DEPTH = 5;
  var STYLE_FIELDS = [
    "display",
    "position",
    "width",
    "height",
    "margin",
    "padding",
    "gap",
    "color",
    "backgroundColor",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "border",
    "borderRadius",
    "opacity",
    "visibility",
    "overflow",
    "zIndex"
  ];
  var ATTRIBUTE_NAMES = [
    "id",
    "class",
    "role",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    "title",
    "alt",
    "name",
    "type",
    "placeholder",
    "href",
    "src",
    "data-testid",
    "data-test",
    "data-cy"
  ];
  var SEMANTIC_SELECTOR =
    "button,a[href],input,textarea,select,label,summary,details,[role],[aria-label],[aria-labelledby],[data-testid],[data-test],[data-cy]";
  var TEXT_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,td,th";
  var SECTION_SELECTOR = "form,nav,main,header,footer,section,article,aside";
  var INLINE_TEXT_SELECTOR = "span,strong,em,b,i,small,code";

  var enabled = false;
  var destroyed = false;
  var staticHtmlPreviewDocument = document.documentElement.hasAttribute(
    STATIC_HTML_PREVIEW_DOCUMENT_MARKER
  );
  var overlay = null;
  var interactionLayer = null;
  var currentHoverTarget = null;
  var trackedAnchors = [];
  var trackedFrame = 0;
  var trackedListenersAttached = false;
  var mutationObserver = null;
  var pendingHoverEvent = null;
  var hoverFrame = 0;
  // Referrer describes the previous document after an in-frame navigation, not
  // necessarily the embedder. Bind only to a control message from window.parent.
  var parentOrigin = null;
  var parentPostMessageTargetOrigin = parentOrigin;
  var pendingNavigationRequest = null;
  var suppressNextClick = false;
  var browserStateFrame = 0;
  var pendingStaticDocumentFragmentClick = null;

  function normalizeOrigin(value) {
    if (!value || value === "null") {
      return null;
    }
    return value;
  }

  function isEquivalentParentOrigin(expectedOrigin, eventOrigin) {
    return expectedOrigin === eventOrigin;
  }

  function learnOrValidateParentOrigin(event) {
    if (event.origin === "null") {
      if (parentOrigin && parentOrigin !== "null") {
        return false;
      }
      if (!parentOrigin) {
        parentOrigin = "null";
        parentPostMessageTargetOrigin = "*";
      }
      return true;
    }
    var messageOrigin = normalizeOrigin(event.origin);
    if (!messageOrigin) {
      return false;
    }
    if (parentOrigin && !isEquivalentParentOrigin(parentOrigin, messageOrigin)) {
      return false;
    }
    if (parentOrigin && event.origin !== parentOrigin) {
      parentOrigin = messageOrigin;
      parentPostMessageTargetOrigin = messageOrigin;
    }
    if (!parentOrigin) {
      parentOrigin = messageOrigin;
      parentPostMessageTargetOrigin = messageOrigin;
    }
    return true;
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  function ratio(value, size) {
    return size > 0 ? round(value / size) : 0;
  }

  function truncate(value, maxLength) {
    if (value.length <= maxLength) {
      return value;
    }
    return value.slice(0, Math.max(0, maxLength - 3)) + "...";
  }

  function normalizeText(value, maxLength) {
    var text = String(value || "").replace(/\s+/g, " ").trim();
    return text ? truncate(text, maxLength || 240) : "";
  }

  function getTag(element) {
    return element.tagName.toLowerCase();
  }

  function safeMatches(element, selector) {
    try {
      return element.matches(selector);
    } catch (_error) {
      return false;
    }
  }

  function isOverlayElement(element) {
    return Boolean(
      element &&
        element.closest(
          "[" + OVERLAY_ATTR + "='true'],[" + INTERACTION_LAYER_ATTR + "='true']"
        )
    );
  }

  function collectCandidates(element) {
    var candidates = [];
    var current = element;
    var depth = 0;
    while (current && depth <= MAX_PARENT_DEPTH) {
      candidates.push(current);
      current = current.parentElement;
      depth += 1;
    }
    return candidates;
  }

  function findSemanticTarget(rawTarget) {
    var candidates = collectCandidates(rawTarget);
    return (
      candidates.find(function (candidate) {
        return safeMatches(candidate, SEMANTIC_SELECTOR);
      }) ||
      candidates.find(function (candidate) {
        return safeMatches(candidate, TEXT_SELECTOR);
      }) ||
      candidates.find(function (candidate) {
        return safeMatches(candidate, INLINE_TEXT_SELECTOR);
      }) ||
      candidates.find(function (candidate) {
        return safeMatches(candidate, SECTION_SELECTOR);
      }) ||
      rawTarget
    );
  }

  function getElementAtPoint(event) {
    if (interactionLayer) {
      interactionLayer.style.setProperty("pointer-events", "none", "important");
    }
    var raw;
    try {
      raw = document.elementFromPoint(event.clientX, event.clientY);
    } finally {
      if (interactionLayer && enabled) {
        interactionLayer.style.setProperty("pointer-events", "auto", "important");
      }
    }
    if (!raw || isOverlayElement(raw)) {
      return null;
    }
    return findSemanticTarget(raw);
  }

  function ensureOverlay() {
    if (overlay) {
      return overlay;
    }
    overlay = document.createElement("div");
    overlay.setAttribute(OVERLAY_ATTR, "true");
    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.pointerEvents = "none";
    overlay.style.boxSizing = "border-box";
    overlay.style.border = "2px solid rgba(37, 99, 235, 0.9)";
    overlay.style.background = "rgba(37, 99, 235, 0.08)";
    overlay.style.borderRadius = "4px";
    overlay.style.zIndex = "2147483647";
    overlay.style.display = "none";
    overlay.style.transition = "transform 80ms ease, width 80ms ease, height 80ms ease";
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  function ensureInteractionLayer() {
    if (interactionLayer && interactionLayer.isConnected) {
      interactionLayer.style.setProperty("display", "block", "important");
      interactionLayer.style.setProperty("pointer-events", "auto", "important");
      return interactionLayer;
    }
    interactionLayer = document.createElement("div");
    interactionLayer.setAttribute(INTERACTION_LAYER_ATTR, "true");
    interactionLayer.setAttribute("aria-hidden", "true");
    interactionLayer.style.setProperty("position", "fixed", "important");
    interactionLayer.style.setProperty("top", "0", "important");
    interactionLayer.style.setProperty("right", "0", "important");
    interactionLayer.style.setProperty("bottom", "0", "important");
    interactionLayer.style.setProperty("left", "0", "important");
    interactionLayer.style.setProperty("display", "block", "important");
    interactionLayer.style.setProperty("pointer-events", "auto", "important");
    interactionLayer.style.setProperty("background", "transparent", "important");
    interactionLayer.style.setProperty("cursor", "crosshair", "important");
    interactionLayer.style.setProperty("z-index", "2147483647", "important");
    (document.body || document.documentElement).appendChild(interactionLayer);
    return interactionLayer;
  }

  function hideInteractionLayer() {
    if (!interactionLayer) {
      return;
    }
    interactionLayer.style.setProperty("display", "none", "important");
    interactionLayer.style.setProperty("pointer-events", "none", "important");
  }

  function updateOverlayForTarget(target) {
    var node = ensureOverlay();
    if (!enabled || !target) {
      node.style.display = "none";
      return;
    }
    var rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      node.style.display = "none";
      return;
    }
    node.style.display = "block";
    node.style.transform = "translate(" + round(rect.left) + "px, " + round(rect.top) + "px)";
    node.style.width = round(rect.width) + "px";
    node.style.height = round(rect.height) + "px";
  }

  function flushHoverFrame() {
    hoverFrame = 0;
    var event = pendingHoverEvent;
    pendingHoverEvent = null;
    if (!enabled || !event) {
      return;
    }
    currentHoverTarget = getElementAtPoint(event);
    updateOverlayForTarget(currentHoverTarget);
  }

  function handleMouseMove(event) {
    pendingHoverEvent = event;
    if (hoverFrame || !enabled) {
      return;
    }
    hoverFrame = window.requestAnimationFrame(flushHoverFrame);
  }

  function stopClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  }

  function inspectEventTarget(event) {
    var target = getElementAtPoint(event);
    if (!target) {
      return false;
    }
    postToParent({
      type: TARGET,
      payload: buildPayload(target, event)
    });
    return true;
  }

  function isPrimaryPointer(event) {
    return typeof event.button !== "number" || event.button === 0;
  }

  function handlePointerDown(event) {
    if (!enabled || !isPrimaryPointer(event)) {
      return;
    }
    stopClick(event);
    suppressNextClick = true;
    inspectEventTarget(event);
  }

  function handleClick(event) {
    if (!enabled) {
      return;
    }
    stopClick(event);
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    inspectEventTarget(event);
  }

  function addModeListeners() {
    document.addEventListener("pointerdown", handlePointerDown, { capture: true, passive: false });
    document.addEventListener("mousemove", handleMouseMove, { capture: true, passive: true });
    document.addEventListener("click", handleClick, { capture: true, passive: false });
    window.addEventListener("scroll", handleViewportChange, { capture: true, passive: true });
    window.addEventListener("resize", handleViewportChange);
  }

  function removeModeListeners() {
    document.removeEventListener("pointerdown", handlePointerDown, { capture: true });
    document.removeEventListener("mousemove", handleMouseMove, { capture: true });
    document.removeEventListener("click", handleClick, { capture: true });
    window.removeEventListener("scroll", handleViewportChange, { capture: true });
    window.removeEventListener("resize", handleViewportChange);
    if (hoverFrame) {
      window.cancelAnimationFrame(hoverFrame);
      hoverFrame = 0;
    }
    suppressNextClick = false;
    pendingHoverEvent = null;
  }

  function setEnabled(nextEnabled) {
    if (destroyed || enabled === nextEnabled) {
      return;
    }
    enabled = nextEnabled;
    if (enabled) {
      ensureInteractionLayer();
      addModeListeners();
      ensureOverlay();
    } else {
      removeModeListeners();
      hideInteractionLayer();
      currentHoverTarget = null;
      updateOverlayForTarget(null);
    }
  }

  function handleViewportChange() {
    updateOverlayForTarget(currentHoverTarget);
    scheduleResolvePost();
  }

  function handleTrackedViewportChange() {
    scheduleResolvePost();
  }

  function getViewport() {
    return {
      width: round(window.innerWidth || document.documentElement.clientWidth || 0),
      height: round(window.innerHeight || document.documentElement.clientHeight || 0),
      scrollX: round(window.scrollX || window.pageXOffset || 0),
      scrollY: round(window.scrollY || window.pageYOffset || 0),
      devicePixelRatio: round(window.devicePixelRatio || 1)
    };
  }

  function toRect(rect) {
    return {
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
      top: round(rect.top),
      left: round(rect.left),
      right: round(rect.right),
      bottom: round(rect.bottom)
    };
  }

  function collectAttributes(element) {
    var result = {};
    ATTRIBUTE_NAMES.forEach(function (name) {
      var value = element.getAttribute(name);
      if (value && value.trim()) {
        result[name] = truncate(value.trim(), 240);
      }
    });
    return result;
  }

  function summarizeElementText(element, maxLength) {
    var tag = getTag(element);
    if (tag === "script" || tag === "style" || tag === "noscript") {
      return "";
    }
    if (tag === "input") {
      var input = element;
      var type = String(input.type || "").toLowerCase();
      if (type === "password" || type === "hidden") {
        return "";
      }
      return normalizeText(input.value || input.placeholder || input.getAttribute("aria-label"), maxLength);
    }
    return normalizeText(element.innerText || element.textContent || element.getAttribute("aria-label") || element.getAttribute("title"), maxLength);
  }

  function siblingTexts(element) {
    var parent = element.parentElement;
    if (!parent) {
      return [];
    }
    return Array.prototype.slice
      .call(parent.children)
      .filter(function (child) {
        return child !== element;
      })
      .slice(0, 4)
      .map(function (child) {
        return summarizeElementText(child, 120);
      })
      .filter(Boolean);
  }

  function getComputedStyleSummary(element) {
    var style = window.getComputedStyle(element);
    var result = {};
    STYLE_FIELDS.forEach(function (field) {
      result[field] = style[field] || "";
    });
    return result;
  }

  function outerHTMLPreview(element) {
    var tag = getTag(element);
    if (tag === "script" || tag === "style" || tag === "noscript") {
      return "<" + tag + ">";
    }
    return truncate(String(element.outerHTML || "").replace(/\s+/g, " ").trim(), 800);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function quoteAttribute(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function selectorSegment(element) {
    var tag = getTag(element);
    if (element.id) {
      return "#" + cssEscape(element.id);
    }
    var stableAttributes = ["data-testid", "data-test", "data-cy"];
    for (var i = 0; i < stableAttributes.length; i += 1) {
      var stableAttribute = stableAttributes[i];
      var stableValue = element.getAttribute(stableAttribute);
      if (stableValue) {
        return tag + "[" + stableAttribute + '="' + quoteAttribute(stableValue) + '"]';
      }
    }
    var aria = element.getAttribute("aria-label");
    if (aria) {
      return tag + '[aria-label="' + quoteAttribute(aria) + '"]';
    }
    var parent = element.parentElement;
    if (!parent) {
      return tag;
    }
    var sameTag = Array.prototype.filter.call(parent.children, function (child) {
      return getTag(child) === tag;
    });
    if (sameTag.length <= 1) {
      return tag;
    }
    return tag + ":nth-of-type(" + (sameTag.indexOf(element) + 1) + ")";
  }

  function buildSelector(element) {
    var parts = [];
    var current = element;
    var depth = 0;
    while (current && current.nodeType === 1 && depth < 6) {
      parts.unshift(selectorSegment(current));
      var selector = parts.join(" > ");
      try {
        if (document.querySelector(selector) === element) {
          return selector;
        }
      } catch (_error) {
        return getTag(element);
      }
      current = current.parentElement;
      depth += 1;
    }
    return parts.join(" > ") || getTag(element);
  }

  function buildXPath(element) {
    if (element.id) {
      return '//*[@id="' + element.id.replace(/"/g, '\\"') + '"]';
    }
    var parts = [];
    var current = element;
    while (current && current.nodeType === 1) {
      var tag = getTag(current);
      var index = 1;
      var sibling = current.previousElementSibling;
      while (sibling) {
        if (getTag(sibling) === tag) {
          index += 1;
        }
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(tag + "[" + index + "]");
      current = current.parentElement;
    }
    return "/" + parts.join("/");
  }

  function ancestors(element) {
    var result = [];
    var current = element.parentElement;
    while (current && result.length < 6) {
      result.push({
        tag: getTag(current),
        id: current.id || undefined,
        role: current.getAttribute("role") || undefined,
        selector: buildSelector(current),
        text: summarizeElementText(current, 120) || undefined,
        attributes: collectAttributes(current)
      });
      current = current.parentElement;
    }
    return result;
  }

  function buildPayload(element, event) {
    var rect = toRect(element.getBoundingClientRect());
    return {
      page: {
        url: window.location.pathname + window.location.search + window.location.hash,
        pathname: window.location.pathname,
        title: document.title,
        viewport: getViewport()
      },
      click: {
        clientX: round(event.clientX),
        clientY: round(event.clientY),
        pageX: round(event.pageX),
        pageY: round(event.pageY)
      },
      target: {
        tag: getTag(element),
        id: element.id || undefined,
        className: normalizeText(element.className, 240) || undefined,
        role: element.getAttribute("role") || undefined,
        attributes: collectAttributes(element),
        text: summarizeElementText(element, 240) || undefined,
        rect: rect,
        selector: buildSelector(element),
        xpath: buildXPath(element),
        outerHTMLPreview: outerHTMLPreview(element)
      },
      ancestors: ancestors(element),
      nearbyText: {
        self: summarizeElementText(element, 240) || undefined,
        parentSummary: element.parentElement ? summarizeElementText(element.parentElement, 240) || undefined : undefined,
        siblingTexts: siblingTexts(element)
      },
      style: getComputedStyleSummary(element)
    };
  }

  function querySelector(selector) {
    try {
      return selector ? document.querySelector(selector) : null;
    } catch (_error) {
      return null;
    }
  }

  function evaluateXPath(xpath) {
    if (!xpath || typeof document.evaluate !== "function") {
      return null;
    }
    try {
      var result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue && result.singleNodeValue.nodeType === 1 ? result.singleNodeValue : null;
    } catch (_error) {
      return null;
    }
  }

  function findByAnchorText(anchor) {
    var text = anchor && anchor.target && anchor.target.text;
    var tag = anchor && anchor.target && anchor.target.tag;
    if (!text || !tag) {
      return null;
    }
    var expected = normalizeText(text, 240);
    return Array.prototype.find.call(document.querySelectorAll(tag), function (candidate) {
      return summarizeElementText(candidate, expected.length + 40).indexOf(expected) !== -1;
    }) || null;
  }

  function findElementForAnchor(anchor) {
    return (
      querySelector(anchor && anchor.target && anchor.target.selector) ||
      (anchor && anchor.target && anchor.target.id ? document.getElementById(anchor.target.id) : null) ||
      evaluateXPath(anchor && anchor.target && anchor.target.xpath) ||
      findByAnchorText(anchor)
    );
  }

  function resolveAnchor(item) {
    var element = findElementForAnchor(item.anchor);
    if (!element) {
      return { commentId: item.commentId, resolved: false };
    }
    var rect = toRect(element.getBoundingClientRect());
    if (rect.width <= 0 || rect.height <= 0) {
      return { commentId: item.commentId, resolved: false };
    }
    var viewport = getViewport();
    return {
      commentId: item.commentId,
      resolved: true,
      rect: rect,
      rectRatio: {
        x: ratio(rect.x, viewport.width),
        y: ratio(rect.y, viewport.height),
        width: ratio(rect.width, viewport.width),
        height: ratio(rect.height, viewport.height)
      },
      selector: buildSelector(element),
      xpath: buildXPath(element)
    };
  }

  function postResolvedAnchors() {
    trackedFrame = 0;
    if (!trackedAnchors.length) {
      return;
    }
    postToParent({
      type: RESOLVED,
      payload: {
        viewport: getViewport(),
        results: trackedAnchors.map(resolveAnchor)
      }
    });
  }

  function scheduleResolvePost() {
    if (destroyed || !trackedAnchors.length || trackedFrame) {
      return;
    }
    trackedFrame = window.requestAnimationFrame(postResolvedAnchors);
  }

  function setTrackedAnchors(anchors) {
    trackedAnchors = Array.isArray(anchors) ? anchors : [];
    if (!trackedAnchors.length) {
      detachTrackedAnchorListeners();
      return;
    }
    attachTrackedAnchorListeners();
    postResolvedAnchors();
  }

  function attachTrackedAnchorListeners() {
    if (trackedListenersAttached) {
      return;
    }
    trackedListenersAttached = true;
    window.addEventListener("scroll", handleTrackedViewportChange, { capture: true, passive: true });
    window.addEventListener("resize", handleTrackedViewportChange);
    if (!mutationObserver && typeof MutationObserver === "function") {
      mutationObserver = new MutationObserver(scheduleResolvePost);
      mutationObserver.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
    }
  }

  function detachTrackedAnchorListeners() {
    if (trackedFrame) {
      window.cancelAnimationFrame(trackedFrame);
      trackedFrame = 0;
    }
    if (!trackedListenersAttached) {
      return;
    }
    trackedListenersAttached = false;
    window.removeEventListener("scroll", handleTrackedViewportChange, { capture: true });
    window.removeEventListener("resize", handleTrackedViewportChange);
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
  }

  function postToParent(message) {
    if (!parentPostMessageTargetOrigin) {
      // The parent initiates the handshake, including when it reuses a frame.
      return;
    }
    window.parent.postMessage(message, parentPostMessageTargetOrigin);
  }

  function postBrowserState() {
    browserStateFrame = 0;
    var navigationApi = window.navigation;
    postToParent({
      type: BROWSER_STATE,
      payload: {
        url: window.location.href,
        title: document.title || "",
        loading: document.readyState !== "complete",
        canGoBack:
          navigationApi && typeof navigationApi.canGoBack === "boolean"
            ? navigationApi.canGoBack
            : window.history.length > 1,
        canGoForward:
          navigationApi && typeof navigationApi.canGoForward === "boolean"
            ? navigationApi.canGoForward
            : false
      }
    });
  }

  function scheduleBrowserState() {
    if (browserStateFrame) {
      return;
    }
    browserStateFrame = window.requestAnimationFrame(postBrowserState);
  }

  function requestParentNavigation(rawUrl, event, forceParentNavigation) {
    var destination;
    try {
      destination = new URL(rawUrl, window.location.href);
    } catch (_error) {
      if (!forceParentNavigation) {
        return false;
      }
      try {
        destination = new URL(rawUrl, STATIC_HTML_PREVIEW_NAVIGATION_BASE);
      } catch (_fallbackError) {
        return false;
      }
    }
    if (!forceParentNavigation && destination.origin === window.location.origin) {
      return false;
    }
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      } else if (typeof event.stopPropagation === "function") {
        event.stopPropagation();
      }
    }
    var request = {
      type: BROWSER_NAVIGATION_REQUEST,
      payload: { url: destination.toString() }
    };
    if (parentPostMessageTargetOrigin) {
      postToParent(request);
    } else {
      // Retain one destination until the real parent establishes its origin.
      // Never let a pre-handshake link bypass the parent's navigation policy.
      pendingNavigationRequest = request;
    }
    return true;
  }

  function getStaticDocumentFragmentHref(anchor) {
    if (!staticHtmlPreviewDocument) {
      return null;
    }
    var browsingContextTarget = anchor.getAttribute("target");
    if (browsingContextTarget && browsingContextTarget.trim().toLowerCase() !== "_self") {
      return null;
    }
    var rawHref = anchor.getAttribute("href");
    rawHref = rawHref && rawHref.trim();
    if (!rawHref || rawHref.charAt(0) !== "#") {
      return null;
    }
    return rawHref;
  }

  function clearPendingStaticDocumentFragmentClick(pending) {
    if (!pending) {
      return;
    }
    if (pendingStaticDocumentFragmentClick === pending) {
      pendingStaticDocumentFragmentClick = null;
    }
    for (var i = 0; i < pending.fallbackTargets.length; i += 1) {
      pending.fallbackTargets[i].removeEventListener("click", pending.handleStoppedPropagation);
    }
    pending.fallbackTargets = [];
  }

  function rememberStaticDocumentFragmentClick(anchor, event, rawHref) {
    clearPendingStaticDocumentFragmentClick(pendingStaticDocumentFragmentClick);
    var pending = {
      anchor: anchor,
      destinationUrl: anchor.href,
      event: event,
      fallbackTargets: [],
      handleStoppedPropagation: null,
      rawHref: rawHref
    };
    pending.handleStoppedPropagation = function (fallbackEvent) {
      if (
        fallbackEvent !== event ||
        !fallbackEvent.cancelBubble ||
        pendingStaticDocumentFragmentClick !== pending
      ) {
        return;
      }
      clearPendingStaticDocumentFragmentClick(pending);
      if (!fallbackEvent.defaultPrevented) {
        completeStaticDocumentFragmentNavigation(rawHref, fallbackEvent);
      }
    };
    var eventPath = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (var i = 0; i < eventPath.length; i += 1) {
      var eventTarget = eventPath[i];
      if (
        eventTarget === window ||
        !eventTarget ||
        typeof eventTarget.addEventListener !== "function"
      ) {
        continue;
      }
      eventTarget.addEventListener("click", pending.handleStoppedPropagation, {
        once: true,
        passive: false
      });
      pending.fallbackTargets.push(eventTarget);
    }
    pendingStaticDocumentFragmentClick = pending;
    window.setTimeout(function () {
      clearPendingStaticDocumentFragmentClick(pending);
    }, 0);
  }

  function completeStaticDocumentFragmentNavigation(rawHref, event) {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    window.location.hash = rawHref;
    scheduleBrowserState();
  }

  function handleStaticDocumentFragmentNavigation(event) {
    var pending = pendingStaticDocumentFragmentClick;
    if (!pending || pending.event !== event) {
      return;
    }
    clearPendingStaticDocumentFragmentClick(pending);
    if (
      enabled ||
      event.defaultPrevented ||
      !isPrimaryPointer(event) ||
      getStaticDocumentFragmentHref(pending.anchor) !== pending.rawHref
    ) {
      return;
    }
    // Run after target, ancestor, and document handlers so the page can cancel
    // activation and observes the old hash while handling the click. Assigning
    // the fragment directly avoids resolving it through the owned HTTPS base.
    completeStaticDocumentFragmentNavigation(pending.rawHref, event);
  }

  function handleExternalLink(event) {
    if (enabled || event.defaultPrevented || !isPrimaryPointer(event)) {
      return;
    }
    if (
      pendingStaticDocumentFragmentClick &&
      pendingStaticDocumentFragmentClick.event !== event
    ) {
      clearPendingStaticDocumentFragmentClick(pendingStaticDocumentFragmentClick);
    }
    var target = event.target;
    var anchor = target && typeof target.closest === "function" ? target.closest("a[href]") : null;
    if (!anchor || anchor.hasAttribute("download")) {
      return;
    }
    var fragmentHref = getStaticDocumentFragmentHref(anchor);
    if (fragmentHref !== null) {
      rememberStaticDocumentFragmentClick(anchor, event, fragmentHref);
      return;
    }
    requestParentNavigation(
      staticHtmlPreviewDocument ? anchor.getAttribute("href") : anchor.href,
      event,
      staticHtmlPreviewDocument
    );
  }

  function handleExternalForm(event) {
    if (enabled || event.defaultPrevented) {
      return;
    }
    var form = event.target;
    if (!form || typeof form.action !== "string") {
      return;
    }
    requestParentNavigation(
      staticHtmlPreviewDocument ? form.getAttribute("action") || "" : form.action,
      event,
      staticHtmlPreviewDocument
    );
  }

  function handleNavigationApiRequest(event) {
    if (enabled || !event || !event.destination || typeof event.destination.url !== "string") {
      return;
    }
    if (staticHtmlPreviewDocument && event.destination.sameDocument === true) {
      scheduleBrowserState();
      return;
    }
    var pending = pendingStaticDocumentFragmentClick;
    if (
      pending &&
      !pending.event.defaultPrevented &&
      event.destination.url === pending.destinationUrl
    ) {
      clearPendingStaticDocumentFragmentClick(pending);
      completeStaticDocumentFragmentNavigation(pending.rawHref, event);
      return;
    }
    clearPendingStaticDocumentFragmentClick(pending);
    requestParentNavigation(event.destination.url, event, staticHtmlPreviewDocument);
  }

  function runBrowserCommand(command) {
    if (command === "back") {
      window.history.back();
    } else if (command === "forward") {
      window.history.forward();
    } else if (command === "reload") {
      window.location.reload();
    } else if (command === "stop") {
      window.stop();
      scheduleBrowserState();
    }
  }

  function handleMessage(event) {
    if (event.source !== window.parent) {
      return;
    }
    var data = event.data;
    if (!data || typeof data !== "object") {
      return;
    }
    var isSetMode = data.type === SET_MODE && typeof data.enabled === "boolean";
    var isResolve = data.type === RESOLVE && data.payload && Array.isArray(data.payload.anchors);
    var isBrowserCommand =
      data.type === BROWSER_COMMAND &&
      (data.command === "back" ||
        data.command === "forward" ||
        data.command === "reload" ||
        data.command === "stop");
    if (!isSetMode && !isResolve && !isBrowserCommand) {
      return;
    }
    if (!learnOrValidateParentOrigin(event)) {
      return;
    }
    if (pendingNavigationRequest) {
      var pending = pendingNavigationRequest;
      pendingNavigationRequest = null;
      postToParent(pending);
    }
    if (isSetMode) {
      setEnabled(data.enabled);
      scheduleBrowserState();
      return;
    }
    if (isResolve) {
      setTrackedAnchors(data.payload.anchors);
      return;
    }
    if (isBrowserCommand) {
      runBrowserCommand(data.command);
    }
  }

  function destroy() {
    if (destroyed) {
      return;
    }
    if (enabled) {
      removeModeListeners();
      currentHoverTarget = null;
      updateOverlayForTarget(null);
      enabled = false;
    }
    destroyed = true;
    pendingNavigationRequest = null;
    clearPendingStaticDocumentFragmentClick(pendingStaticDocumentFragmentClick);
    window.removeEventListener("message", handleMessage);
    window.removeEventListener("popstate", scheduleBrowserState);
    window.removeEventListener("hashchange", scheduleBrowserState);
    window.removeEventListener("load", scheduleBrowserState);
    document.removeEventListener("click", handleExternalLink, { capture: true });
    window.removeEventListener("click", handleStaticDocumentFragmentNavigation);
    document.removeEventListener("submit", handleExternalForm, { capture: true });
    if (navigationApi && typeof navigationApi.removeEventListener === "function") {
      navigationApi.removeEventListener("navigate", handleNavigationApiRequest);
    }
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
    if (browserStateFrame) {
      window.cancelAnimationFrame(browserStateFrame);
      browserStateFrame = 0;
    }
    detachTrackedAnchorListeners();
    trackedAnchors = [];
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    if (interactionLayer) {
      interactionLayer.remove();
      interactionLayer = null;
    }
  }

  if (window.__lodyVisualCommentInspector && typeof window.__lodyVisualCommentInspector.destroy === "function") {
    window.__lodyVisualCommentInspector.destroy();
  }
  window.__lodyVisualCommentInspector = {
    setEnabled: setEnabled,
    isEnabled: function () {
      return enabled;
    },
    destroy: destroy
  };
  window.addEventListener("message", handleMessage);
  window.addEventListener("popstate", scheduleBrowserState);
  window.addEventListener("hashchange", scheduleBrowserState);
  window.addEventListener("load", scheduleBrowserState);
  document.addEventListener("click", handleExternalLink, { capture: true, passive: false });
  window.addEventListener("click", handleStaticDocumentFragmentNavigation, { passive: false });
  document.addEventListener("submit", handleExternalForm, { capture: true, passive: false });
  var navigationApi = window.navigation;
  if (navigationApi && typeof navigationApi.addEventListener === "function") {
    navigationApi.addEventListener("navigate", handleNavigationApiRequest);
  }
  var originalPushState = window.history.pushState;
  var originalReplaceState = window.history.replaceState;
  window.history.pushState = function () {
    var result = originalPushState.apply(window.history, arguments);
    scheduleBrowserState();
    return result;
  };
  window.history.replaceState = function () {
    var result = originalReplaceState.apply(window.history, arguments);
    scheduleBrowserState();
    return result;
  };
  // No page data is sent until a source-checked parent control message arrives.
  window.parent.postMessage({ type: BROWSER_READY }, "*");
  scheduleBrowserState();
})();
`;
