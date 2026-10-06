(() => {
  "use strict";
  const { summarize, formatCost, STORAGE_KEY } = globalThis.ThumbnailSpending;
  const $ = id => document.getElementById(id);
  const periods = [["today", "Today"], ["week", "This week"], ["month", "This month"], ["all", "All time"]];
  const count = value => value.toLocaleString();
  const attempts = value => `${count(value)} attempt${value === 1 ? "" : "s"}`;
  const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
  let loading = false, again = false, closed = false;

  function render(result) {
    const data = summarize(result.ledger);
    if (!data) throw new Error("Invalid spending history");
    const details = document.createDocumentFragment();
    for (const [key, label] of periods) {
      const total = data.periods[key];
      $(`spend-${key}`).textContent = formatCost(total.costNanodollars);
      $(`spend-${key}`).toggleAttribute("data-compact", $(`spend-${key}`).textContent.length > 12);
      $(`spend-${key}`).title = `$${(total.costNanodollars / 1e9).toFixed(9)}`;
      const gaps = total.unresolved + total.unpriced;
      $(`spend-${key}-note`).textContent = gaps ? `${count(gaps)} unresolved / unpriced` : total.pending ? `${count(total.pending)} pending` : `${count(total.attempts)} API attempt${total.attempts === 1 ? "" : "s"}`;
      const section = document.createElement("section"), title = document.createElement("h3"), list = document.createElement("dl");
      title.textContent = label;
      for (const [name, value] of [["API attempts", total.attempts], ["Key tests (included)", total.tests], ["Reported input tokens", total.inputTokens],
        ["Reported output tokens", total.outputTokens], ["Pending", total.pending], ["Unresolved usage", total.unresolved], ["Unpriced model / cost", total.unpriced]]) {
        const term = document.createElement("dt"), description = document.createElement("dd");
        term.textContent = name; description.textContent = count(value); list.append(term, description);
      }
      section.append(title, list); details.append(section);
    }
    $("analytics-period-details").replaceChildren(details);
    const all = data.periods.all;
    setText($("analytics-status"), all.attempts ? "Updated automatically · amounts are estimates" : "No API requests recorded yet. Cached results add no spend.");
    const warnings = [];
    if (result.warning) warnings.push(result.warning);
    if (data.incomplete) warnings.push("Some spending could not be recorded accurately. Totals are incomplete.");
    if (all.unresolved || all.unpriced) warnings.push(`Unresolved usage: ${attempts(all.unresolved)}. Unpriced usage: ${attempts(all.unpriced)}. Estimated totals exclude these costs and may understate spend.`);
    if (all.pending) warnings.push(`${count(all.pending)} pending attempt${all.pending === 1 ? " is" : "s are"} not yet included in spend.`);
    const warning = $("analytics-warning");
    setText(warning, warnings.join(" ")); warning.hidden = !warnings.length;
    const started = new Intl.DateTimeFormat(undefined, { timeZone: data.timeZone, dateStyle: "medium", timeStyle: "short" }).format(data.startedAt);
    $("analytics-start").textContent = `Tracking since ${started}. All time covers this installation since that date.`;
    $("analytics-zone").textContent = `Calendar time zone: ${data.timeZone} (saved when tracking began).`;
    const rates = Object.values(data.rates).map(rate => `${rate.model}: ${count(rate.totals.inputTokens)} input / ${count(rate.totals.outputTokens)} output tokens at $${rate.input / 1000} / $${rate.output / 1000} per million tokens.`);
    $("analytics-rates").textContent = rates.length ? `Recorded rates: ${rates.join(" ")}` : "Historical costs retain the rate applied when recorded.";
  }
  async function refresh() {
    if (closed) return;
    if (loading) { again = true; return; }
    loading = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "get-analytics" });
      if (closed) return;
      if (!result?.ok) throw new Error("Unavailable");
      render(result);
    } catch {
      if (!closed) {
        setText($("analytics-status"), "Could not refresh spending. Displayed totals may be out of date; reopen Analytics to retry.");
      }
    } finally {
      loading = false;
      if (again && !closed) { again = false; void refresh(); }
    }
  }
  function onStorage(changes, area) {
    if (area === "local" && changes[STORAGE_KEY] && !$("analytics-panel").hidden) void refresh();
  }
  chrome.storage.onChanged.addListener(onStorage);
  // Also refresh unsaved in-memory totals, warnings, and calendar boundaries.
  const timer = setInterval(() => {
    if (!document.hidden && !$("analytics-panel").hidden) void refresh();
  }, 5000);
  window.addEventListener("focus", () => { if (!$("analytics-panel").hidden) void refresh(); });
  window.addEventListener("pagehide", () => {
    closed = true; clearInterval(timer); chrome.storage.onChanged.removeListener(onStorage);
  }, { once: true });
  globalThis.ThumbnailAnalytics = Object.freeze({ refresh });
})();
