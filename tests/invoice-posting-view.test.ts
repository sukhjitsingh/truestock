import { describe, expect, test } from "bun:test";
import {
  postingHeadline,
  describeSkipReason,
  candidateFromFormValues,
  parsePackSizeInput,
  showsPackSizeInput,
  livePanelModel,
  panelModelFromReport,
  type SkipReasonKey,
  type LineFacts,
} from "@/lib/invoice-posting-view";
import { classifyLineForPosting } from "@/lib/domain/cost-derivation";

describe("postingHeadline", () => {
  test("headline_before_and_after", () => {
    expect(postingHeadline(3, 5, false)).toBe("3 of 5 lines will post");
    expect(postingHeadline(3, 5, true)).toBe("3 of 5 lines posted");
    expect(postingHeadline(0, 5, false)).toBe("0 of 5 lines will post");
    expect(postingHeadline(0, 5, true)).toBe("0 of 5 lines posted");
    expect(postingHeadline(1, 1, false)).toBe("1 of 1 line will post");
    expect(postingHeadline(1, 1, true)).toBe("1 of 1 line posted");
    expect(postingHeadline(0, 0, false)).toBe("This invoice has no lines to post.");
    expect(postingHeadline(0, 0, true)).toBe("This invoice has no lines to post.");
  });
});

describe("describeSkipReason", () => {
  const expected: Record<SkipReasonKey, string> = {
    not_product_line:
      "Line 4 is not a product line (for example a deposit or freight charge), so it does not change a cost.",
    not_matched: "Line 4 is not matched to a product, so there is no product to update.",
    no_net: "Line 4 has no net amount, so no cost can be worked out.",
    free_goods: "Line 4 has a net of zero (free goods), so it does not change a cost.",
    credit: "Line 4 is a credit (its net is below zero), so it does not change a cost.",
    no_quantity: "Line 4 has no quantity above zero, so no cost can be worked out.",
    no_units_per_case:
      "Line 4 has no units per case, so the cost of one unit cannot be worked out. Enter it on the line.",
    not_posted_at_approval:
      "Line 4 was left out when this invoice was approved, and no cost was recorded for it.",
  };

  for (const reason of Object.keys(expected) as SkipReasonKey[]) {
    test(`sentence_for_${reason}`, () => {
      expect(describeSkipReason(reason, 4)).toBe(expected[reason]);
    });
  }

  test("every_reason_has_distinct_text_and_names_the_line", () => {
    const sentences = (Object.keys(expected) as SkipReasonKey[]).map((r) => describeSkipReason(r, 12));
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const s of sentences) expect(s.startsWith("Line 12 ")).toBe(true);
  });
});

describe("form values to candidate", () => {
  const facts: LineFacts = { lineType: "product", uom: "each", quantity: "4.000", packSize: null };
  const verdict = (f: LineFacts, v: { rawNet: string; matchedProductId: string }) =>
    classifyLineForPosting(candidateFromFormValues(f, v));

  test("edit_changes_the_verdict", () => {
    expect(verdict(facts, { rawNet: "10.00", matchedProductId: "7" })).toMatchObject({ posts: true });
    // Clearing the match.
    expect(verdict(facts, { rawNet: "10.00", matchedProductId: "" })).toEqual({
      posts: false,
      reason: "not_matched",
    });
    // Clearing, zeroing and negating the net.
    expect(verdict(facts, { rawNet: "  ", matchedProductId: "7" })).toEqual({ posts: false, reason: "no_net" });
    expect(verdict(facts, { rawNet: "0.00", matchedProductId: "7" })).toEqual({ posts: false, reason: "free_goods" });
    expect(verdict(facts, { rawNet: "-3", matchedProductId: "7" })).toEqual({ posts: false, reason: "credit" });
    // Changing the line type.
    expect(verdict({ ...facts, lineType: "deposit" }, { rawNet: "10.00", matchedProductId: "7" })).toEqual({
      posts: false,
      reason: "not_product_line",
    });
  });

  test("maps_typed_net_and_picked_product", () => {
    const c = candidateFromFormValues(facts, { rawNet: " 12.50 ", matchedProductId: "42" });
    expect(c).toEqual({
      lineType: "product",
      uom: "each",
      quantity: "4.000",
      packSize: null,
      rawNet: "12.50",
      matchedProductId: 42,
    });
    expect(candidateFromFormValues(facts, { rawNet: "", matchedProductId: "x" })).toMatchObject({
      rawNet: null,
      matchedProductId: null,
    });
  });

  test("live_panel_follows_each_edit", () => {
    const lines = [
      { id: 1, lineNumber: 1, description: "Sample A", ...facts },
      { id: 2, lineNumber: 2, description: "Sample B", ...facts },
    ];
    const fields = {
      1: { rawNet: "10.00", matchedProductId: "7" },
      2: { rawNet: "10.00", matchedProductId: "8" },
    };
    const before = livePanelModel(lines, fields);
    expect(before).toMatchObject({ final: false, totalLines: 2, postedLines: 2, skipped: [] });
    const after = livePanelModel(lines, { ...fields, 2: { rawNet: "10.00", matchedProductId: "" } });
    expect(after.postedLines).toBe(1);
    expect(after.skipped).toEqual([{ lineNumber: 2, description: "Sample B", reason: "not_matched" }]);
  });

  test("report_model_lists_skipped_lines_only", () => {
    const model = panelModelFromReport({
      final: true,
      totalLines: 3,
      postedLines: 1,
      lines: [
        { lineNumber: 1, description: "A", posted: true, reason: null },
        { lineNumber: 2, description: "B", posted: false, reason: "free_goods" },
        { lineNumber: 3, description: null, posted: false, reason: "not_posted_at_approval" },
      ],
    });
    expect(model.final).toBe(true);
    expect(model.postedLines).toBe(1);
    expect(model.skipped.map((s) => s.reason)).toEqual(["free_goods", "not_posted_at_approval"]);
  });
});

describe("live units per case", () => {
  const caseFacts: LineFacts = { lineType: "product", uom: "case", quantity: "2.000", packSize: null };
  const eachFacts: LineFacts = { lineType: "product", uom: "each", quantity: "2.000", packSize: null };
  const verdict = (f: LineFacts, packSize: string | undefined) =>
    classifyLineForPosting(candidateFromFormValues(f, { rawNet: "240.00", matchedProductId: "7", packSize }));

  test("valid_value_moves_a_case_line_to_posting_and_clearing_moves_it_back", () => {
    expect(verdict(caseFacts, "")).toEqual({ posts: false, reason: "no_units_per_case" });
    expect(verdict(caseFacts, "12")).toMatchObject({ posts: true, unitCost: "10.0000", packSizeUsed: 12 });
    expect(verdict(caseFacts, " 12 ")).toMatchObject({ posts: true, packSizeUsed: 12 });
    expect(verdict(caseFacts, "")).toEqual({ posts: false, reason: "no_units_per_case" });
  });

  test("typed_value_overrides_the_stored_one_and_blank_clears_it", () => {
    const stored: LineFacts = { ...caseFacts, packSize: 24 };
    expect(verdict(stored, undefined)).toMatchObject({ posts: true, packSizeUsed: 24 });
    expect(verdict(stored, "6")).toMatchObject({ posts: true, packSizeUsed: 6 });
    expect(verdict(stored, "")).toEqual({ posts: false, reason: "no_units_per_case" });
  });

  test("invalid_values_count_as_no_pack_size", () => {
    for (const bad of ["0", "2.5", "12.0", "10000", "-3", "1e2", "abc", "99999", "1 2"]) {
      expect(verdict(caseFacts, bad)).toEqual({ posts: false, reason: "no_units_per_case" });
      expect(parsePackSizeInput(bad)).toBeNull();
    }
    expect(parsePackSizeInput("9999")).toBe(9999);
    expect(parsePackSizeInput("1")).toBe(1);
  });

  test("each_line_ignores_the_typed_value", () => {
    expect(verdict(eachFacts, "12")).toMatchObject({ posts: true, unitCost: "120.0000", packSizeUsed: 1 });
    expect(verdict({ ...eachFacts, uom: "keg" }, "12")).toMatchObject({ posts: true, packSizeUsed: 1 });
  });

  test("live_panel_follows_a_typed_pack_size", () => {
    const lines = [{ id: 1, lineNumber: 1, description: "Sample Vodka", ...caseFacts }];
    const base = { rawNet: "240.00", matchedProductId: "7" };
    expect(livePanelModel(lines, { 1: { ...base, packSize: "" } }).skipped).toEqual([
      { lineNumber: 1, description: "Sample Vodka", reason: "no_units_per_case" },
    ]);
    expect(livePanelModel(lines, { 1: { ...base, packSize: "12" } })).toMatchObject({ postedLines: 1, skipped: [] });
    expect(livePanelModel(lines, { 1: { ...base, packSize: "0" } }).postedLines).toBe(0);
  });

  test("input_shows_only_where_the_reviewer_must_supply_it", () => {
    expect(showsPackSizeInput({ lineType: "product", uom: "case" })).toBe(true);
    expect(showsPackSizeInput({ lineType: "product", uom: "other" })).toBe(true);
    expect(showsPackSizeInput({ lineType: "product", uom: null })).toBe(true);
    expect(showsPackSizeInput({ lineType: "product", uom: "each" })).toBe(false);
    expect(showsPackSizeInput({ lineType: "product", uom: "keg" })).toBe(false);
    expect(showsPackSizeInput({ lineType: "deposit", uom: "case" })).toBe(false);
  });
});
