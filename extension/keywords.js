(() => {
  "use strict";

  const normalize = (text) => text.normalize("NFKC").toLowerCase();

  function cleanKeywords(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.filter((item) => typeof item === "string").map((item) => item.trim())
      .filter((item) => {
        const key = normalize(item);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function createMatcher(keywords) {
    // Unicode-aware boundaries keep words intact, including combining marks.
    const wordCharacter = "[\\p{L}\\p{M}\\p{N}_]";
    const values = cleanKeywords(keywords);
    const needles = values.map((keyword) => {
      const literal = normalize(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<!${wordCharacter})${literal}(?!${wordCharacter})`, "u");
    });
    const match = (title) => {
      if (typeof title !== "string" || needles.length === 0) return false;
      const normalizedTitle = normalize(title);
      return needles.some((keyword) => keyword.test(normalizedTitle));
    };
    match.all = title => {
      if (typeof title !== "string") return [];
      const normalizedTitle = normalize(title);
      return values.filter((_, index) => needles[index].test(normalizedTitle));
    };
    return match;
  }

  const cleanColor = (value, fallback) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
  const cleanThreshold = (value, fallback = 0) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
  const cleanStyle = (value, fallback = "solid") => ["solid", "blur", "grayscale", "placeholder", "hide"].includes(value) ? value : fallback;
  globalThis.RedThumbnailKeywords = Object.freeze({ cleanKeywords, createMatcher, cleanColor, cleanThreshold, cleanStyle });
})();
