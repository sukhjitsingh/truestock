"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateProductAction, deactivateProductAction } from "@/app/actions/catalog";
import type { ProductSummary, VendorSummary } from "@/lib/domain/catalog";
import { bottleSizesFor, isPresetSizeMl } from "@/lib/bottle-sizes";
import { isCountedByCase } from "@/lib/pack-level";
import { subcategoryOptions } from "@/lib/subcategories";
import { formatCostForInput } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";

/**
 * The `<option>` value that means "not on the list". A string no size can
 * collide with, because every other option's value is `String(ml)`.
 */
const SIZE_OTHER = "other";

/**
 * Product edit.
 *
 * The Pricing block is ABSENT from a manager's DOM — not disabled, not
 * blurred, not behind a lock icon (design-system.md's binding rule). The
 * server would drop a cost a manager submitted anyway
 * (lib/domain/catalog.ts), so rendering a disabled field would be a control
 * that silently does nothing.
 */
export function ProductEditForm({
  product,
  vendors,
  canEditCost,
}: {
  product: ProductSummary;
  vendors: VendorSummary[];
  canEditCost: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(product.name);
  const [brand, setBrand] = useState(product.brand ?? "");
  const [category, setCategory] = useState(product.category);
  const [subcategory, setSubcategory] = useState(product.subcategory ?? "");
  const [sizeMl, setSizeMl] = useState(String(product.sizeMl));
  /**
   * Preset dropdown, or the free-text box behind "Other…".
   *
   * Seeded from the product's OWN stored size, so a row holding a size that is
   * not on its category's list opens on that size and saves it back unchanged.
   * The alternative — always opening on the dropdown — would render a value
   * the list does not contain, and the first save of an unrelated field would
   * write whatever the select had snapped to. Rewriting catalog data as a side
   * effect of editing a name is exactly the plausible-and-wrong failure the
   * invariants exist to stop, and it would be silent: the size is not on the
   * screen the person was looking at.
   *
   * Nothing in today's seed is a non-preset size (tests/bottle-sizes.test.ts
   * pins that), which is why this has to be deliberate rather than something
   * a passing test would have caught.
   */
  const [sizeMode, setSizeMode] = useState<"preset" | typeof SIZE_OTHER>(
    isPresetSizeMl(product.sizeMl, product) ? "preset" : SIZE_OTHER,
  );
  const [caseSize, setCaseSize] = useState(product.caseSize == null ? "" : String(product.caseSize));
  const [vendorId, setVendorId] = useState(product.vendorId == null ? "" : String(product.vendorId));
  // DECIMAL(10,4) arrives as "144.0000"; show it as money without rounding
  // away genuine sub-cent precision — see formatCostForInput in lib/utils.ts.
  const [cost, setCost] = useState(formatCostForInput(product.currentUnitCost));
  const [parLevel, setParLevel] = useState(
    product.stock?.parLevel == null ? "" : String(product.stock.parLevel),
  );
  const [reorderPoint, setReorderPoint] = useState(
    product.stock?.reorderPoint == null ? "" : String(product.stock.reorderPoint),
  );

  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Unit type is not editable here, so the size list moves only with category.
  const sizeContext = { category, unitType: product.unitType };
  const sizes = bottleSizesFor(sizeContext);

  /**
   * Re-point the size list when the category changes.
   *
   * In the change handler and not an effect, because an effect also fires on
   * mount — which is the one moment this must not run. Opening a product to
   * fix a typo in its name would move its size before anyone touched it.
   *
   * "Other…" is left alone entirely: a size someone typed because it is not on
   * any list is not the dropdown's to reset. And a preset that survives into
   * the new list stays (375 is both a spirits half and a wine half); a size
   * the new list cannot render flips the field into "Other…" rather than
   * being replaced.
   *
   * Re-defaulting instead of revealing was the bug: `size_ml` is a real,
   * previously-saved fact — half of `product_name_size_ml_unique` and the
   * divisor for the Phase 2 pour model — not a value the category select is
   * free to overwrite because it doesn't fit the new list. A hard seltzer
   * stored as Beer/bottle/355 re-filed to Spirits (355 is not a spirits
   * preset) must not silently become 750 on the next save of an unrelated
   * field; it must land in "Other…" showing the true 355, editable if it's
   * actually wrong. (enroll-form.tsx re-defaults on the same event, and
   * correctly: it has no stored value to protect because it is creating the
   * product, not editing one.)
   */
  function changeCategory(next: string) {
    setCategory(next);
    // A subcategory belongs to exactly one category — "Whiskey" under Beer is
    // not a narrower filter, it is a row that matches nothing. Clear it and
    // make the desk pick again rather than carrying a stale one across.
    if (next !== category) setSubcategory("");
    if (sizeMode === SIZE_OTHER) return;
    const ctx = { category: next, unitType: product.unitType };
    if (!isPresetSizeMl(Number(sizeMl), ctx)) setSizeMode(SIZE_OTHER);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);
    setFieldErrors({});

    const result = await updateProductAction({
      productId: product.id,
      name,
      brand: brand.trim() === "" ? null : brand,
      category,
      // Blank clears to null, same convention as brand and par above — the
      // select is always rendered with its current value, so an empty choice
      // is a deliberate "no type", not an omission.
      subcategory: subcategory.trim() === "" ? null : subcategory,
      sizeMl: Number(sizeMl),
      /**
       * Submitted whether or not the field is on screen — hiding it PRESERVES
       * the stored case size rather than clearing it.
       *
       * The trade, stated plainly. Preserving leaves a value the UI no longer
       * shows: a spirit can carry a case size nobody can see or edit here.
       * Clearing would instead destroy a real one — open a beer product,
       * brush the category select on the way to fixing a typo, and its case
       * size is gone, silently, in a save the person thought was about the
       * name.
       *
       * Preserving wins because the two mistakes are not the same size. A
       * stale case size on a spirit is inert: `computeLineUnits` reads it only
       * against a case count, spirits are never counted in cases, and
       * `incompleteReasons` doesn't ask about it for non-beer. A lost case
       * size on beer mis-values every case ever counted against it. Blanking
       * the box while it IS shown still clears it, so the desk keeps a
       * deliberate way to say "none".
       */
      caseSize: caseSize.trim() === "" ? null : Number(caseSize),
      vendorId: vendorId === "" ? null : Number(vendorId),
      // Blank clears the par rather than meaning "leave it alone" — the field
      // is always rendered with its current value, so a blank box is a
      // deliberate erasure, not an omission. The server distinguishes the two
      // (null clears, undefined ignores); this form only ever means the former.
      parLevel: parLevel.trim() === "" ? null : Number(parLevel),
      reorderPoint: reorderPoint.trim() === "" ? null : Number(reorderPoint),
      ...(canEditCost ? { currentUnitCost: cost.trim() === "" ? null : cost } : {}),
    });

    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      setFieldErrors(result.error.fieldErrors ?? {});
      return;
    }
    setSaved(true);
    router.refresh();
  }

  async function deactivate() {
    setPending(true);
    const result = await deactivateProductAction({ productId: product.id });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.push("/office/catalog");
  }

  return (
    // method="post" per CLAUDE.md's working agreement — see enroll-form.tsx
    // for the failure it prevents. A pre-hydration submit degrades to a bare
    // 405 instead of serializing fields into the query string.
    <form method="post" onSubmit={save} className="mt-6 flex flex-col gap-section-gap" noValidate>
      <section className="flex flex-col gap-4">
        <h2 className="text-label uppercase text-muted-foreground">Details</h2>

        <Field label="Name" htmlFor="name" error={fieldErrors.name}>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>

        <Field
          label="Brand / producer"
          htmlFor="brand"
          error={fieldErrors.brand}
          hint={
            category.toLowerCase() === "wine" && !brand
              ? "Wines seeded as varietals need a producer before they can be costed or scanned."
              : undefined
          }
        >
          <Input id="brand" value={brand} onChange={(e) => setBrand(e.target.value)} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category" htmlFor="category" error={fieldErrors.category}>
            <Select
              id="category"
              value={category}
              onChange={(e) => changeCategory(e.target.value)}
            >
              {["Spirits", "Beer", "Wine", "Liqueur", "NA"].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>

          {/*
            Type (the `subcategory` column) — this is the ONLY control in the
            app that writes it. The seed was previously its only writer, so a
            product enrolled by scanning a barcode had no type and no way to
            get one, which is invisible until the catalog's type filters go
            looking for it.

            Optional, and blank is a legitimate answer. Forcing a choice would
            invite a wrong one on the products this exists to fix — an unknown
            spirit filed as "Whiskey" to clear a required field is worse than
            one honestly filed as nothing, because the filter would then
            confidently return it.
          */}
          <Field
            label="Type"
            htmlFor="subcategory"
            error={fieldErrors.subcategory}
            hint="Optional. Drives the catalog's type filters."
          >
            <Select
              id="subcategory"
              value={subcategory}
              onChange={(e) => setSubcategory(e.target.value)}
            >
              <option value="">— None —</option>
              {subcategoryOptions(category, product.subcategory).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          {/*
            The desk is where an unlisted size gets entered — the count leg is
            dropdown-only on purpose (see lib/bottle-sizes.ts), so this
            "Other…" is the only path to one. Removing it would strand any
            product whose real size is not a preset.
          */}
          <Field
            label="Size"
            htmlFor="size"
            error={fieldErrors.sizeMl}
            hint={sizeMode === SIZE_OTHER ? "Millilitres." : undefined}
          >
            <Select
              id="size"
              value={sizeMode === SIZE_OTHER ? SIZE_OTHER : sizeMl}
              onChange={(e) => {
                // Switching TO "Other…" keeps the current number rather than
                // blanking it: the box opens on what the product actually is,
                // so an accidental tap on Other costs nothing.
                if (e.target.value === SIZE_OTHER) {
                  setSizeMode(SIZE_OTHER);
                  return;
                }
                setSizeMode("preset");
                setSizeMl(e.target.value);
              }}
            >
              {sizes.map((s) => (
                <option key={s.ml} value={s.ml}>
                  {s.label}
                </option>
              ))}
              <option value={SIZE_OTHER}>Other…</option>
            </Select>
            {sizeMode === SIZE_OTHER ? (
              <Input
                id="size-other"
                type="number"
                inputMode="numeric"
                aria-label="Size in millilitres"
                value={sizeMl}
                onChange={(e) => setSizeMl(e.target.value)}
              />
            ) : null}
          </Field>
        </div>

        {/*
          Only bottled beer is counted by the case, so only bottled beer gets
          the field. CLAUDE.md is explicit that a blank case size on a spirit,
          wine or keg is correct rather than missing data; a rendered box —
          even one hinting "leave blank" — is an invitation to backfill a pack
          level the bar doesn't use.

          Keyed off the LIVE category select rather than `product.category`,
          so recategorising a spirit to Beer reveals the field in the same
          edit that needs it.
        */}
        {isCountedByCase({ category, unitType: product.unitType }) ? (
          <Field
            label="Case size"
            htmlFor="caseSize"
            error={fieldErrors.caseSize}
            hint="Bottled beer is counted by the case and by the each — this is needed."
          >
            <Input
              id="caseSize"
              type="number"
              inputMode="numeric"
              value={caseSize}
              onChange={(e) => setCaseSize(e.target.value)}
            />
          </Field>
        ) : null}

        <Field label="Vendor" htmlFor="vendor" error={fieldErrors.vendorId}>
          <Select id="vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">No vendor</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </Field>
      </section>

      {/*
        Par is not a product column — it is a `product_par` row with
        `location_id IS NULL`, the "one par overall" convention the MVP
        writes (spec §8). Per-location pars are still an open question
        (CLAUDE.md open question 2) and the nullable column is what keeps it
        open; nothing here answers it.

        This section is visible to managers as well as owners. Par levels are
        quantities, not cost data, and running the reorder is a manager's job
        (spec §4) — invariant 8 gates money, not stock.
      */}
      <section className="flex flex-col gap-4">
        <h2 className="text-label uppercase text-muted-foreground">Reordering</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Par level"
            htmlFor="parLevel"
            error={fieldErrors.parLevel}
            hint="Target stock to hold. Blank means this product never appears on the reorder list."
          >
            <Input
              id="parLevel"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={parLevel}
              onChange={(e) => setParLevel(e.target.value)}
            />
          </Field>
          <Field
            label="Reorder point"
            htmlFor="reorderPoint"
            error={fieldErrors.reorderPoint}
            hint="Order when on-hand drops to this. Blank uses the par level itself."
          >
            <Input
              id="reorderPoint"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={reorderPoint}
              onChange={(e) => setReorderPoint(e.target.value)}
            />
          </Field>
        </div>
      </section>

      {canEditCost ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-label uppercase text-muted-foreground">Pricing</h2>
          <Field
            label="Current unit cost"
            htmlFor="cost"
            error={fieldErrors.currentUnitCost}
            hint="Changing this does not re-value any closed count — those hold their own snapshot."
          >
            <Input
              id="cost"
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              placeholder="0.0000"
            />
          </Field>
        </section>
      ) : null}

      {error ? (
        <p className="rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="rounded-md bg-success-bg px-3 py-2 text-caption text-success" role="status">
          Saved.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="primary" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        {/*
          Invariant 6: never hard-delete. This deactivates — history still
          references the product, and it simply stops appearing on count
          screens. The label says "deactivate", not "delete", because those
          are different things and the difference matters here.
        */}
        {product.active ? (
          <Button variant="outline" size="primary" onClick={deactivate} disabled={pending}>
            Deactivate
          </Button>
        ) : (
          <span className="flex min-h-tap-primary items-center text-caption text-muted-foreground">
            Inactive — hidden from counts, kept for history.
          </span>
        )}
      </div>
    </form>
  );
}
