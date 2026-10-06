import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { mockConnect } from "../scripts/mock-port.mjs";
import { JSDOM } from "jsdom";

const source = new URL("../extension/", import.meta.url);
export const files = Object.fromEntries(await Promise.all(
  ["classifiers.js", "thumbnail-images.js", "keywords.js", "ai-overlay.js", "content.js", "content.css", "spending.js", "analytics.js", "pattern-observer.js", "pattern-ui.js", "popup.js", "popup.html"].map(async (file) =>
    [file, await readFile(new URL(file, source), "utf8")])
));

const catalogContext = vm.createContext({});
vm.runInContext(files["classifiers.js"], catalogContext);
export const classifiers = catalogContext.ThumbnailClassifiers;
export function classification(label = "neither", metrics = {}, enabled = classifiers.titleIds) {
  return { schemaVersion: classifiers.schemaVersion, results: Object.fromEntries(enabled.map(id => [id, {
    probability: id === label ? 0.92 : label === "uncertain" ? 0.5 : 0.02, ...(id === label ? metrics : {})
  }])) };
}

export function storageMock(initial = {}) {
  const values = { ...initial };
  const sessionValues = {};
  let revision = 0, scoreRevision = 0;
  const publicSettings = () => ({ enabled: values.enabled !== false, keywords: values.keywords || [],
    patternVersion: values.patternVersion || 0, patternTimeZone: values.patternTimeZone || "UTC",
    aiEnabled: values.aiEnabled === true, keyConfigured: Boolean(values.openaiApiKey || values.keyConfigured), aiRevision: `test-${revision}`, scoreRevision: `owner-${scoreRevision}`, hideEarlyExit: values.hideEarlyExit !== false, imageSize: values.imageSize || "original", imageDetail: values.imageDetail || "high", enabledClassifiers: classifiers.normalize(values.enabledClassifiers),
    keywordColor: values.keywordColor || "#ff0000", aiColor: values.aiColor || "#8000ff", minProbability: values.minProbability ?? 0.9, replacementStyle: values.replacementStyle || "solid", keywordReplacementStyle: values.keywordReplacementStyle ?? "solid" });
  const listeners = new Set();
  let failWrites = false;
  const onChanged = {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener)
  };
  return {
    values,
    publicSettings,
    failWrites() { failWrites = true; },
    emit(changes, area = "local") { for (const listener of listeners) listener(changes, area); },
    api: {
      onChanged,
      local: {
        async get(defaults) { return { ...defaults, ...values }; },
        async set(patch) {
          if (failWrites) throw new Error("Storage unavailable");
          const changes = {};
          for (const [key, value] of Object.entries(patch)) {
            changes[key] = { oldValue: values[key], newValue: value };
            values[key] = value;
          }
          for (const listener of listeners) listener(changes, "local");
          if ("openaiApiKey" in patch) scoreRevision++;
          if (["openaiApiKey", "aiEnabled", "enabled", "enabledClassifiers", "minProbability", "replacementStyle", "hideEarlyExit", "imageSize", "imageDetail"].some((key) => key in patch)) revision++;
          for (const listener of listeners) listener({ publicSettings: { newValue: publicSettings() } }, "session");
        }
      },
      session: {
        async get(defaults) { return { ...defaults, ...sessionValues }; },
        async set(patch) { Object.assign(sessionValues, patch); }
      }
    }
  };
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 410));

export async function contentFixture(t, html, settings = { keywords: ["spoiler"] }, classifier = async () => ({ ok: true, label: "neither" }), options = {}) {
  const dom = new JSDOM(`<!doctype html><style>${files["content.css"]}</style><body>${html}</body>`, {
    url: "https://www.youtube.com/", runScripts: "outside-only", pretendToBeVisual: true
  });
  const storage = storageMock(settings);
  if (options.hidden !== undefined) Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: options.hidden });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 160, left: 0, right: 300, top: 0, bottom: 160 });
  const requests = [], observations = [];
  dom.window.chrome = { storage: storage.api, runtime: { async sendMessage(message) {
    if (message.type === "get-settings") return { ok: true, settings: storage.publicSettings() };
    if (message.type === "record-patterns") { observations.push(message); return { ok: true }; }
    requests.push(message);
    const requested = storage.publicSettings().enabledClassifiers.filter(id => id !== classifiers.imageId || message.thumbnailUrl);
    const result = await classifier(message);
    // Shorthand for existing single-match fixtures; production receives only the new envelope.
    const envelope = Object.hasOwn(result, "label") ? classification(result.label, {
      probability: 0.92, ...result
    }, requested) : result;
    return { aiRevision: message.aiRevision, ok: result.ok, ...envelope };
  } } };
  const ports = [], portMessages = [];
  const connect = (options.connect || mockConnect)(dom.window.chrome.runtime.sendMessage);
  dom.window.chrome.runtime.connect = () => {
    const port = connect(); ports.push(port);
    const post = port.postMessage.bind(port);
    port.postMessage = message => { portMessages.push(message); post(message); };
    return port;
  };
  if (options.IntersectionObserver) dom.window.IntersectionObserver = options.IntersectionObserver;
  dom.window.eval(files["classifiers.js"]);
  dom.window.eval(files["keywords.js"]);
  dom.window.eval(files["thumbnail-images.js"]);
  dom.window.eval(files["ai-overlay.js"]);
  dom.window.eval(files["pattern-observer.js"]);
  dom.window.eval(files["content.js"]);
  t.after(() => {
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    dom.window.close();
  });
  await new Promise(resolve => setTimeout(resolve, 450));
  return { window: dom.window, document: dom.window.document, storage, requests, ports, portMessages, observations };
}

export function card(id, title, tag = "ytd-rich-item-renderer") {
  return `<${tag} data-card="${id}"><ytd-thumbnail style="position:static"><a href="/watch?v=${id}"><img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg"><span>10:00</span></a></ytd-thumbnail><h3><a id="video-title" href="/watch?v=${id}" title="${title}">${title}</a></h3></${tag}>`;
}

export async function popupFixture(t, initial = {}, options = {}) {
  // The real worker migrates a formerly shared style before responding to get-settings.
  initial = { ...initial, keywordReplacementStyle: initial.keywordReplacementStyle ?? initial.replacementStyle ?? "blur" };
  const dom = new JSDOM(files["popup.html"], { url: "https://extension.test/", runScripts: "outside-only" });
  const storage = storageMock(initial);
  if (options.matchMedia) dom.window.matchMedia = options.matchMedia;
  dom.window.chrome = { storage: storage.api, runtime: { async sendMessage(message) {
    if (message?.type === "get-analytics") return { ok: true, ledger: storage.values.spendingLedger || dom.window.ThumbnailSpending.create(), warning: options.analyticsWarning || "" };
    if (message?.type === "get-patterns") return options.patterns || { ok: true, totals: { encountered: 0, filtered: 0, keyword: 0, ai: 0, clear: 0, pending: 0, unavailable: 0, unchecked: 0, keywords: {}, categories: Object.fromEntries(classifiers.ids.map(id => [id, { evaluated: 0, qualified: 0, shown: 0 }])) }, daily: [], keywords: [], comparison: { available: false }, startedAt: Date.now(), timeZone: "UTC", retentionDays: 90 };
    return { ok: true, settings: storage.publicSettings() };
  } } };
  dom.window.eval(files["classifiers.js"]);
  dom.window.eval(files["keywords.js"]);
  dom.window.eval(files["spending.js"]);
  dom.window.eval(files["analytics.js"]);
  dom.window.eval(files["pattern-ui.js"]);
  dom.window.eval(files["popup.js"]);
  t.after(() => dom.window.close());
  await settle();
  return { window: dom.window, document: dom.window.document, storage };
}

export function chooseStyle(document, prefix, style) {
  const action = document.querySelector(`[name="${prefix}-action"][value="${style === "hide" ? "hide" : "modify"}"]`);
  action.checked = true;
  if (style !== "hide") document.querySelector(`[name="${prefix}-style"][value="${style}"]`).checked = true;
  action.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
}

export function selectedStyle(document, prefix) {
  return document.querySelector(`[name="${prefix}-action"]:checked`).value === "hide" ? "hide" : document.querySelector(`[name="${prefix}-style"]:checked`).value;
}
