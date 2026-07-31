/**
 * The preset bottle/keg sizes offered for `size_ml`, and the rule for which
 * list a product gets.
 *
 * `size_ml` used to be a bare number input in both product forms, which makes
 * a typo indistinguishable from a fact: `75` instead of `750` is a legal
 * integer, saves clean, and then values that product's whole count at a tenth
 * of its worth. Nothing on screen looks wrong afterwards — the same silent
 * class of failure as a wrong active location. A closed list of the sizes the
 * bar actually stocks removes the input that can be mistyped.
 *
 * The lists are the owner's, decided 2026-07-30, and are deliberately short.
 * They are a UI concern only: the column is still `int("size_ml")` and accepts
 * anything, and the back-office form keeps an "Other…" escape hatch on top of
 * this module. The count leg does NOT — strict on the phone, where the
 * 20-second budget is real and a mistake is silent; the desk is where an
 * unlisted bottle gets entered.
 *
 * This module is dependency-free, like lib/pack-level.ts and for the same
 * reason: both forms are client components and must import it without
 * dragging in the database.
 */

/** An integer millilitre value and the name the bar knows it by. */
export type BottleSize = {
  /** Millilitres. Always an integer — the column is `int("size_ml")`. */
  readonly ml: number;
  /** What the user reads in the dropdown, e.g. "1.75 L (handle)". */
  readonly label: string;
};

/**
 * The two fields the list depends on. Matches `isCountedByCase`'s shape so a
 * caller can pass the same product object to both.
 */
export type SizeContext = {
  category: string;
  unitType: string;
};

export const SPIRITS_SIZES: readonly BottleSize[] = [
  { ml: 50, label: "50 ml (mini)" },
  { ml: 200, label: "200 ml" },
  { ml: 375, label: "375 ml (half)" },
  { ml: 500, label: "500 ml" },
  { ml: 700, label: "700 ml" },
  { ml: 750, label: "750 ml" },
  { ml: 1000, label: "1 L" },
  { ml: 1750, label: "1.75 L (handle)" },
];

export const BEER_SIZES: readonly BottleSize[] = [
  { ml: 222, label: "222 ml (7.5 oz)" },
  { ml: 330, label: "330 ml (11.2 oz import)" },
  { ml: 355, label: "355 ml (12 oz)" },
  { ml: 473, label: "473 ml (16 oz tallboy)" },
  { ml: 650, label: "650 ml (22 oz bomber)" },
  { ml: 740, label: "740 ml (25 oz)" },
];

export const WINE_SIZES: readonly BottleSize[] = [
  { ml: 187, label: "187 ml (split)" },
  { ml: 375, label: "375 ml (half)" },
  { ml: 750, label: "750 ml" },
  { ml: 1500, label: "1.5 L (magnum)" },
];

/**
 * Keg volumes, from CLAUDE.md's "Draft beer" section. These are the same three
 * numbers the seed catalog uses; they are not approximations to be tidied.
 */
export const KEG_SIZES: readonly BottleSize[] = [
  { ml: 19533, label: "19533 ml (sixtel)" },
  { ml: 29337, label: "29337 ml (quarter barrel)" },
  { ml: 58674, label: "58674 ml (half barrel)" },
];

/**
 * A list paired with the size that opens selected. The pairing lives here
 * rather than as a flag on each entry so there is exactly one default per
 * list and no way to express two — or none, which would leave a required
 * field empty on a form the user never touched.
 */
type SizeList = { sizes: readonly BottleSize[]; defaultMl: number };

const SPIRITS: SizeList = { sizes: SPIRITS_SIZES, defaultMl: 750 };
const BEER: SizeList = { sizes: BEER_SIZES, defaultMl: 355 };
const WINE: SizeList = { sizes: WINE_SIZES, defaultMl: 750 };
/**
 * 19533 (sixtel), not the canonically "largest"/first-listed 58674 (half
 * barrel). docs/catalog/products.csv has 7 sixtels, 1 quarter barrel and 1
 * half barrel — a default is chosen from what this bar actually taps, not
 * from what a keg size list would alphabetize or size-order to first.
 *
 * This matters more for a keg than anywhere else in this module: a wrong
 * size_ml is the denominator of the Phase 2 draft depletion model, so every
 * pour computed against it would be off by the same factor the size is
 * wrong by. And a *plausible* wrong keg size is worse than an absurd one —
 * before this preset dropdown existed, the enroll form defaulted a keg to
 * 750 ml, which is obviously nonsense and gets fixed on sight. 58674 is a
 * real keg size, just usually the wrong one for this bar, so nobody
 * double-checks it and it ships silently into the pour math.
 * tests/bottle-sizes.test.ts asserts this stays the modal size in the seed
 * catalog rather than pinning 19533 in isolation, so a change in what the
 * bar stocks is what moves this number, not the other way around.
 */
const KEG: SizeList = { sizes: KEG_SIZES, defaultMl: 19533 };

/**
 * Category → list. Lowercased keys because nothing enforces the casing: the
 * seed CSV and both `<Select>`s happen to agree on "Spirits"/"Beer"/…, but
 * that is a convention, not a constraint, and lib/pack-level.ts already
 * lowercases for exactly this reason.
 *
 * NA is on the BEER list on purpose. All three seeded NA products are 355 ml
 * cans, and 355 is not a spirits size — filing NA with spirits would orphan
 * every one of them behind an "Other…" the count leg does not have.
 *
 * Liqueur is on the spirits list: same bottles, same 750 ml default.
 */
const BY_CATEGORY: Record<string, SizeList> = {
  spirits: SPIRITS,
  liqueur: SPIRITS,
  beer: BEER,
  na: BEER,
  wine: WINE,
};

function listFor(p: SizeContext): SizeList {
  // Unit type wins over category. A keg's category is Beer, and offering it
  // 12 oz cans would leave every keg unsettable.
  if (p.unitType === "keg") return KEG;

  // An unrecognised category falls back to spirits rather than to nothing.
  // An empty dropdown on a required field is unfillable — it would block the
  // enroll form mid-count with no path forward, which is worse than offering
  // a list that may be the wrong one but is at least editable at the desk.
  return BY_CATEGORY[p.category.toLowerCase()] ?? SPIRITS;
}

/** The sizes offered for this product, in menu order. Never empty. */
export function bottleSizesFor(p: SizeContext): readonly BottleSize[] {
  return listFor(p).sizes;
}

/** The size a new product of this kind starts on. Always in its own list. */
export function defaultSizeMlFor(p: SizeContext): number {
  return listFor(p).defaultMl;
}

/**
 * Is `ml` one of this product's presets?
 *
 * The back-office form asks this to decide whether an existing product opens
 * in preset mode or in "Other…" mode. Answering wrong in the permissive
 * direction is the damaging one: a 1000 ml bottle silently re-rendering as
 * the 750 ml default would rewrite the size on the next save of an unrelated
 * field.
 */
export function isPresetSizeMl(ml: number, p: SizeContext): boolean {
  return listFor(p).sizes.some((s) => s.ml === ml);
}
