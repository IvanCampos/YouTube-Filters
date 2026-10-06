(() => {
  "use strict";
  const { cleanKeywords, cleanColor, cleanThreshold, cleanStyle } = globalThis.RedThumbnailKeywords;
  const classifiers = globalThis.ThumbnailClassifiers;
  const $ = id => document.getElementById(id);
  const controls = $("controls"), form = $("settings-form"), status = $("status");
  const keywordText = $("keywords"), keywordAdd = $("keyword-add"), chips = $("keyword-chips");
  const enabled = $("enabled"), aiEnabled = $("ai-enabled"), apiKey = $("api-key");
  const theme = $("popup-theme"), connection = $("api-settings");
  const probability = $("min-probability"), probabilitySlider = $("probability-slider");
  const keywordColor = $("keyword-color"), aiColor = $("ai-color");
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)");
  const cleanTheme = value => ["system", "light", "dark"].includes(value) ? value : "system";
  let saved = null, loaded = false, busy = false, testing = false, hasSavedKey = false;
  let aiConnection = null, credentialRevision = 0, editingIndex = null, textMode = false;
  const tabScroll = new Map();

  function message(text, error = false) {
    status.textContent = text;
    status.toggleAttribute("data-error", error);
  }
  function applyTheme() {
    document.documentElement.dataset.theme = theme.value === "system" ? systemTheme?.matches ? "dark" : "light" : theme.value;
  }
  systemTheme?.addEventListener("change", applyTheme);

  function selectTab(selected, focus = false) {
    const previous = tabs.find(tab => tab.getAttribute("aria-selected") === "true");
    if (previous !== selected) tabScroll.set(previous?.id, $("panel-scroll").scrollTop);
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      $(tab.getAttribute("aria-controls")).hidden = !active;
    }
    if (previous !== selected) $("panel-scroll").scrollTop = tabScroll.get(selected.id) || 0;
    if (focus) selected.focus();
    if (selected.id === "analytics-tab") { globalThis.ThumbnailAnalytics.refresh(); globalThis.ThumbnailPatternUI?.refresh(); }
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", event => {
      const index = tabs.indexOf(tab);
      const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
        event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : null;
      if (target !== null) { event.preventDefault(); selectTab(tabs[target], true); }
    });
  }

  function replacementControl(id, prefix, fallback, color, colorRow) {
    const host = $(id);
    // All markup here is static; user-entered keywords are rendered with textContent.
    host.innerHTML = `<fieldset><legend>On a match</legend><div class="action-options">
      <label class="action-option"><input type="radio" name="${prefix}-action" value="modify" checked>Modify thumbnail</label>
      <label class="action-option"><input type="radio" name="${prefix}-action" value="hide">Hide entire video</label></div>
      <div class="style-options" role="group" aria-label="${prefix === "keyword" ? "Keyword" : "Classifier"} thumbnail style"></div>
      <p class="hide-hint" hidden>Remove the video card, including its thumbnail and title, from the page.</p></fieldset>`;
    const options = host.querySelector(".style-options");
    for (const [value, label] of [["solid", "Solid color"], ["blur", "Blur"], ["grayscale", "Grayscale"], ["placeholder", "Placeholder"]]) {
      const tile = document.createElement("label");
      tile.className = "style-option";
      tile.innerHTML = `<input type="radio" name="${prefix}-style" value="${value}" aria-label="${label}"${value === fallback ? " checked" : ""}><span class="tile-art" data-style="${value}" aria-hidden="true"></span><span>${label}</span>`;
      options.append(tile);
    }
    const value = () => host.querySelector(`[name="${prefix}-action"]:checked`).value === "hide" ? "hide" : host.querySelector(`[name="${prefix}-style"]:checked`).value;
    const update = () => {
      const hide = value() === "hide";
      options.hidden = hide;
      host.querySelector(".hide-hint").hidden = !hide;
      $(colorRow).hidden = value() !== "solid";
      host.style.setProperty("--style-color", color.value);
    };
    host.addEventListener("change", changed);
    return { value, update, set(style) {
      host.querySelector(`[name="${prefix}-action"][value="${style === "hide" ? "hide" : "modify"}"]`).checked = true;
      if (style !== "hide") host.querySelector(`[name="${prefix}-style"][value="${style}"]`).checked = true;
      update();
    } };
  }
  const keywordStyle = replacementControl("keyword-replacement-style", "keyword", "blur", keywordColor, "keyword-color-row");
  const classifierStyle = replacementControl("replacement-style", "classifier", "solid", aiColor, "ai-color-row");

  const groups = [
    ["Thumbnail images", ["wide_open_mouth"]],
    ["Attention and engagement", ["clickbait", "engagement_bait", "artificial_urgency"]],
    ["Emotional manipulation", ["fear_mongering", "rage_bait", "divisive_framing", "conspiracy_framing", "harassment_pranks"]],
    ["Drama and gossip", ["personal_drama", "celebrity_gossip"]],
    ["Promotional pressure", ["gambling_promotion", "get_rich_quick", "miracle_cure", "shopping_pressure", "financial_price_predictions", "crypto_nft_promotion", "sponsorships_sales_pitches"]],
    ["Content and formats", ["spoilers", "reaction_content", "giveaways_contests", "rankings_listicles"]]
  ];
  const categoryInputs = new Map();
  for (const [name, ids] of groups) {
    const group = document.createElement("fieldset");
    group.className = "classifier-group";
    const legend = document.createElement("legend");
    legend.textContent = name;
    group.append(legend);
    for (const id of ids) {
      const category = classifiers.byId[id];
      const label = document.createElement("label");
      label.className = "classifier-option";
      const input = document.createElement("input");
      input.type = "checkbox"; input.value = id; input.id = `classifier-${id}`;
      input.setAttribute("aria-label", category.name);
      input.setAttribute("aria-describedby", `${input.id}-description`);
      const copy = document.createElement("span"), title = document.createElement("strong"), description = document.createElement("small");
      title.textContent = category.name; description.textContent = category.description;
      description.id = `${input.id}-description`;
      copy.append(title, description); label.append(input, copy); group.append(label);
      categoryInputs.set(id, input);
      input.addEventListener("change", changed);
    }
    $("classifier-list").append(group);
  }

  function currentKeywords() {
    const values = cleanKeywords(keywordText.value.split(/\r?\n/));
    if (editingIndex !== null && $("keyword-edit")) values.splice(editingIndex, 1, $("keyword-edit").value);
    if (!textMode && keywordAdd.value.trim()) values.push(keywordAdd.value);
    return cleanKeywords(values);
  }
  function snapshot() {
    return { keywords: currentKeywords(), aiEnabled: aiEnabled.checked,
      enabledClassifiers: classifiers.ids.filter(id => categoryInputs.get(id).checked),
      keywordColor: keywordColor.value, aiColor: aiColor.value,
      keywordReplacementStyle: keywordStyle.value(), replacementStyle: classifierStyle.value(),
      hideEarlyExit: $("hide-early-exit").checked, imageSize: classifiers.cleanImageSize($("image-size").value), imageDetail: classifiers.cleanImageDetail($("image-detail").value),
      minProbability: probability.valueAsNumber / 100, popupTheme: cleanTheme(theme.value) };
  }
  const differs = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
  function dirtyState() {
    if (!saved) return { keywords: false, classifiers: false, any: false };
    const next = snapshot();
    const keywordDirty = ["keywords", "keywordColor", "keywordReplacementStyle"].some(key => differs(next[key], saved[key]));
    const classifierDirty = ["aiEnabled", "enabledClassifiers", "aiColor", "replacementStyle", "minProbability", "hideEarlyExit", "imageSize", "imageDetail"].some(key => differs(next[key], saved[key])) || Boolean(apiKey.value.trim());
    return { keywords: keywordDirty, classifiers: classifierDirty, any: keywordDirty || classifierDirty || next.popupTheme !== saved.popupTheme };
  }
  function updateUI() {
    const dirty = dirtyState();
    for (const [id, name] of [["keywords", "Keywords"], ["classifiers", "Classifiers"]]) {
      $(`${id}-tab`).querySelector(".draft-dot").hidden = !dirty[id];
      $(`${id}-tab`).setAttribute("aria-label", dirty[id] ? `${name}, unsaved changes` : name);
    }
    controls.disabled = !loaded || Boolean(busy);
    $("save").disabled = !loaded || Boolean(busy) || !dirty.any;
    $("discard").disabled = !loaded || Boolean(busy) || !dirty.any;
    $("save").textContent = busy === "save" ? "Saving…" : "Save all settings";
    const length = currentKeywords().length;
    $("keyword-count").textContent = `${length} keyword${length === 1 ? "" : "s"}`;
    $("filter-state").textContent = enabled.checked ? "On · applies to YouTube" : "Paused · originals shown";
    keywordStyle.update(); classifierStyle.update(); applyTheme();
    const selection = classifiers.ids.filter(id => categoryInputs.get(id).checked);
    $("category-preset").value = Object.keys(classifiers.presets).find(key => JSON.stringify(classifiers.normalize(classifiers.presets[key])) === JSON.stringify(selection)) || "custom";
    $("test-key").disabled = !hasSavedKey || testing;
    $("remove-key").disabled = !hasSavedKey;
    $("replace-key").hidden = !hasSavedKey || !$("key-entry").hidden;
    $("get-key").hidden = hasSavedKey;
    apiKey.placeholder = hasSavedKey ? "New key · leave blank to keep saved key" : "Paste your API key";
    $("key-help").textContent = hasSavedKey ? "Your saved key is not displayed. Save to replace it; leave blank to keep it." : "Saved locally, never synced. Save your key before testing the connection.";
    $("connection-state").textContent = !hasSavedKey ? "No key saved" : testing ? "Testing saved key…" : aiConnection?.ok === false ? "Key saved · needs attention" : aiConnection?.ok === true ? "Connected" : "Key saved · not verified";
    connection.toggleAttribute("data-error", hasSavedKey && aiConnection?.ok === false);
  }
  function changed() {
    updateUI();
    message(dirtyState().any ? "Unsaved changes · save to apply" : "All changes saved.");
  }
  function button(text, label, handler, className = "") {
    const result = document.createElement("button");
    result.type = "button"; result.className = className; result.textContent = text;
    if (label) result.setAttribute("aria-label", label);
    result.addEventListener("click", handler);
    return result;
  }
  function renderKeywords() {
    chips.replaceChildren();
    const values = cleanKeywords(keywordText.value.split(/\r?\n/));
    if (!values.length) {
      const empty = document.createElement("p"); empty.className = "empty-keywords";
      empty.textContent = "Add words or phrases you’d rather skip."; chips.append(empty);
    }
    values.forEach((value, index) => {
      const chip = document.createElement("div"); chip.className = "keyword-chip";
      if (editingIndex === index) {
        chip.classList.add("editing");
        const edit = document.createElement("input"); edit.id = "keyword-edit"; edit.type = "text"; edit.value = value;
        edit.setAttribute("aria-label", `Edit keyword ${value}`);
        const finish = () => { commitKeywords(); changed(); keywordAdd.focus(); };
        const cancel = () => { editingIndex = null; renderKeywords(); changed(); chips.querySelectorAll(".chip-edit")[index]?.focus(); };
        edit.addEventListener("input", changed);
        edit.addEventListener("keydown", event => { if (["Enter", "Escape"].includes(event.key)) { event.preventDefault(); event.key === "Enter" ? finish() : cancel(); } });
        chip.append(edit, button("Apply", "Apply keyword edit", finish), button("Cancel", "Cancel keyword edit", cancel));
      } else {
        chip.append(button(value, `Edit keyword ${value}`, () => {
          commitKeywords();
          const key = value.normalize("NFKC").toLowerCase();
          const target = cleanKeywords(keywordText.value.split(/\r?\n/)).findIndex(item => item.normalize("NFKC").toLowerCase() === key);
          editingIndex = target === -1 ? null : target;
          renderKeywords(); changed(); ($("keyword-edit") || keywordAdd).focus();
        }, "chip-edit"), button("×", `Remove keyword ${value}`, () => {
          const remaining = currentKeywords();
          // Resolve the original chip by normalized text if an edit changed list positions.
          const key = value.normalize("NFKC").toLowerCase();
          const target = remaining.findIndex(item => item.normalize("NFKC").toLowerCase() === key);
          if (target !== -1) remaining.splice(target, 1);
          setKeywords(remaining); changed();
          const next = chips.querySelectorAll(".chip-edit"); (next[Math.min(index, next.length - 1)] || keywordAdd).focus();
        }, "chip-remove"));
      }
      chips.append(chip);
    });
  }
  function setKeywords(values) {
    keywordText.value = cleanKeywords(values).join("\n"); keywordAdd.value = ""; editingIndex = null; renderKeywords();
  }
  function commitKeywords() { setKeywords(currentKeywords()); }
  $("keyword-add-button").addEventListener("click", () => { commitKeywords(); changed(); keywordAdd.focus(); });
  keywordAdd.addEventListener("input", changed);
  keywordAdd.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); commitKeywords(); changed(); }
    if (event.key === "Escape") { event.preventDefault(); keywordAdd.value = ""; changed(); }
  });
  keywordAdd.addEventListener("paste", event => {
    const pasted = event.clipboardData?.getData("text");
    if (!pasted || !/[\r\n]/.test(pasted)) return;
    event.preventDefault();
    const value = keywordAdd.value.slice(0, keywordAdd.selectionStart) + pasted + keywordAdd.value.slice(keywordAdd.selectionEnd);
    keywordAdd.value = "";
    setKeywords([...currentKeywords(), ...value.split(/\r?\n/)]); changed();
  });
  keywordText.addEventListener("input", changed);
  $("keyword-mode").addEventListener("click", () => {
    commitKeywords(); textMode = !textMode;
    $("keyword-chip-editor").hidden = textMode; $("keyword-text-editor").hidden = !textMode;
    $("keyword-mode").textContent = textMode ? "Use chips" : "Edit as text";
    $("keyword-mode").setAttribute("aria-pressed", String(textMode));
    changed(); (textMode ? keywordText : keywordAdd).focus();
  });
  probabilitySlider.addEventListener("input", () => { probability.value = probabilitySlider.value; changed(); });
  probability.addEventListener("input", () => {
    if (Number.isInteger(probability.valueAsNumber) && probability.valueAsNumber >= 0 && probability.valueAsNumber <= 100) probabilitySlider.value = probability.value;
    changed();
  });
  for (const control of [keywordColor, aiColor, aiEnabled, apiKey]) control.addEventListener("input", changed);
  theme.addEventListener("change", changed);
  for (const id of ["hide-early-exit", "image-size", "image-detail"]) $(id).addEventListener("change", changed);
  $("category-preset").addEventListener("change", () => {
    const ids = classifiers.presets[$("category-preset").value];
    if (ids) for (const [id, input] of categoryInputs) input.checked = ids.includes(id);
    changed();
  });

  function showAIStatus(value) {
    aiConnection = value;
    $("ai-status").textContent = value?.error || value?.message || "";
    $("ai-status").toggleAttribute("data-error", value?.ok === false);
    if (value?.ok === false) connection.open = true;
    updateUI();
  }
  function restoreDraft() {
    setKeywords(saved.keywords);
    aiEnabled.checked = saved.aiEnabled;
    $("hide-early-exit").checked = saved.hideEarlyExit;
    $("image-size").value = saved.imageSize; $("image-detail").value = saved.imageDetail;
    for (const [id, input] of categoryInputs) input.checked = saved.enabledClassifiers.includes(id);
    keywordColor.value = saved.keywordColor; aiColor.value = saved.aiColor;
    keywordStyle.set(saved.keywordReplacementStyle); classifierStyle.set(saved.replacementStyle);
    probability.value = String(Math.round(saved.minProbability * 100));
    probabilitySlider.value = probability.value;
    theme.value = saved.popupTheme; apiKey.value = "";
    $("key-entry").hidden = hasSavedKey; connection.open = !hasSavedKey || aiConnection?.ok === false;
    updateUI();
  }
  $("discard").addEventListener("click", () => { restoreDraft(); message("Unsaved changes discarded."); });
  $("replace-key").addEventListener("click", () => { connection.open = true; $("key-entry").hidden = false; updateUI(); apiKey.focus(); });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!loaded || busy) return;
    if (!Number.isInteger(probability.valueAsNumber) || probability.valueAsNumber < 0 || probability.valueAsNumber > 100) {
      selectTab($("classifiers-tab")); message("Enter a whole percentage from 0 to 100 for the minimum match probability.", true); probability.focus(); return;
    }
    const newKey = apiKey.value.trim();
    if ((newKey && (newKey.length > 1024 || /[\s\x00-\x1f\x7f]/.test(newKey))) || (aiEnabled.checked && !hasSavedKey && !newKey)) {
      selectTab($("classifiers-tab")); connection.open = true; $("key-entry").hidden = false; updateUI(); apiKey.focus();
      message(newKey ? "The API key must be a single token without spaces or line breaks." : "Enter your OpenAI Decisions API key before enabling classification.", true); return;
    }
    commitKeywords();
    const patch = snapshot();
    busy = "save"; updateUI(); message("Saving…");
    try {
      await chrome.storage.local.set(newKey ? { ...patch, openaiApiKey: newKey } : patch);
      saved = patch;
      if (newKey) { hasSavedKey = true; credentialRevision++; aiConnection = null; $("ai-status").textContent = ""; }
      apiKey.value = ""; $("key-entry").hidden = hasSavedKey;
      if (hasSavedKey && aiConnection?.ok !== false) connection.open = false;
      message(saved.keywords.length || (saved.aiEnabled && saved.enabledClassifiers.length) ? "Saved · updated in your YouTube tabs" : "Saved · list empty, all thumbnails shown");
    } catch { message("Could not save. Your edits are still here; please try again.", true); }
    finally { busy = false; updateUI(); }
  });
  enabled.addEventListener("change", async () => {
    const next = enabled.checked; busy = "pause"; updateUI();
    try {
      await chrome.storage.local.set({ enabled: next });
      message(dirtyState().any ? "Filter updated · other edits are unsaved" : next ? "Filtering enabled." : "Filtering paused. Original thumbnails restored.");
    } catch { enabled.checked = !next; message("Could not update the filter. Please try again.", true); }
    finally { busy = false; updateUI(); }
  });
  $("test-key").addEventListener("click", async () => {
    if (apiKey.value.trim()) { message("Save the new key before testing it.", true); return; }
    const revision = credentialRevision;
    testing = true; showAIStatus({ message: "Testing with a neutral sample title…" });
    try {
      const result = await chrome.runtime.sendMessage({ type: "test-openai" });
      if (revision === credentialRevision) showAIStatus(result?.ok ? { ok: true, message: "Connected. Your saved key works." } : { ok: false, error: result?.error || "The connection test failed. Try again." });
    } catch { if (revision === credentialRevision) showAIStatus({ ok: false, error: "Could not contact the extension. Reload it and try again." }); }
    finally { testing = false; updateUI(); }
  });
  $("remove-key").addEventListener("click", async () => {
    busy = "remove"; updateUI();
    try {
      await chrome.storage.local.set({ openaiApiKey: "", aiEnabled: false });
      hasSavedKey = false; credentialRevision++; saved.aiEnabled = false; aiEnabled.checked = false; apiKey.value = "";
      $("key-entry").hidden = false; connection.open = true; showAIStatus(null);
      message("API key removed. AI classification is off.");
    } catch { message("Could not remove the API key. Please try again.", true); }
    finally { busy = false; updateUI(); }
  });
  function showCacheStatus(value) {
    $("cache-status").textContent = value?.error || "";
    $("cache-status").hidden = !value?.error;
    if (value?.error) connection.open = true;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.cacheStatus) showCacheStatus(changes.cacheStatus.newValue);
    if (area === "session" && changes.aiStatus) showAIStatus(changes.aiStatus.newValue);
  });

  // Wake the worker so storage access and legacy style migration complete first.
  chrome.runtime.sendMessage({ type: "get-settings" }).then(result => {
    if (!result?.ok) throw new Error("Settings unavailable");
    return chrome.storage.local.get({ enabled: true, keywords: [], aiEnabled: false, openaiApiKey: "", keywordColor: "#ff0000", aiColor: "#8000ff", minProbability: .9, replacementStyle: null, keywordReplacementStyle: null, enabledClassifiers: null, hideEarlyExit: true, imageSize: "original", imageDetail: "high", popupTheme: "system" });
  }).then(settings => {
    saved = { hideEarlyExit: settings.hideEarlyExit !== false, imageSize: classifiers.cleanImageSize(settings.imageSize), imageDetail: classifiers.cleanImageDetail(settings.imageDetail), keywords: cleanKeywords(settings.keywords), aiEnabled: settings.aiEnabled === true, enabledClassifiers: classifiers.normalize(settings.enabledClassifiers),
      keywordColor: cleanColor(settings.keywordColor, "#ff0000"), aiColor: cleanColor(settings.aiColor, "#8000ff"),
      keywordReplacementStyle: cleanStyle(settings.keywordReplacementStyle, "blur"), replacementStyle: cleanStyle(settings.replacementStyle),
      minProbability: cleanThreshold(settings.minProbability, .9), popupTheme: cleanTheme(settings.popupTheme) };
    enabled.checked = settings.enabled !== false; hasSavedKey = Boolean(settings.openaiApiKey); loaded = true;
    restoreDraft(); message("All changes saved.");
    const revision = credentialRevision;
    chrome.storage.session.get({ aiStatus: null, cacheStatus: null }).then(({ aiStatus, cacheStatus }) => { if (revision === credentialRevision) { showAIStatus(aiStatus); showCacheStatus(cacheStatus); } }).catch(() => {});
  }).catch(() => message("Could not load settings. Close and reopen this popup to try again.", true));
})();
