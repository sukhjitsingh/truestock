"use client";

import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import {
  createProductAction,
  linkBarcodeToProductAction,
  searchProductsAction,
} from "@/app/actions/catalog";
import type { ProductSummary } from "@/lib/domain/catalog";
import { bottleSizesFor, defaultSizeMlFor, isPresetSizeMl } from "@/lib/bottle-sizes";
import { isCountedByCase } from "@/lib/pack-level";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";

const CATEGORIES = ["Spirits", "Beer", "Wine", "Liqueur", "NA"];

/**
 * What a new product opens as. Named rather than inlined because the starting
 * size is derived from these two — `defaultSizeMlFor` owns the number, so a
 * change to the preset lists cannot leave a stale literal behind here.
 */
const INITIAL_CATEGORY = "Spirits";
const INITIAL_UNIT_TYPE = "bottle" as const;

/**
 * What happens when a scanned barcode resolves to nothing.
 *
 * THIS SCREEN HAS A 20-SECOND BUDGET (CLAUDE.md, spec §12, risk #2 in spec
 * §14). It is the single highest-risk interaction in the MVP: if enrolling a
 * product is painful, the catalog decays and the whole system dies with it.
 *
 * ## Why it opens on search rather than on the new-product form
 *
 * An unknown barcode does NOT mean an unknown product. All 97 seeded products
 * ship with no barcode at all — `upc` is deliberately blank and fills in
 * through scanning (CLAUDE.md) — so during the first count at a real bar
 * *every* scan lands here, and almost every one of them is a bottle the
 * catalog already knows about. "Already in the catalog, just not scanned yet"
 * is the common case; a genuinely new product is the rare one.
 *
 * When creating was the only option, that asymmetry made the screen a dead
 * end. Typing the catalog's own name for the bottle collided with
 * `product_name_size_ml_unique` and offered no way forward, mid-count, in a
 * dim bar. Typing a slightly different name was worse, because it *worked*:
 * it produced a second copy of a product the catalog already had, with the
 * count silently split across the two and the seeded row left at zero.
 *
 * So: search first, create second. Both are one tap from here.
 */
export function EnrollForm({
  barcode,
  onCancel,
  onResolved,
}: {
  barcode: string;
  onCancel: () => void;
  /** Fired for both paths — the caller only cares which product to count. */
  onResolved: (product: ProductSummary) => void;
}) {
  const [mode, setMode] = useState<"link" | "create">("link");

  return (
    <div className="px-bar-pad pb-8 pt-6">
      <button
        type="button"
        onClick={onCancel}
        className="mb-4 flex items-center gap-1 text-caption text-muted-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden="true" /> Back
      </button>

      <h1 className="text-header-title text-foreground">
        {mode === "link" ? "Which bottle is this?" : "New product"}
      </h1>
      <p className="mt-1 text-row-subtitle text-muted-foreground">
        Barcode <span className="tabular-nums text-foreground">{barcode}</span> isn&rsquo;t
        attached to anything yet.
        {mode === "link"
          ? " Find it in the catalog and this code sticks to it for good."
          : " Name it and keep counting — the rest can be filled in later."}
      </p>

      {mode === "link" ? (
        <LinkExisting
          barcode={barcode}
          onLinked={onResolved}
          onNewProduct={() => setMode("create")}
        />
      ) : (
        <CreateNew
          barcode={barcode}
          onCreated={onResolved}
          onBackToSearch={() => setMode("link")}
        />
      )}
    </div>
  );
}

/**
 * The common path: bind this barcode to a product that already exists.
 *
 * The each/case question is asked only where it can be answered wrongly.
 * Binding a case carton's code as `each` silently miscounts every later scan
 * of it by the case size, which is the quiet-and-wrong failure this app is
 * written against — but it can only happen for bottled beer, the only thing
 * counted both ways. For the other 81 seeded products `each` is the only
 * meaningful answer, so asking would be a tap that never changes anything.
 */
function LinkExisting({
  barcode,
  onLinked,
  onNewProduct,
}: {
  barcode: string;
  onLinked: (product: ProductSummary) => void;
  onNewProduct: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSummary[]>([]);
  const [chosen, setChosen] = useState<ProductSummary | null>(null);
  const [packLevel, setPackLevel] = useState<"each" | "case">("each");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(value: string) {
    setQuery(value);
    if (value.trim().length < 2) {
      setResults([]);
      return;
    }
    const found = await searchProductsAction({ query: value, limit: 20 });
    if (found.ok) setResults(found.data);
  }

  async function link(product: ProductSummary, level: "each" | "case") {
    setPending(true);
    setError(null);
    const result = await linkBarcodeToProductAction({
      productId: product.id,
      barcode,
      packLevel: level,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onLinked(result.data);
  }

  // A product that can be scanned as a bottle OR as a case gets the question
  // asked before anything is written. Everything else links on the first tap.
  if (chosen) {
    return (
      <div className="mt-section-gap">
        <p className="text-row-title text-foreground">{chosen.name}</p>
        <p className="mt-1 text-row-subtitle text-muted-foreground">
          Is this barcode on the bottle, or on the case?
        </p>
        <p className="mt-2 text-caption text-muted-foreground">
          They carry different codes. Getting it wrong makes every later scan of this
          one count as the wrong quantity, and nothing will look broken.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          {(
            [
              { level: "each" as const, label: "Single bottle" },
              { level: "case" as const, label: "Case carton" },
            ]
          ).map((option) => (
            <button
              key={option.level}
              type="button"
              onClick={() => setPackLevel(option.level)}
              className={cn(
                "min-h-tap-primary rounded-md border text-label uppercase",
                packLevel === option.level
                  ? "border-accent bg-accent text-accent-foreground"
                  : "border-input bg-card text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {error ? (
          <p
            className="mt-4 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-section-gap flex gap-3">
          <Button
            variant="outline"
            size="primary"
            className="flex-1"
            onClick={() => setChosen(null)}
          >
            Back
          </Button>
          <Button
            size="primary"
            className="flex-[1.4]"
            disabled={pending}
            onClick={() => void link(chosen, packLevel)}
          >
            {pending ? "Linking…" : "Link and count"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-section-gap">
      <Field label="Search the catalog" htmlFor="link-search">
        <Input
          id="link-search"
          type="search"
          value={query}
          autoFocus
          onChange={(e) => void search(e.target.value)}
          placeholder="Tito's, Coors, Merlot…"
        />
      </Field>

      {error ? (
        <p
          className="mt-4 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {results.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2">
          {results.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={pending}
              onClick={() => {
                if (isCountedByCase(p)) {
                  setPackLevel("each");
                  setChosen(p);
                  return;
                }
                void link(p, "each");
              }}
              className="rounded-lg border border-border bg-card p-card-pad text-left disabled:opacity-50"
            >
              <span className="block text-row-title text-card-foreground">{p.name}</span>
              <span className="block text-row-subtitle text-muted-foreground">
                {p.unitType === "keg" ? "Keg" : `${p.sizeMl}ml`}
                {p.brand ? ` · ${p.brand}` : ""}
              </span>
            </button>
          ))}
        </div>
      ) : query.trim().length >= 2 ? (
        <p className="mt-4 text-row-subtitle text-muted-foreground">
          Nothing matches &ldquo;{query}&rdquo;.
        </p>
      ) : null}

      <div className="mt-section-gap border-t border-border pt-5">
        <p className="text-caption text-muted-foreground">
          Genuinely not in the catalog?
        </p>
        <Button
          variant="outline"
          size="primary"
          className="mt-2 w-full"
          onClick={onNewProduct}
        >
          Add it as a new product
        </Button>
      </div>
    </div>
  );
}

/**
 * The rarer path: a product the catalog really does not have.
 *
 *  - Four fields. Name, category, size, unit type. Only the name is typed;
 *    the other three are picked. Nothing else is required, because everything
 *    else is editable later from the back office at a desk.
 *  - No cost field at all. Cost is owner-only and would be dropped for anyone
 *    else anyway (lib/domain/catalog.ts), so showing it to the manager or
 *    bartender who is actually mid-count would be a field that silently does
 *    nothing. Cost comes off a supplier invoice, not off a bottle in the dark.
 *  - No vendor, no par, no reorder point. Same reason.
 *  - Size is a closed list (lib/bottle-sizes.ts) with NO "Other…" escape
 *    hatch, unlike the back-office form. A typed size is a field where `75`
 *    for `750` saves clean and then values that product's whole count at a
 *    tenth of its worth, with nothing on screen looking wrong. That is a bad
 *    trade anywhere and an unacceptable one here, in a dim bar against a
 *    20-second budget. An unlisted bottle waits for a catalog edit at a desk.
 *  - The size that opens selected follows the category and unit type —
 *    750 ml for spirits, 355 ml for beer and NA, a half barrel for a keg — so
 *    the common case stays zero taps rather than one. Changing either of those
 *    selects re-points the list, and re-defaults the size if the current one
 *    is not on the new list; leaving 750 selected against the beer list would
 *    render the select blank on a required field.
 *
 * If a field is ever added here, something else has to come off. That is the
 * trade, and it is deliberate.
 */
function CreateNew({
  barcode,
  onCreated,
  onBackToSearch,
}: {
  barcode: string;
  onCreated: (product: ProductSummary) => void;
  onBackToSearch: () => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>(INITIAL_CATEGORY);
  const [unitType, setUnitType] = useState<"bottle" | "can" | "keg">(INITIAL_UNIT_TYPE);
  const [sizeMl, setSizeMl] = useState(
    String(defaultSizeMlFor({ category: INITIAL_CATEGORY, unitType: INITIAL_UNIT_TYPE })),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameCollision, setNameCollision] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const sizes = bottleSizesFor({ category, unitType });

  /**
   * Category and unit type both choose the size list, so both have to be able
   * to move the size with them.
   *
   * Done in the change handler rather than in an effect on purpose: an effect
   * would also run on mount, and the two are only distinguishable by extra
   * state. Here "the user changed the category" is the only thing that can
   * call this.
   *
   * The size is re-defaulted only when the current one is absent from the new
   * list. Spirits 375 → Wine keeps 375 (both lists have it), which is what
   * someone switching a mislabelled category means; Spirits 750 → Beer cannot
   * keep 750, and a `<select>` whose value matches no option renders empty on
   * a field the form requires.
   */
  function retarget(next: { category?: string; unitType?: typeof unitType }) {
    const ctx = {
      category: next.category ?? category,
      unitType: next.unitType ?? unitType,
    };
    if (next.category !== undefined) setCategory(next.category);
    if (next.unitType !== undefined) setUnitType(next.unitType);
    if (!isPresetSizeMl(Number(sizeMl), ctx)) setSizeMl(String(defaultSizeMlFor(ctx)));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNameCollision(false);
    setFieldErrors({});

    const result = await createProductAction({
      name,
      category,
      unitType,
      sizeMl: Number(sizeMl),
      // The barcode that triggered enrollment. `each` because a scan during a
      // count is overwhelmingly a bottle in someone's hand; a case carton
      // scanned in the storeroom can be re-pointed from the back office,
      // which is a rarer correction than the delay of asking here every time.
      barcode: { barcode, packLevel: "each", isPrimary: true },
    });

    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      setFieldErrors(result.error.fieldErrors ?? {});
      // The name+size collision has a real answer, and it is on the other
      // screen: the product already exists and wants this barcode attached
      // rather than a duplicate created. Say so, instead of leaving someone
      // to invent a name the catalog does not already have.
      setNameCollision(/already exists/i.test(result.error.message));
      return;
    }
    onCreated(result.data);
  }

  return (
    <div>
      {/*
        method="post" per CLAUDE.md's working agreement. preventDefault only
        runs once React has attached; before that the browser submits
        natively, and a form with no method defaults to GET — which is how
        the login form put a plaintext password in the query string. Nothing
        here is a credential and no input carries a `name`, so this is the
        cheap end of that rule rather than a live leak, but the agreement
        exists because the reasoning is easy to re-lose.
      */}
      <form
        method="post"
        onSubmit={submit}
        className="mt-section-gap flex flex-col gap-4"
        noValidate
      >
        <Field label="Name" htmlFor="p-name" error={fieldErrors.name}>
          <Input
            id="p-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            autoCapitalize="words"
            required
            placeholder="Tito's Handmade Vodka"
          />
        </Field>

        <Field label="Category" htmlFor="p-category" error={fieldErrors.category}>
          <Select
            id="p-category"
            value={category}
            onChange={(e) => retarget({ category: e.target.value })}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Size" htmlFor="p-size" error={fieldErrors.sizeMl}>
            <Select
              id="p-size"
              value={sizeMl}
              onChange={(e) => setSizeMl(e.target.value)}
            >
              {sizes.map((s) => (
                <option key={s.ml} value={s.ml}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unit" htmlFor="p-unit" error={fieldErrors.unitType}>
            <Select
              id="p-unit"
              value={unitType}
              onChange={(e) => retarget({ unitType: e.target.value as typeof unitType })}
            >
              <option value="bottle">Bottle</option>
              <option value="can">Can</option>
              <option value="keg">Keg</option>
            </Select>
          </Field>
        </div>

        {error ? (
          <div className="rounded-md bg-negative-bg px-3 py-2" role="alert">
            <p className="text-caption text-negative">{error}</p>
            {nameCollision ? (
              <button
                type="button"
                onClick={onBackToSearch}
                className="mt-2 min-h-tap-min text-caption font-medium text-negative underline"
              >
                Attach this barcode to the existing one instead
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex gap-3">
          <Button variant="outline" size="primary" className="flex-1" onClick={onBackToSearch}>
            Back to search
          </Button>
          <Button type="submit" size="primary" className="flex-[1.4]" disabled={pending || !name}>
            {pending ? "Saving…" : "Save and count"}
          </Button>
        </div>
      </form>
    </div>
  );
}
