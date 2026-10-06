import test from "node:test";
import assert from "node:assert/strict";
import { popupFixture, settle, chooseStyle, selectedStyle, classifiers } from "./helpers.mjs";

function input(document, id, value, type = "input") {
  const node = document.getElementById(id);
  node.value = value;
  node.dispatchEvent(new document.defaultView.Event(type, { bubbles: true }));
  return node;
}
function key(window, node, value) { node.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); }
const button = (document, name) => [...document.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === name);

test("chips add, edit, cancel, remove and save unfinished entries as literal keywords", async (t) => {
  const { document, window, storage } = await popupFixture(t, { keywords: ["MAGA", "a,b"] });
  assert.equal(document.querySelectorAll(".keyword-chip").length, 2);
  assert.equal(document.querySelector("#save").disabled, true);
  key(window, input(document, "keyword-add", "full review"), "Enter");
  assert.equal(document.querySelector("#keywords").value, "MAGA\na,b\nfull review");
  button(document, "Edit keyword MAGA").click();
  key(window, input(document, "keyword-edit", "abandoned edit"), "Escape");
  assert.ok(button(document, "Edit keyword MAGA"));
  button(document, "Edit keyword MAGA").click();
  key(window, input(document, "keyword-edit", "maga news"), "Enter");
  button(document, "Remove keyword a,b").click();
  input(document, "keyword-add", ".*");
  document.querySelector("#save").click();
  await settle();
  assert.deepEqual(Array.from(storage.values.keywords), ["maga news", "full review", ".*"]);
  assert.equal(document.querySelector("#save").disabled, true);
  assert.equal(document.querySelector("#discard").disabled, true);
  button(document, "Edit keyword full review").click();
  input(document, "keyword-edit", "ＦＵＬＬ review");
  assert.equal(document.querySelector("#save").disabled, false);
  document.querySelector("#save").click();
  await settle();
  assert.deepEqual(Array.from(storage.values.keywords), ["maga news", "ＦＵＬＬ review", ".*"]);
});

test("newline paste and text/chip round trips deduplicate without splitting phrases or commas", async (t) => {
  const { document, window, storage } = await popupFixture(t, { keywords: ["MAGA"] });
  const add = input(document, "keyword-add", "");
  const paste = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { getData: () => "maga\nＣＡＴ\ncat\nfull review\na,b" } });
  add.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, true);
  assert.equal(document.querySelectorAll(".keyword-chip").length, 4);
  document.querySelector("#keyword-mode").click();
  assert.equal(document.querySelector("#keyword-text-editor").hidden, false);
  input(document, "keywords", "full review\nnew phrase\nNEW PHRASE\n.*");
  document.querySelector("#keyword-mode").click();
  assert.equal(document.querySelectorAll(".keyword-chip").length, 3);
  document.querySelector("#save").click();
  await settle();
  assert.deepEqual(Array.from(storage.values.keywords), ["full review", "new phrase", ".*"]);
});

test("draft badges and discard cover both tabs and theme but retain immediate pause", async (t) => {
  const initial = { keywords: ["original"], minProbability: .9, minConfidence: .8, keywordReplacementStyle: "blur", replacementStyle: "solid", popupTheme: "light" };
  const { document, window, storage } = await popupFixture(t, initial);
  input(document, "keyword-add", "draft");
  chooseStyle(document, "classifier", "hide");
  input(document, "popup-theme", "dark", "change");
  assert.equal(document.querySelector("#keywords-tab .draft-dot").hidden, false);
  assert.equal(document.querySelector("#classifiers-tab .draft-dot").hidden, false);
  assert.equal(document.documentElement.dataset.theme, "dark");
  const enabled = document.querySelector("#enabled");
  enabled.checked = false; enabled.dispatchEvent(new window.Event("change"));
  await settle();
  document.querySelector("#discard").click();
  assert.equal(enabled.checked, false);
  assert.equal(storage.values.enabled, false);
  assert.equal(document.querySelector("#keyword-add").value, "");
  assert.equal(document.querySelector("#keywords").value, "original");
  assert.equal(selectedStyle(document, "classifier"), "solid");
  assert.equal(document.documentElement.dataset.theme, "light");
  assert.equal(document.querySelector("#keywords-tab .draft-dot").hidden, true);
  assert.equal(document.querySelector("#classifiers-tab .draft-dot").hidden, true);
  assert.equal(document.querySelector("#discard").disabled, true);
});

test("hide remembers each style in this popup and colors persist while controls are hidden", async (t) => {
  const { document, storage } = await popupFixture(t, { keywordReplacementStyle: "hide", replacementStyle: "hide", keywordColor: "#123456", aiColor: "#abcdef" });
  document.querySelector('[name="keyword-action"][value="modify"]').click();
  document.querySelector('[name="classifier-action"][value="modify"]').click();
  assert.equal(selectedStyle(document, "keyword"), "blur");
  assert.equal(selectedStyle(document, "classifier"), "solid");
  assert.equal(document.querySelector("#keyword-color-row").hidden, true);
  assert.equal(document.querySelector("#ai-color-row").hidden, false);
  chooseStyle(document, "keyword", "grayscale");
  chooseStyle(document, "keyword", "hide");
  document.querySelector('[name="keyword-action"][value="modify"]').click();
  assert.equal(selectedStyle(document, "keyword"), "grayscale");
  assert.equal(selectedStyle(document, "classifier"), "solid");
  chooseStyle(document, "classifier", "placeholder");
  assert.equal(document.querySelector("#ai-color-row").hidden, true);
  document.querySelector("#save").click(); await settle();
  assert.equal(storage.values.keywordColor, "#123456");
  assert.equal(storage.values.aiColor, "#abcdef");
});

test("category groups are complete and saving uses catalog order", async (t) => {
  const { document, storage } = await popupFixture(t);
  const expected = [
    ["Thumbnail images", ["wide_open_mouth"]],
    ["Attention and engagement", ["clickbait", "engagement_bait", "artificial_urgency"]],
    ["Emotional manipulation", ["fear_mongering", "rage_bait", "divisive_framing", "conspiracy_framing", "harassment_pranks"]],
    ["Drama and gossip", ["personal_drama", "celebrity_gossip"]],
    ["Promotional pressure", ["gambling_promotion", "get_rich_quick", "miracle_cure", "shopping_pressure", "financial_price_predictions", "crypto_nft_promotion", "sponsorships_sales_pitches"]],
    ["Content and formats", ["spoilers", "reaction_content", "giveaways_contests", "rankings_listicles"]]
  ];
  assert.deepEqual([...document.querySelectorAll(".classifier-group")].map(group => [group.querySelector("legend").textContent, [...group.querySelectorAll("input")].map(input => input.value)]), expected);
  const check = document.querySelector("#classifier-clickbait"); check.click(); check.click();
  input(document, "popup-theme", "dark", "change");
  document.querySelector("#save").click(); await settle();
  assert.deepEqual(Array.from(storage.values.enabledClassifiers), Array.from(classifiers.titleIds));
});

test("probability slider and number synchronize at boundaries and invalid numbers cannot save", async (t) => {
  const { document, storage } = await popupFixture(t);
  input(document, "probability-slider", "0");
  assert.equal(document.querySelector("#min-probability").value, "0");
  document.querySelector("#save").click(); await settle();
  assert.equal(storage.values.minProbability, 0);
  input(document, "min-probability", "100");
  assert.equal(document.querySelector("#probability-slider").value, "100");
  document.querySelector("#save").click(); await settle();
  assert.equal(storage.values.minProbability, 1);
  assert.equal(document.querySelector("#min-confidence"), null);
  assert.equal(storage.values.minConfidence, undefined);
  input(document, "min-probability", "101");
  document.querySelector("#save").click(); await settle();
  assert.equal(storage.values.minProbability, 1);
  assert.equal(document.activeElement.id, "min-probability");
  assert.equal(document.querySelector("#status").hasAttribute("data-error"), true);
  input(document, "probability-slider", "80");
  assert.equal(document.querySelector("#min-probability").value, "80");
});

test("connection disclosure distinguishes a saved key from a tested connection", async (t) => {
  const { document, storage } = await popupFixture(t, { openaiApiKey: "private-test-key", aiEnabled: true });
  assert.equal(document.querySelector("#api-settings").open, false);
  assert.match(document.querySelector("#connection-state").textContent, /not verified/);
  assert.equal(document.querySelector("#api-key").value, "");
  document.querySelector("#test-key").click(); await settle();
  assert.equal(document.querySelector("#connection-state").textContent, "Connected");
  document.querySelector("#replace-key").click();
  assert.equal(document.querySelector("#key-entry").hidden, false);
  assert.equal(document.activeElement.id, "api-key");
  input(document, "api-key", "new-secret-draft");
  document.querySelector("#discard").click();
  assert.equal(document.querySelector("#api-key").value, "");
  assert.equal(storage.values.openaiApiKey, "private-test-key");
  input(document, "keyword-add", "draft");
  document.querySelector("#remove-key").click(); await settle();
  document.querySelector("#discard").click();
  assert.equal(storage.values.openaiApiKey, "");
  assert.equal(document.querySelector("#ai-enabled").checked, false);
  assert.equal(document.querySelector("#api-settings").open, true);
  assert.equal(document.body.textContent.includes("private-test-key"), false);
});

test("missing keys and validation errors reveal the connection editor", async (t) => {
  const { document } = await popupFixture(t);
  assert.equal(document.querySelector("#api-settings").open, true);
  document.querySelector("#api-settings").open = false;
  document.querySelector("#ai-enabled").click();
  document.querySelector("#save").click(); await settle();
  assert.equal(document.querySelector("#api-settings").open, true);
  assert.equal(document.activeElement.id, "api-key");
  assert.equal(document.querySelector("#classifiers-panel").hidden, false);
});

test("System theme follows OS changes while explicit themes and discard take precedence", async (t) => {
  const listeners = new Set();
  const media = { matches: true, addEventListener(type, listener) { listeners.add(listener); } };
  const { document, storage } = await popupFixture(t, {}, { matchMedia: () => media });
  assert.equal(document.querySelector("#popup-theme").value, "system");
  assert.equal(document.documentElement.dataset.theme, "dark");
  media.matches = false; for (const listener of listeners) listener();
  assert.equal(document.documentElement.dataset.theme, "light");
  input(document, "popup-theme", "dark", "change");
  for (const listener of listeners) listener();
  assert.equal(document.documentElement.dataset.theme, "dark");
  document.querySelector("#discard").click();
  assert.equal(document.documentElement.dataset.theme, "light");
  input(document, "popup-theme", "dark", "change");
  document.querySelector("#save").click(); await settle();
  assert.equal(storage.values.popupTheme, "dark");
  const reopened = await popupFixture(t, storage.values, { matchMedia: () => media });
  assert.equal(reopened.document.documentElement.dataset.theme, "dark");
});

test("failed saves retain chip, theme, slider and style drafts for retry or discard", async (t) => {
  const { document, storage } = await popupFixture(t, { keywords: ["saved"], popupTheme: "light" });
  storage.failWrites();
  input(document, "keyword-add", "unfinished");
  input(document, "popup-theme", "dark", "change");
  input(document, "probability-slider", "95");
  chooseStyle(document, "keyword", "hide");
  document.querySelector("#save").click(); await settle();
  assert.deepEqual(storage.values.keywords, ["saved"]);
  assert.equal(document.querySelector("#keywords").value, "saved\nunfinished");
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(selectedStyle(document, "keyword"), "hide");
  assert.equal(document.querySelector("#min-probability").value, "95");
  assert.equal(document.querySelector("#save").disabled, false);
  assert.equal(document.querySelector("#discard").disabled, false);
  document.querySelector("#discard").click();
  assert.equal(document.querySelector("#keywords").value, "saved");
  assert.equal(document.documentElement.dataset.theme, "light");
  assert.equal(document.querySelector("#min-probability").value, "90");
});

test("upgrade preserves original selections and additions participate in discard and save", async (t) => {
  const original = Array.from(classifiers.ids).slice(0, 12);
  const { document, storage } = await popupFixture(t, { enabledClassifiers: original });
  const selected = () => [...document.querySelectorAll('#classifier-list input:checked')].map(input => input.value);
  assert.equal(selected().length, 12);
  for (const id of classifiers.ids.slice(12)) assert.equal(document.querySelector(`#classifier-${id}`).checked, false);
  document.querySelector('#classifiers-tab').click();
  for (const id of classifiers.ids.slice(12)) document.querySelector(`#classifier-${id}`).click();
  document.querySelector('#discard').click();
  assert.equal(selected().length, 12);
  assert.deepEqual(storage.values.enabledClassifiers, original);
  for (const id of classifiers.ids.slice(12)) document.querySelector(`#classifier-${id}`).click();
  document.querySelector('#save').click(); await settle();
  assert.deepEqual(Array.from(storage.values.enabledClassifiers), Array.from(classifiers.ids));
  assert.equal(document.querySelectorAll('#classifier-list input').length, new Set([...document.querySelectorAll('#classifier-list input')].map(input => input.value)).size);
});

test("cache persistence warnings are visible without changing saved settings or connection verification", async t => {
  const { document, storage } = await popupFixture(t, { openaiApiKey: "saved-test-key" });
  storage.emit({ cacheStatus: { newValue: { error: "Classification cache could not be saved." } } }, "session");
  assert.equal(document.querySelector('#cache-status').hidden, false);
  assert.equal(document.querySelector('#api-settings').open, true);
  assert.match(document.querySelector('#connection-state').textContent, /not verified/);
  assert.equal(document.querySelector('#save').disabled, true);
  storage.emit({ cacheStatus: { newValue: null } }, "session");
  assert.equal(document.querySelector('#cache-status').hidden, true);
});
