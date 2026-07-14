import assert from "node:assert/strict";
import test from "node:test";
import { matchesSearch, metadataSearchText, normalizeSearchText, searchTerms } from "../react-app/src/lib/search.js";

test("normalizes case, punctuation, whitespace, and diacritics", () => {
  assert.equal(normalizeSearchText("  CÁGE-2 / Left  "), "cage 2 left");
  assert.deepEqual(searchTerms(" Radio   Shelf-R20684 "), ["radio", "shelf", "r20684"]);
});

test("matches every query term across fields in any order", () => {
  const values = ["PRC Radio", "LIN R20684", "Cage 2 left shelf"];
  assert.equal(matchesSearch(values, "shelf radio r20684"), true);
  assert.equal(matchesSearch(values, "radio connex"), false);
});

test("keeps one-character and numeric identifier terms", () => {
  assert.equal(matchesSearch(["Rack A", "Bay 7"], "a 7"), true);
  assert.equal(matchesSearch(["Rack B", "Bay 7"], "a 7"), true);
  assert.equal(matchesSearch(["Rack B", "Bay 8"], "a 7"), false);
});

test("allows punctuation-separated partial identifiers", () => {
  assert.equal(matchesSearch("W34648 TOOL KIT", "W34-648"), true);
  assert.equal(matchesSearch("5820015244763", "5820-0152-44763"), true);
});

test("blank queries restore the full collection", () => {
  assert.equal(matchesSearch([], "  "), true);
});

test("metadata search skips media paths and remains bounded", () => {
  const text = metadataSearchText({
    location: "Cage 2",
    imageUrl: "https://example.test/private-photo.jpg",
    nested: { note: "Data plate" }
  });
  assert.match(text, /Cage 2/);
  assert.match(text, /Data plate/);
  assert.doesNotMatch(text, /private-photo/);
});
