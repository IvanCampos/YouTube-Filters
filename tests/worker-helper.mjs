import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const cacheSource = await readFile(new URL("../extension/evaluation-cache.js", import.meta.url), "utf8");
const spendingSource = await readFile(new URL("../extension/spending.js", import.meta.url), "utf8");
const patternsSource = await readFile(new URL("../extension/patterns.js", import.meta.url), "utf8");
const api = await readFile(new URL("../extension/decisions.js", import.meta.url), "utf8");
const workSource = await readFile(new URL("../extension/work-sharing.js", import.meta.url), "utf8");
const images = await readFile(new URL("../extension/thumbnail-images.js", import.meta.url), "utf8");
const keywords = await readFile(new URL("../extension/keywords.js", import.meta.url), "utf8");
const catalogSource = await readFile(new URL("../extension/classifiers.js", import.meta.url), "utf8");
const catalogContext = vm.createContext({});
vm.runInContext(catalogSource, catalogContext);
export const catalog = catalogContext.ThumbnailClassifiers;
export const ids = Array.from(catalog.titleIds);
export const youtube = { id: "extension-test", tab: { id: 1 }, url: "https://www.youtube.com/" };
export const popup = { id: "extension-test", url: "chrome-extension://extension-test/popup.html" };
export const answers = (label = "clickbait", metrics = {}) => Object.fromEntries(ids.map(id => [id, {
  type: "predicate", probability: !ids.includes(label) ? "unexpected" : id === label ? 0.92 : 0.02,
  ...(id === label ? metrics : {})
}]));
export const answerResponse = answers => ({ ok: true, json: async () => ({ answers, model: "gpt-6-luna", usage: { input_tokens: 1000, output_tokens: 20 } }) });
export const response = (label = "clickbait", metrics = {}) => answerResponse(answers(label, metrics));

export function worker(fetchImpl = async () => response(), initial = {}, initialSession = {}, options = {}) {
  const local = { enabled: true, keywords: [], aiEnabled: true, openaiApiKey: "test-key-not-a-real-secret", optimizationVersion: 1, ...initial };
  const session = { ...initialSession };
  const listeners = new Set();
  const accesses = {};
  let listener, connectListener;
  let sequence = 0;
  const clientPorts = new Set();
  const calls = [];
  const area = (data, name) => ({
    async get(defaults) { return { ...defaults, ...data }; },
    async remove(key) { delete data[key]; },
    async setAccessLevel(value) { accesses[name] = value.accessLevel; },
    async set(patch) {
      if (name === "local" && "evaluationCache" in patch && options.beforeCacheWrite) await options.beforeCacheWrite(patch);
      if (name === "local" && "spendingLedger" in patch && options.beforeSpendingWrite) await options.beforeSpendingWrite(patch);
      const changes = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { oldValue: data[key], newValue: value }]));
      Object.assign(data, patch);
      for (const callback of listeners) callback(changes, name);
    }
  });
  const chrome = { storage: { local: area(local, "local"), session: area(session, "session"), onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } },
    runtime: { id: "extension-test", getURL: path => `chrome-extension://extension-test/${path}`, onMessage: { addListener: fn => { listener = fn; } }, onConnect: { addListener: fn => { connectListener = fn; } } } };
  const context = vm.createContext({ chrome, crypto: webcrypto, TextEncoder, structuredClone, URL, AbortController,
    btoa, Uint8Array, Blob, Date: options.now ? class extends Date { static now() { return options.now(); } } : Date,
    createImageBitmap: async blob => ({ width: 64, height: 32, bytes: new Uint8Array(await blob.arrayBuffer()), close() {} }),
    OffscreenCanvas: class {
      constructor(width, height) { this.width = width; this.height = height; }
      getContext() { return { drawImage: bitmap => { this.bitmap = bitmap; }, getImageData: () => ({ data: this.bitmap.bytes }) }; }
      async convertToBlob() { return new Blob([this.bitmap.bytes], { type: "image/png" }); }
    },
    ...options.imageRuntime,
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms === 12000 && options.timeoutMs != null ? options.timeoutMs : ms, ...args), clearTimeout,
    fetch: async (...args) => {
      calls.push(args);
      const response = await fetchImpl(...args);
      if (args[0] !== "https://api.openai.com/v1/decisions" || !response.json) return response;
      const parse = response.json.bind(response);
      return { ...response, json: async () => {
        const data = await parse();
        if (data.answers && !Array.isArray(data.answers)) {
          // Legacy test factories use keyed answer fixtures; the wire format is an array.
          const requested = JSON.parse(args[1].body).questions.map(question => question.name);
          data.answers = requested.filter(id => Object.hasOwn(data.answers, id)).map(id => ({ ...data.answers[id], name: id }));
        }
        return data;
      } };
    }, importScripts() { vm.runInContext(catalogSource, context); vm.runInContext(api, context); vm.runInContext(images, context); vm.runInContext(keywords, context); vm.runInContext(cacheSource, context); vm.runInContext(workSource, context); vm.runInContext(spendingSource, context); vm.runInContext(patternsSource, context); } });
  vm.runInContext(background, context);
  const send = (message, sender = youtube) => new Promise(resolve => listener(message, sender, resolve));
  function connect(sender = youtube) {
    const messages = [new Set(), new Set()], disconnections = [new Set(), new Set()];
    let closed = false;
    const ports = [0, 1].map(side => ({
      name: "thumbnail-classification", sender,
      onMessage: { addListener: fn => messages[side].add(fn) },
      onDisconnect: { addListener: fn => disconnections[side].add(fn) },
      postMessage(message) {
        if (closed) throw new Error("Disconnected");
        queueMicrotask(() => { if (!closed) for (const fn of messages[1 - side]) fn(structuredClone(message)); });
      },
      disconnect() { if (!closed) { closed = true; for (const callbacks of disconnections) for (const fn of callbacks) fn(); } }
    }));
    connectListener(ports[1]);
    clientPorts.add(ports[0]);
    return ports[0];
  }
  const subscribe = async (title = "A title", { sender = youtube, relevant = () => true, thumbnailUrl = null } = {}) => {
    const { settings } = await send({ type: "get-settings" });
    const port = connect(sender), requestId = String(++sequence);
    const result = new Promise(resolve => port.onMessage.addListener(message => {
      if (message.type === "check") {
        const eligible = relevant(message);
        if (eligible !== undefined) port.postMessage({ type: "relevance", requestId, checkId: message.checkId, aiRevision: settings.aiRevision, eligible });
      } else if (message.type === "result") { resolve(message); port.disconnect(); }
    }));
    port.postMessage({ type: "subscribe", requestId, title, thumbnailUrl, aiRevision: settings.aiRevision });
    return { result, port, cancel: () => port.postMessage({ type: "cancel", requestId }) };
  };
  const classify = async (title, options) => (await subscribe(title, options)).result;
  return { send, classify, subscribe, connect, calls, chrome, local, session, accesses, clientPorts };

}
