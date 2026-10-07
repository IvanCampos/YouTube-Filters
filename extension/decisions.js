(() => {
  "use strict";
  const ENDPOINT = "https://api.openai.com/v1/decisions";
  const MODEL = "gpt-6-luna";
  const classifiers = globalThis.ThumbnailClassifiers;

  class ClassificationError extends Error {
    constructor(code, message, retryAt = 0) {
      super(message);
      this.code = code;
      this.retryAt = retryAt;
    }
  }

  function requestBody(title, enabled = classifiers.titleIds, imageData = null, detail = "high") {
    const requested = classifiers.normalize(enabled);
    const withImage = requested.some(classifiers.isImage);
    if (withImage && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageData || "")) {
      throw new ClassificationError("thumbnail", "A supported thumbnail image is required for the selected image checks.", Date.now() + 60000);
    }
    return {
      model: MODEL,
      input: withImage ? [{ role: "user", content: [
        { type: "input_text", text: title },
        { type: "input_image", image_url: imageData, detail: classifiers.cleanImageDetail(detail) }
      ] }] : title,
      questions: requested.map(id => ({ type: "predicate", name: id,
        instructions: classifiers.instructions(id)
      }))
    };
  }

  async function classify(title, apiKey, signal, enabled = classifiers.titleIds, fetchImpl = fetch, onUsage = async () => {}, imageData = null, detail = "high") {
    const body = requestBody(title, enabled, imageData, detail);
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body), credentials: "omit", redirect: "error",
        referrerPolicy: "no-referrer", cache: "no-store", signal
      });
    } catch {
      throw new ClassificationError("network", "OpenAI could not be reached. Check your connection and try again.", Date.now() + 30000);
    }
    let data;
    try { data = await response.json(); } catch { /* Usage and answers may be unavailable independently. */ }
    await onUsage({ model: data?.model, usage: data?.usage });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new ClassificationError("auth", "OpenAI rejected the API key or access. Update it and check Decisions access, then test again.");
      if (response.status === 429 || response.status >= 500) {
        const header = response.headers?.get("retry-after");
        const seconds = Number(header);
        const delay = header && !Number.isFinite(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
        const retryAt = Date.now() + Math.max(30000, Number.isFinite(delay) ? delay : 0);
        throw new ClassificationError("temporary", "OpenAI is busy or rate-limited. Classification will retry after a pause.", retryAt);
      }
      throw new ClassificationError("request", `OpenAI returned HTTP ${response.status}. Test again or check your account's Decisions access.`);
    }
    const requested = classifiers.normalize(enabled);
    const result = { schemaVersion: classifiers.schemaVersion, results: {}, unresolved: {} };
    // Each requested name must occur exactly once. One bad question does not
    // discard independently valid answers, and positions never identify scores.
    const answers = Array.isArray(data?.answers) ? data.answers : [];
    for (const id of requested) {
      const matches = answers.filter(answer => answer?.name === id);
      const answer = matches.length === 1 ? matches[0] : null;
      if (answer?.type === "predicate" && typeof answer.probability === "number" && Number.isFinite(answer.probability) && answer.probability >= 0 && answer.probability <= 1) {
        result.results[id] = { probability: answer.probability };
      } else result.unresolved[id] = { code: answer?.type === "refusal" ? "refusal" : "response" };
    }
    result.complete = Object.keys(result.unresolved).length === 0;
    return result;
  }
  globalThis.OpenAIDecisions = Object.freeze({ classify, requestBody, ClassificationError, MODEL, ENDPOINT });
})();
