(() => {
  "use strict";
  const MAX_BYTES = 5 * 1024 * 1024;
  const MAX_PIXELS = 16 * 1024 * 1024;
  class ThumbnailError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  function cleanURL(value) {
    if (typeof value !== "string" || value.length > 4096) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !/^(?:i[1-4]?\.ytimg\.com|img\.youtube\.com)$/.test(url.hostname) ||
          !/^\/(?:vi|vi_webp)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/.test(url.pathname)) return null;
      url.hash = "";
      return url.href;
    } catch { return null; }
  }
  function forElement(element) {
    const images = element.tagName === "IMG" ? [element] : [...element.querySelectorAll("img")];
    for (const img of images) {
      for (const source of [img.currentSrc, img.getAttribute("src"), img.getAttribute("data-thumb")]) {
        const url = cleanURL(source);
        if (url) return url;
      }
    }
    // End-screen suggestions use a CSS background rather than an img element.
    for (const surface of [element, ...element.querySelectorAll(".ytp-videowall-still-image, .ytp-ce-covering-image, .ytp-suggestion-image")]) {
      const background = surface.style.backgroundImage || surface.style.getPropertyValue("--yt-original-background") || getComputedStyle(surface).backgroundImage;
      const url = cleanURL(background?.match(/url\(["']?(.*?)["']?\)/)?.[1]);
      if (url) return url;
    }
    return null;
  }
  async function prepareImage(bytes, mime, signal, runtime, size = "original", verify = false) {
    if (mime !== "image/avif" && size === "original" && !verify) return { bytes, mime };
    if (!runtime.createImageBitmap || !runtime.OffscreenCanvas || !runtime.Blob) {
      throw new ThumbnailError("decode", "This browser could not decode the thumbnail. Update Chrome and try again.");
    }
    signal?.throwIfAborted();
    let bitmap;
    try { bitmap = await runtime.createImageBitmap(new runtime.Blob([bytes], { type: mime })); }
    catch { throw new ThumbnailError("decode", "The thumbnail could not be decoded."); }
    try {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height) || bitmap.width < 1 || bitmap.height < 1 ||
          bitmap.width * bitmap.height > MAX_PIXELS) throw new ThumbnailError("size", "The decoded thumbnail is too large.");
      // YouTube negotiates AVIF at .jpg URLs. Decisions receives supported PNG
      // pixels, preserving the displayed thumbnail rather than guessing another URL.
      let pixelHash;
      if (verify) {
        const original = new runtime.OffscreenCanvas(bitmap.width, bitmap.height);
        const context = original.getContext("2d", { willReadFrequently: true });
        if (!context) throw new ThumbnailError("decode", "The thumbnail canvas is unavailable.");
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const dimensions = new TextEncoder().encode(`${bitmap.width}:${bitmap.height}:RGBA:`);
        const evidence = new Uint8Array(dimensions.length + pixels.length);
        evidence.set(dimensions); evidence.set(pixels, dimensions.length);
        pixelHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", evidence))).map(byte => byte.toString(16).padStart(2, "0")).join("");
        original.width = original.height = 1;
      }
      const maxEdge = size === "original" ? mime === "image/avif" ? 1536 : Infinity : Number(size);
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      if (mime !== "image/avif" && scale === 1) return { bytes, mime, pixelHash, width: bitmap.width, height: bitmap.height };
      const canvas = new runtime.OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
      const context = canvas.getContext("2d");
      if (!context) throw new ThumbnailError("decode", "The thumbnail conversion canvas is unavailable.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      signal?.throwIfAborted();
      if (blob.type !== "image/png" || blob.size > MAX_BYTES) throw new ThumbnailError("size", "The converted thumbnail is too large or has an unsupported format.");
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png", pixelHash, width: canvas.width, height: canvas.height };
    } finally { bitmap.close(); }
  }
  async function prepare(value, signal, fetchImpl = fetch, runtime = globalThis, size = "original", verify = true) {
    const url = cleanURL(value);
    if (!url) throw new ThumbnailError("url", "The thumbnail URL is unsupported.");
    let response;
    try {
      response = await fetchImpl(url, { headers: { Accept: "image/jpeg, image/png, image/webp" },
        credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", signal });
    } catch { throw new ThumbnailError("network", "The thumbnail download failed or timed out."); }
    let mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!response.ok) throw new ThumbnailError("http", `The thumbnail server returned HTTP ${response.status}.`);
    if (!["image/jpeg", "image/png", "image/webp", "image/avif"].includes(mime)) throw new ThumbnailError("format", "The thumbnail server returned an unsupported image format.");
    if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new ThumbnailError("size", "The thumbnail download is too large.");
    const reader = response.body?.getReader();
    if (!reader) throw new ThumbnailError("body", "The thumbnail response has no image body.");
    const parts = []; let length = 0;
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        length += chunk.length;
        if (length > MAX_BYTES) throw new ThumbnailError("size", "The thumbnail download is too large.");
        parts.push(chunk);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    if (!length) throw new ThumbnailError("body", "The thumbnail response is empty.");
    let bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of parts) { bytes.set(chunk, offset); offset += chunk.length; }
    const prepared = await prepareImage(bytes, mime, signal, runtime, ["512", "768"].includes(String(size)) ? String(size) : "original", verify);
    ({ bytes, mime } = prepared);
    signal?.throwIfAborted();
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { dataURL: `data:${mime};base64,${btoa(binary)}`, pixelHash: prepared.pixelHash, width: prepared.width, height: prepared.height };
  }
  async function load(value, signal, fetchImpl = fetch, runtime = globalThis) { return (await prepare(value, signal, fetchImpl, runtime, "original", false)).dataURL; }
  globalThis.ThumbnailImages = Object.freeze({ cleanURL, forElement, load, prepare, MAX_BYTES, MAX_PIXELS, ThumbnailError });
})();
