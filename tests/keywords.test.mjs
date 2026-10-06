import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { files } from "./helpers.mjs";

const context = vm.createContext({});
vm.runInContext(files["keywords.js"], context);
const { cleanKeywords, createMatcher } = context.RedThumbnailKeywords;

test("matches case-insensitive whole words, phrases and Unicode", () => {
  const matches = createMatcher(["spoiler", "cat", "full review", "café"]);
  for (const title of ["SPOILER alert", "My cat", "A full review today", "ＣＡＦÉ", "Cafe\u0301 tour"]) {
    assert.equal(matches(title), true, title);
  }
  assert.equal(matches("A peaceful walk"), false);
  assert.equal(matches("My vacation"), false);
});

test("MAGA matches only at word boundaries, including later occurrences", () => {
  const matches = createMatcher(["MAGA"]);
  for (const title of ["MAGA", "maga news", "#MAGA", "(MAGA)", "anti-MAGA", "ＭＡＧＡ news", "Magazine covers MAGA", "😀MAGA😀"]) {
    assert.equal(matches(title), true, title);
    assert.equal(matches(title), true, "repeated calls must not retain regex state");
  }
  for (const title of ["Magazine", "MAGAs", "MAGA2026", "2026MAGA", "_MAGA", "MAGA_news", "éMAGA", "MAGA中", "𐐀MAGA", "MAGA\u0338", "\u0338MAGA"]) {
    assert.equal(matches(title), false, title);
  }
});

test("phrases need outer boundaries and preserve literal internal spacing", () => {
  const matches = createMatcher(["full review", "café"]);
  for (const title of ["(Full review)", "A full review!", "Cafe\u0301 tour"]) {
    assert.equal(matches(title), true, title);
  }
  for (const title of ["unfull review", "full reviewer", "full  review", "full-review", "caféteria", "décafé"]) {
    assert.equal(matches(title), false, title);
  }
});

test("ignores empty/invalid keywords and de-duplicates normalized entries", () => {
  assert.deepEqual(Array.from(cleanKeywords([" Spoiler ", "SPOILER", "ＳＰＯＩＬＥＲ", "", "  ", 12, null, "cat"])), ["Spoiler", "cat"]);
  for (const value of [undefined, null, {}, "spoiler", [], ["", " "]]) {
    assert.equal(createMatcher(value)("any title"), false);
  }
});

test("treats punctuation as literal strings, never regular expressions", () => {
  const matches = createMatcher([".*", "[live]"]);
  assert.equal(matches("An ordinary title"), false);
  assert.equal(matches("Title [LIVE] now"), true);
  assert.equal(matches("How .* works"), true);
  assert.equal(matches("x[live]"), false);
  assert.equal(matches("[live]x"), false);
  assert.equal(createMatcher(["C++"])("Learn C++ today"), true);
  assert.equal(createMatcher(["C++"])("C++17"), false);
  for (const literal of ["a+b", "a?b", "a^b", "a$b", "(a)", "a|b", "a{2}", "a\\b"]) {
    assert.equal(createMatcher([literal])(`Read ${literal} today`), true, literal);
  }
  assert.equal(matches(null), false);
});
