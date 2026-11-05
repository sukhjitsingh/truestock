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

/**
 * One spelling of a product's size, used on every screen that shows one —
 * phone and back office alike, and in the "already belongs to" message.
 * Decided by the owner 2026-11-05 (docs/plans/barcode-integrity): "so
 * everything stays the same".
 *
 *   bottle/can under 1000 ml  → "750 ml"
 *   bottle/can 1000 ml and up → litres, trailing zeros dropped: "1 L", "1.5 L", "1.75 L"
 *   the three keg sizes       → "Sixtel keg", "Quarter barrel keg", "Half barrel keg"
 *   any other keg             → litres + " keg": "50 L keg"
 *
 * Kegs are named rather than measured because nobody reads 19,533 ml off a
 * keg; the trade name is what is on the invoice and in the walk-in.
 */
export function formatProductSize(p: { unitType: string; sizeMl: number }): string {
  if (p.unitType === "keg") {
    const named = KEG_NAMES.get(p.sizeMl);
    return named ? `${named} keg` : `${litres(p.sizeMl)} L keg`;
  }
  return p.sizeMl < 1000 ? `${p.sizeMl} ml` : `${litres(p.sizeMl)} L`;
}

/**
 * The secondary line under a keg's size on the confirm screen ("5.16 gal"),
 * and the hint in the keg size dropdown. Null for anything that is not one of
 * the three named keg sizes — a gallon figure for a 750 ml bottle helps no one.
 */
export function kegGallons(p: { unitType: string; sizeMl: number }): string | null {
  if (p.unitType !== "keg" || !KEG_NAMES.has(p.sizeMl)) return null;
  return `${trimDecimals(p.sizeMl / ML_PER_US_GALLON, 2)} gal`;
}

/** US keg sizes by volume (AGENTS.md domain vocabulary). */
const KEG_NAMES = new Map<number, string>([
  [19533, "Sixtel"],
  [29337, "Quarter barrel"],
  [58674, "Half barrel"],
]);

const ML_PER_US_GALLON = 3785.411784;

function litres(ml: number): string {
  return trimDecimals(ml / 1000, 3);
}

/** 1.750 → "1.75", 1.000 → "1", 5.16 → "5.16". Never exponent notation. */
function trimDecimals(n: number, places: number): string {
  return n.toFixed(places).replace(/\.?0+$/, "");
}

/**
 * A dropdown entry. The size text always comes from `formatProductSize`, so a
 * dropdown can never spell a size differently from the rest of the app; the
 * nickname in brackets ("handle", "12 oz", "magnum") is only a picking aid and
 * appears nowhere else.
 */
function preset(ml: number, unitType: string, nickname?: string): BottleSize {
  const size = formatProductSize({ unitType, sizeMl: ml });
  return { ml, label: nickname ? `${size} (${nickname})` : size };
}

export const SPIRITS_SIZES: readonly BottleSize[] = [
  preset(50, "bottle", "mini"),
  preset(200, "bottle"),
  preset(375, "bottle", "half"),
  preset(500, "bottle"),
  preset(700, "bottle"),
  preset(750, "bottle"),
  preset(1000, "bottle"),
  preset(1750, "bottle", "handle"),
];

export const BEER_SIZES: readonly BottleSize[] = [
  preset(222, "bottle", "7.5 oz"),
  preset(330, "bottle", "11.2 oz import"),
  preset(355, "bottle", "12 oz"),
  preset(473, "bottle", "16 oz tallboy"),
  preset(650, "bottle", "22 oz bomber"),
  preset(740, "bottle", "25 oz"),
];

export const WINE_SIZES: readonly BottleSize[] = [
  preset(187, "bottle", "split"),
  preset(375, "bottle", "half"),
  preset(750, "bottle"),
  preset(1500, "bottle", "magnum"),
];

/** Keg dropdown: "Sixtel keg (5.16 gal)" — the name, then gallons as the hint. */
export const KEG_SIZES: readonly BottleSize[] = [19533, 29337, 58674].map((ml) =>
  preset(ml, "keg", kegGallons({ unitType: "keg", sizeMl: ml }) ?? undefined),
);

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
