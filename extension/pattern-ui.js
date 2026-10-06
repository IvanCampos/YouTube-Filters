(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const number = value => value.toLocaleString();
  const rate = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : "—";
  const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  const categories = globalThis.ThumbnailClassifiers;
  let loading = false, again = false, closed = false, latest = null, optionsSignature = "";
  function table(host, headers, rows, empty) {
    const element = document.createElement("table"), head = document.createElement("thead"), body = document.createElement("tbody"), heading = document.createElement("tr");
    for (const value of headers) { const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = value; heading.append(cell); }
    head.append(heading);
    for (const values of rows) {
      const row = document.createElement("tr");
      values.forEach((value, index) => { const cell = document.createElement(index ? "td" : "th"); if (!index) cell.scope = "row"; cell.textContent = value; row.append(cell); });
      body.append(row);
    }
    element.append(head, body);
    if (!rows.length) { const note = document.createElement("p"); note.className = "hint"; note.textContent = empty; $(host).replaceChildren(note); }
    else $(host).replaceChildren(element);
  }
  function chart(data) {
    const mode = $("pattern-mode").value;
    const values = data.daily.map(day => mode === "count" ? day.count : day.denominator ? day.count / day.denominator : 0);
    const maximum = mode === "count" ? Math.max(...values, 1) : 1;
    text("pattern-chart-scale", mode === "count" ? `Count scale: 0–${number(maximum)} matches` : "Rate scale: 0–100%");
    const fragment = document.createDocumentFragment();
    data.daily.forEach((day, i) => {
      const bar = document.createElement("span"), fill = document.createElement("span");
      bar.className = "pattern-bar"; fill.className = "pattern-bar-fill";
      fill.style.height = `${100 * values[i] / maximum}%`;
      const changes = day.changes.map(change => change.fields.join(", ")).join("; ");
      bar.title = `${day.day}: ${number(day.count)} matches / ${number(day.denominator)} ${$("pattern-metric").value.startsWith("category:") ? "evaluated" : "encountered"} (${rate(day.count, day.denominator)})${changes ? `. Changes: ${changes}` : ""}`;
      if (changes) { const dot = document.createElement("span"); dot.className = "pattern-change-dot"; bar.append(dot); }
      bar.append(fill); fragment.append(bar);
    });
    $("pattern-chart").replaceChildren(fragment);
    $("pattern-chart").setAttribute("aria-label", `Daily ${mode === "count" ? "match counts" : "match rates"} for ${$("pattern-metric").selectedOptions[0]?.textContent}. Exact values and rule changes are in the following table.`);
    $("pattern-chart-dates").replaceChildren(...[data.daily[0]?.day || "", data.daily.at(-1)?.day || ""].map(day => { const span = document.createElement("span"); span.textContent = day; return span; }));
    table("pattern-daily", ["Date", "Matches", "Rate", "Changes"], data.daily.map(day => [day.day.slice(5), `${number(day.count)} / ${number(day.denominator)}`, rate(day.count, day.denominator), day.changes.map(change => change.fields.join(", ")).join("; ") || "—"]), "No observations yet.");
  }
  function render(data) {
    latest = data;
    const totals = data.totals;
    text("pattern-rate", rate(totals.filtered, totals.encountered));
    text("pattern-rate-caption", `${number(totals.filtered)} of ${number(totals.encountered)} distinct videos filtered`);
    text("pattern-outcomes", `${number(totals.keyword)} keyword · ${number(totals.ai)} AI · ${number(totals.clear)} checked and unchanged · ${number(totals.pending)} pending · ${number(totals.unavailable)} unavailable · ${number(totals.unchecked)} AI not evaluated`);
    text("pattern-status", totals.encountered ? "Local viewport observations · updated automatically" : "No videos observed in this period yet. Browse YouTube with filtering on to start.");
    const warning = [data.warning, data.truncated ? "Some observations in this period were removed by the storage limit. These patterns are incomplete." : ""].filter(Boolean).join(" ");
    text("pattern-warning", warning); $("pattern-warning").hidden = !warning;
    text("pattern-retention", `Tracking since ${new Intl.DateTimeFormat(undefined, { timeZone: data.timeZone, dateStyle: "medium" }).format(data.startedAt)} in ${data.timeZone}. Up to ${data.retentionDays} days and 6,000 video-day observations are kept, subject to a 1.5 MB limit. Video IDs are hashed; titles and URLs are not stored.`);
    table("pattern-keywords", ["Keyword", "Videos", "Share"], Object.entries(totals.keywords).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([word, count]) => [word, number(count), rate(count, totals.keyword)]), "No keyword matches in this period.");
    table("pattern-categories", ["Category", "Qualified", "Shown", "Rate"], categories.ids.filter(id => totals.categories[id].evaluated).sort((a, b) => totals.categories[b].qualified - totals.categories[a].qualified || categories.ids.indexOf(a) - categories.ids.indexOf(b)).map(id => {
      const value = totals.categories[id]; return [categories.byId[id].name, `${number(value.qualified)} / ${number(value.evaluated)}`, number(value.shown), rate(value.qualified, value.evaluated)];
    }), "No AI evaluations observed in this period. Keyword matches skip AI.");
    const options = [["overall", "Overall filtering"], ...data.keywords.map(word => [`keyword:${word}`, `Keyword: ${word}`]), ...categories.catalog.map(category => [`category:${category.id}`, `AI: ${category.name}`])];
    const signature = JSON.stringify(options);
    if (signature !== optionsSignature) {
      const previous = $("pattern-metric").value;
      $("pattern-metric").replaceChildren(...options.map(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; return option; }));
      $("pattern-metric").value = options.some(([value]) => value === previous) ? previous : "overall";
      if ($("pattern-metric").value !== previous) again = true;
      optionsSignature = signature;
    }
    chart(data);
    const comparison = data.comparison;
    if (!comparison.available) text("pattern-comparison", "Comparison needs a fully tracked previous period. Today's partial data is excluded from comparisons.");
    else {
      const current = comparison.current, previous = comparison.previous;
      const difference = current.denominator && previous.denominator ? 100 * current.count / current.denominator - 100 * previous.count / previous.denominator : null;
      text("pattern-comparison", `${comparison.days} completed calendar day${comparison.days === 1 ? "" : "s"}: ${number(current.count)} matches (${rate(current.count, current.denominator)}) vs ${number(previous.count)} (${rate(previous.count, previous.denominator)}) in the previous equivalent period.${difference === null ? "" : ` ${difference > 0 ? "+" : ""}${difference.toFixed(1)} percentage points.`} Today is excluded.`);
    }
  }
  async function refresh() {
    if (closed) return;
    if (loading) { again = true; return; }
    loading = true;
    const period = $("pattern-period").value, metric = $("pattern-metric").value;
    try {
      const data = await chrome.runtime.sendMessage({ type: "get-patterns", period, metric });
      if (closed) return;
      if (period !== $("pattern-period").value || metric !== $("pattern-metric").value) { again = true; return; }
      if (!data?.ok || !data.totals) throw new Error("Unavailable");
      render(data);
    } catch { if (!closed) text("pattern-status", "Could not refresh filtering patterns. Displayed observations may be out of date."); }
    finally { loading = false; if (again && !closed) { again = false; void refresh(); } }
  }
  function onStorage(changes, area) { if (area === "local" && changes.filterPatterns && !$("analytics-panel").hidden) void refresh(); }
  $("pattern-period").addEventListener("change", refresh);
  $("pattern-metric").addEventListener("change", refresh);
  $("pattern-mode").addEventListener("change", () => { if (latest) chart(latest); });
  chrome.storage.onChanged.addListener(onStorage);
  const timer = setInterval(() => { if (!document.hidden && !$("analytics-panel").hidden) void refresh(); }, 5000);
  window.addEventListener("pagehide", () => { closed = true; clearInterval(timer); chrome.storage.onChanged.removeListener(onStorage); }, { once: true });
  globalThis.ThumbnailPatternUI = Object.freeze({ refresh });
})();
