import test from "node:test";
import assert from "node:assert/strict";
import { popupFixture, settle, chooseStyle, selectedStyle } from "./helpers.mjs";

test("loads existing settings and saves an edited, de-duplicated keyword list", async (t) => {
  const { document, window, storage } = await popupFixture(t, { keywords: ["spoiler"], enabled: true });
  const input = document.querySelector("#keywords");
  assert.equal(input.value, "spoiler");
  assert.equal(document.querySelector("#controls").disabled, false);
  input.value = "  Cat \ncat\nfull review\n\n";
  input.dispatchEvent(new window.Event("input"));
  assert.equal(document.querySelector("#keyword-count").textContent, "2 keywords");
  assert.match(document.querySelector("#status").textContent, /Unsaved/);
  document.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.deepEqual(Array.from(storage.values.keywords), ["Cat", "full review"]);
  assert.equal(input.value, "Cat\nfull review");
  assert.match(document.querySelector("#status").textContent, /Saved/);
});

test("pause saves immediately and does not save an unfinished keyword draft", async (t) => {
  const { document, window, storage } = await popupFixture(t, { keywords: ["spoiler"] });
  document.querySelector("#keywords").value = "unsaved";
  const enabled = document.querySelector("#enabled");
  enabled.checked = false;
  enabled.dispatchEvent(new window.Event("change"));
  await settle();
  assert.equal(storage.values.enabled, false);
  assert.deepEqual(storage.values.keywords, ["spoiler"]);
  assert.match(document.querySelector("#filter-state").textContent, /Paused/);
});

test("allows deleting the entire list", async (t) => {
  const { document, window, storage } = await popupFixture(t, { keywords: ["spoiler"] });
  document.querySelector("#keywords").value = "";
  document.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(storage.values.keywords.length, 0);
  assert.match(document.querySelector("#status").textContent, /empty/);
});

test("storage failures keep edits and visibly report failure", async (t) => {
  const { document, window, storage } = await popupFixture(t);
  storage.failWrites();
  document.querySelector("#keywords").value = "spoiler";
  document.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(document.querySelector("#keywords").value, "spoiler");
  assert.equal(document.querySelector("#status").hasAttribute("data-error"), true);
  assert.equal(document.querySelector("#controls").disabled, false);
  const enabled = document.querySelector("#enabled");
  enabled.checked = false;
  enabled.dispatchEvent(new window.Event("change"));
  await settle();
  assert.equal(enabled.checked, true);
});

test("saves a user's key and opt-in without redisplaying the saved secret", async (t) => {
  const { document, window, storage } = await popupFixture(t);
  document.querySelector("#api-key").value = "dummy-user-key";
  document.querySelector("#ai-enabled").checked = true;
  document.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(storage.values.openaiApiKey, "dummy-user-key");
  assert.equal(storage.values.aiEnabled, true);
  assert.equal(document.querySelector("#api-key").value, "");
  assert.equal(document.body.textContent.includes("dummy-user-key"), false);
  assert.equal(document.querySelector("#test-key").disabled, false);
});

test("blank key preserves saved credentials and removal disables AI", async (t) => {
  const { document, window, storage } = await popupFixture(t, { openaiApiKey: "existing-dummy-key", aiEnabled: true });
  assert.equal(document.querySelector("#api-key").value, "");
  document.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(storage.values.openaiApiKey, "existing-dummy-key");
  document.querySelector("#remove-key").click();
  await settle();
  assert.equal(storage.values.openaiApiKey, "");
  assert.equal(storage.values.aiEnabled, false);
  assert.equal(document.querySelector("#ai-enabled").checked, false);
});

test("AI cannot be enabled without a key and malformed keys are rejected", async (t) => {
  const { document, window, storage } = await popupFixture(t);
  document.querySelector("#ai-enabled").checked = true;
  document.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(storage.values.aiEnabled, undefined);
  assert.match(document.querySelector("#status").textContent, /Enter your OpenAI Decisions/);
  document.querySelector("#api-key").value = "key with spaces";
  document.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(storage.values.openaiApiKey, undefined);
});

test("loads and saves independent keyword and AI colors", async (t) => {
  const { document, window, storage } = await popupFixture(t, { keywordColor: "#123456", aiColor: "#abcdef" });
  assert.equal(document.querySelector("#keyword-color").value, "#123456");
  assert.equal(document.querySelector("#ai-color").value, "#abcdef");
  document.querySelector("#keyword-color").value = "#008888";
  document.querySelector("#ai-color").value = "#ffcc00";
  document.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(storage.values.keywordColor, "#008888");
  assert.equal(storage.values.aiColor, "#ffcc00");
});

test("tabs separate settings, support keyboard navigation, and retain drafts until one shared save", async (t) => {
  const { document, window, storage } = await popupFixture(t);
  const keywordsTab = document.querySelector("#keywords-tab");
  const classifiersTab = document.querySelector("#classifiers-tab");
  assert.equal(document.querySelector("#keywords-panel").hidden, false);
  assert.equal(document.querySelector("#classifiers-panel").hidden, true);
  document.querySelector("#keywords").value = "draft";
  keywordsTab.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, classifiersTab);
  assert.equal(classifiersTab.getAttribute("aria-selected"), "true");
  assert.equal(document.querySelector("#keywords-panel").hidden, true);
  document.querySelector("#min-probability").value = "90";
  document.querySelector("#min-probability").value = "75";
  chooseStyle(document, "classifier", "hide");
  classifiersTab.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, keywordsTab);
  assert.equal(document.querySelector("#keywords").value, "draft");
  assert.equal(storage.values.keywords, undefined);
  document.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(storage.values.minProbability, 0.75);
  assert.equal(storage.values.minConfidence, undefined);
  assert.equal(storage.values.replacementStyle, "hide");
  assert.deepEqual(Array.from(storage.values.keywords), ["draft"]);
});

test("threshold validation reveals the classifiers tab and never saves invalid percentages", async (t) => {
  const { document, window, storage } = await popupFixture(t, { minProbability: 0.8, minConfidence: 0.9, replacementStyle: "blur" });
  assert.equal(document.querySelector("#min-probability").value, "80");
  assert.equal(document.querySelector("#min-confidence"), null);
  assert.equal(selectedStyle(document, "classifier"), "blur");
  for (const value of ["", "-1", "101", "0.5"]) {
    document.querySelector("#keywords-tab").click();
    document.querySelector("#min-probability").value = value;
    document.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true }));
    assert.equal(document.querySelector("#classifiers-panel").hidden, false);
    assert.equal(document.activeElement.id, "min-probability");
    assert.equal(storage.values.minProbability, 0.8);
  }
});

test("popup displays and saves new defaults without overwriting existing preferences", async (t) => {
  for (const initial of [{}, { replacementStyle: "placeholder", minProbability: 0, minConfidence: 0 }]) {
    const { document, window, storage } = await popupFixture(t, initial);
    const keywordStyle = document.querySelector("#keyword-replacement-style");
    assert.equal(keywordStyle.closest('[role="tabpanel"]').id, "keywords-panel");
    assert.equal(document.querySelector("#replacement-style").closest('[role="tabpanel"]').id, "classifiers-panel");
    assert.equal(selectedStyle(document, "keyword"), initial.replacementStyle ?? "blur");
    assert.equal(selectedStyle(document, "classifier"), initial.replacementStyle ?? "solid");
    assert.equal(document.querySelector("#min-probability").value, initial.minProbability === 0 ? "0" : "90");
    assert.equal(document.querySelector("#min-confidence"), null);
    document.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true }));
    await settle();
    assert.equal(storage.values.keywordReplacementStyle, initial.replacementStyle ?? "blur");
    assert.equal(storage.values.minProbability, initial.minProbability ?? 0.9);
    assert.equal(storage.values.minConfidence, initial.minConfidence);
  }
});

test("all 21 categories default on and category drafts survive tab switches until saved", async (t) => {
  const { document, window, storage } = await popupFixture(t, { keywordReplacementStyle: "grayscale", minProbability: 0.7, minConfidence: 0.6 });
  const inputs = [...document.querySelectorAll('#classifier-list input')];
  assert.equal(inputs.length, 22);
  assert.ok(inputs.filter(input => input.value !== "wide_open_mouth").every(input => input.checked));
  assert.equal(inputs.find(input => input.value === "wide_open_mouth").checked, false);
  document.querySelector('#classifiers-tab').click();
  for (const input of inputs) input.checked = ["rage_bait", "miracle_cure"].includes(input.value);
  inputs[0].dispatchEvent(new window.Event('change'));
  document.querySelector('#keywords-tab').click();
  document.querySelector('#classifiers-tab').click();
  assert.deepEqual(inputs.filter(input => input.checked).map(input => input.value), ["rage_bait", "miracle_cure"]);
  assert.equal(storage.values.enabledClassifiers, undefined);
  document.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  assert.deepEqual(Array.from(storage.values.enabledClassifiers), ["rage_bait", "miracle_cure"]);
  assert.equal(storage.values.keywordReplacementStyle, "grayscale");
  assert.equal(storage.values.minProbability, 0.7);
  assert.equal(storage.values.minConfidence, 0.6);
});

test("an explicitly saved empty selection stays empty on reopening and saving", async (t) => {
  const { document, window, storage } = await popupFixture(t, { enabledClassifiers: [] });
  assert.equal(document.querySelectorAll('#classifier-list input:checked').length, 0);
  document.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  assert.deepEqual(Array.from(storage.values.enabledClassifiers), []);
});
