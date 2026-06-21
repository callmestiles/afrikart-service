import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchAccountName } from "../../src/services/name-matching";

describe("matchAccountName", () => {
  it("returns exact match for identical names", () => {
    const result = matchAccountName("Ada Lovelace", "Ada Lovelace");
    assert.equal(result.matched, true);
    assert.equal(result.confidence, "exact");
  });

  it("returns normalized match for case differences", () => {
    const result = matchAccountName("Ada Lovelace", "ADA LOVELACE");
    assert.equal(result.matched, true);
    assert.equal(result.confidence, "normalized");
  });

  it("returns normalized match for mixed case", () => {
    const result = matchAccountName("ada lovelace", "Ada Lovelace");
    assert.equal(result.matched, true);
    assert.equal(result.confidence, "normalized");
  });

  it("returns partial match when all expected tokens appear in verified name", () => {
    // Bank returns full name including middle name
    const result = matchAccountName("Ada Lovelace", "Ada Augusta Lovelace");
    assert.equal(result.matched, true);
    assert.equal(result.confidence, "partial");
  });

  it("returns partial match for name with punctuation differences", () => {
    const result = matchAccountName("Ada Lovelace", "Ada Lovelace-Byron");
    assert.equal(result.matched, true);
    assert.equal(result.confidence, "partial");
  });

  it("returns no match for completely different names", () => {
    const result = matchAccountName("Ada Lovelace", "Kofi Mensah");
    assert.equal(result.matched, false);
    assert.equal(result.confidence, "none");
  });

  it("returns no match for partially overlapping but wrong names", () => {
    // "Ada" appears in both but "Lovelace" does not appear in "Ada Johnson"
    const result = matchAccountName("Ada Lovelace", "Ada Johnson");
    assert.equal(result.matched, false);
    assert.equal(result.confidence, "none");
  });

  it("exposes expectedName and verifiedName in result", () => {
    const result = matchAccountName("Ada Lovelace", "ADA LOVELACE");
    assert.equal(result.expectedName, "Ada Lovelace");
    assert.equal(result.verifiedName, "ADA LOVELACE");
  });

  it("handles extra whitespace gracefully", () => {
    const result = matchAccountName("Ada  Lovelace", "  Ada Lovelace  ");
    assert.equal(result.matched, true);
  });
});
