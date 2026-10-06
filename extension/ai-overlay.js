(() => {
  "use strict";
  const OVERLAY = "data-yt-ai-overlay";
  const WRAPPER = "data-yt-mask-wrapper";
  const overlays = new WeakMap();
  const wrappers = new WeakMap();
  const labelLayouts = new WeakMap();

  function foreground(hex) {
    const channels = hex.slice(1).match(/../g).map((part) => {
      const value = parseInt(part, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
  }

  function resizeLabel(element) {
    const rect = element.getBoundingClientRect();
    const overlay = overlays.get(element);
    const signature = `${rect.width}:${rect.height}:${overlay?.textContent}`;
    if (labelLayouts.get(element) === signature) return;
    labelLayouts.set(element, signature);
    let size = rect.width && rect.height ? Math.max(7, Math.min(22, rect.width / 12, rect.height / 5)) : 14;
    const applySize = () => {
      const value = `${size.toFixed(2)}px`;
      if (element.style.getPropertyValue("--yt-ai-label-size") !== value) element.style.setProperty("--yt-ai-label-size", value);
    };
    applySize();
    if (!overlay || !rect.width || !rect.height) return;
    // Long category names need space for wrapped lines plus the probability line.
    // Refit only when bounds or text change; ordinary rescans do no layout work here.
    while (size > 7) {
      const style = getComputedStyle(overlay);
      const available = overlay.clientHeight - parseFloat(style.paddingTop || 0) - parseFloat(style.paddingBottom || 0);
      const required = [...overlay.children].reduce((sum, line) => sum + Math.max(line.getBoundingClientRect().height, line.scrollHeight), 0) +
        (parseFloat(style.rowGap) || 0) * (overlay.children.length - 1);
      if (required <= available) break;
      size = Math.max(7, size - 0.5);
      applySize();
    }
  }

  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
    for (const { target } of entries) resizeLabel(target);
  }) : null;

  function render(element, result, color) {
    let overlay = overlays.get(element);
    if (!overlay || overlay.parentElement !== element) {
      overlay = document.createElement("span");
      overlay.setAttribute(OVERLAY, "");
      for (const role of ["choice", "probability"]) {
        const line = document.createElement("span");
        line.setAttribute("data-yt-ai-line", role);
        overlay.append(line);
      }
      element.append(overlay);
      overlays.set(element, overlay);
      resizeObserver?.observe(element);
    }
    const texts = [globalThis.ThumbnailClassifiers.byId[result.label].name,
      `Probability: ${Math.round(result.probability * 100)}%`];
    for (let index = 0; index < texts.length; index++) {
      if (overlay.children[index].textContent !== texts[index]) overlay.children[index].textContent = texts[index];
    }
    resizeLabel(element);
    const textColor = foreground(color);
    if (element.style.getPropertyValue("--yt-ai-label-color") !== textColor) element.style.setProperty("--yt-ai-label-color", textColor);
  }

  function remove(element) {
    overlays.get(element)?.remove();
    overlays.delete(element);
    labelLayouts.delete(element);
    resizeObserver?.unobserve(element);
    element.style.removeProperty("--yt-ai-label-size");
    element.style.removeProperty("--yt-ai-label-color");
  }

  // IMG is a replaced element and cannot host a visible child/pseudo-element label.
  // Transfer its rendered box to a temporary span; preserve the image object and URL.
  // On responsive layout changes, measure the image in its original DOM position
  // synchronously before painting, so the wrapper follows the site's sizing rules.
  function wrapImage(image) {
    const wrapper = document.createElement("span");
    wrapper.setAttribute(WRAPPER, "");
    const overrides = new Map();
    const state = { image, wrapper, overrides, refreshing: false, frame: null, parentSize: "" };
    const setImageStyle = (name, value) => {
      if (!overrides.has(name)) overrides.set(name, { value: image.style.getPropertyValue(name), priority: image.style.getPropertyPriority(name), applied: value });
      overrides.get(name).applied = value;
      image.style.setProperty(name, value, "important");
    };
    const restoreImage = () => {
      for (const [name, saved] of overrides) {
        if (image.style.getPropertyValue(name) === saved.applied && image.style.getPropertyPriority(name) === "important") {
          if (saved.value) image.style.setProperty(name, saved.value, saved.priority);
          else image.style.removeProperty(name);
        }
      }
      overrides.clear();
    };
    const parent = image.parentElement;
    const measure = () => {
      const style = getComputedStyle(image);
      const rect = image.getBoundingClientRect();
      const dimension = (axis, sides) => {
        const size = parseFloat(style[axis]);
        if (!Number.isFinite(size)) return axis === "width" ? image.offsetWidth || rect.width : image.offsetHeight || rect.height;
        return size + (style.boxSizing === "border-box" ? 0 : sides.reduce((sum, side) => sum +
          (parseFloat(style.getPropertyValue(`padding-${side}`)) || 0) + (parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0), 0));
      };
      const width = dimension("width", ["left", "right"]);
      const height = dimension("height", ["top", "bottom"]);
      // Copy the outer layout role, including positioned/flex/grid image fallbacks.
      for (const name of ["position", "top", "right", "bottom", "left", "margin-top", "margin-right", "margin-bottom", "margin-left",
        "vertical-align", "flex-grow", "flex-shrink", "flex-basis", "order", "align-self", "justify-self", "grid-area",
        "float", "clear", "transform", "transform-origin", "border-radius", "z-index"]) {
        const value = style.getPropertyValue(name);
        if (value) wrapper.style.setProperty(name, value);
      }
      wrapper.style.display = style.display === "none" ? "none" : ["inline", "inline-block"].includes(style.display) ? "inline-block" : "block";
      wrapper.style.boxSizing = "border-box";
      wrapper.style.width = `${width}px`;
      wrapper.style.height = `${height}px`;
      wrapper.style.lineHeight = "0";
      if (!style.position || style.position === "static") wrapper.style.position = "relative";
    };
    const fillWrapper = () => {
      for (const [name, value] of Object.entries({ display: "block", width: "100%", height: "100%", "max-width": "none", "max-height": "none",
        "min-width": "0", "min-height": "0", "box-sizing": "border-box", "margin-top": "0px", "margin-right": "0px", "margin-bottom": "0px", "margin-left": "0px", position: "static", transform: "none" })) setImageStyle(name, value);
    };
    const refresh = () => {
      state.frame = null;
      if (!wrapper.isConnected || image.parentElement !== wrapper || state.refreshing) return;
      state.refreshing = true;
      restoreImage();
      wrapper.replaceWith(image);
      measure();
      image.replaceWith(wrapper);
      wrapper.prepend(image);
      fillWrapper();
      resizeLabel(wrapper);
      state.refreshing = false;
    };
    const scheduleRefresh = () => {
      if (state.frame === null) state.frame = requestAnimationFrame(refresh);
    };
    measure();
    image.replaceWith(wrapper);
    wrapper.append(image);
    fillWrapper();
    const parentObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      const size = `${parent.clientWidth}:${parent.clientHeight}`;
      if (state.parentSize !== size) { state.parentSize = size; scheduleRefresh(); }
    }) : null;
    state.parentSize = `${parent.clientWidth}:${parent.clientHeight}`;
    parentObserver?.observe(parent);
    image.addEventListener("load", scheduleRefresh);
    window.addEventListener("resize", scheduleRefresh);
    state.dispose = () => {
      parentObserver?.disconnect();
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      image.removeEventListener("load", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
      restoreImage();
    };
    wrappers.set(wrapper, state);
    return wrapper;
  }

  function unwrap(wrapper) {
    const state = wrappers.get(wrapper);
    if (!state) return null;
    state.dispose();
    wrappers.delete(wrapper);
    // YouTube may already have moved or replaced the image while recycling a card.
    if (state.image.parentElement === wrapper) wrapper.replaceWith(state.image);
    else wrapper.remove();
    return state.image;
  }

  function textWithoutOverlay(element) {
    if (!element) return "";
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.parentElement?.closest(`[${OVERLAY}]`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    let text = "";
    while (walker.nextNode()) text += walker.currentNode.textContent;
    return text.trim();
  }

  globalThis.ThumbnailAIOverlay = Object.freeze({ render, remove, wrapImage, unwrap, textWithoutOverlay });
})();
