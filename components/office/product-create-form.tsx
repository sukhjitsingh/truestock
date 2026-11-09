"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createProductAction } from "@/app/actions/catalog";
import type { VendorSummary } from "@/lib/domain/catalog";
import { bottleSizesFor, defaultSizeMlFor, isPresetSizeMl } from "@/lib/bottle-sizes";
import { isCountedByCase } from "@/lib/pack-level";
import { subcategoryOptions } from "@/lib/subcategories";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";

const CATEGORIES = ["Spirits", "Beer", "Wine", "Liqueur", "NA"] as const;
const UNIT_TYPES = [
  { value: "bottle", label: "Bottle" },
  { value: "can", label: "Can" },
  { value: "keg", label: "Keg" },
] as const;
type UnitType = (typeof UNIT_TYPES)[number]["value"];
const SIZE_OTHER = "other";

/**
 * Back-office "Add product" (QA 2026-11-08, finding 1).
 *
 * Until this existed the only way to create a product was scanning an unknown
 * barcode on the phone, so anything without a usable barcode — a house
 * infusion, a damaged label, most wine — could not be added at all, while the
 * phone's catalog screen told people to add it "from the back office".
 *
 * The barcode is optional. When given, it goes through the same server path
 * as scan-to-enroll: `createProduct` stores it in the 14-digit standard form
 * via `normalizeBarcode` and refuses one that is already on another product,
 * naming that product. No format is sent — a typed code has no symbology —
 * so an 8-digit code is stored as typed rather than guessed at (AGENTS.md).
 *
 * Par and reorder point live on the edit page, which this form hands off to
 * on success, so the two forms never disagree about how par is written.
 * Cost is in this form for an owner only, and absent from a manager's DOM,
 * as on the edit form.
 */
export function ProductCreateForm({ vendors, canEditCost }: { vendors: VendorSummary[]; canEditCost: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState<string>("Spirits");
  const [subcategory, setSubcategory] = useState("");
  const [unitType, setUnitType] = useState<UnitType>("bottle");
  const [sizeMl, setSizeMl] = useState(String(defaultSizeMlFor({ category: "Spirits", unitType: "bottle" })));
  const [sizeMode, setSizeMode] = useState<"preset" | typeof SIZE_OTHER>("preset");
  const [caseSize, setCaseSize] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [cost, setCost] = useState("");
  const [barcode, setBarcode] = useState("");
  const [packLevel, setPackLevel] = useState<"each" | "case">("each");

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const sizes = bottleSizesFor({ category, unitType });
  const countedByCase = isCountedByCase({ category, unitType });
  const nameMissing = name.trim().length === 0;

  /**
   * Category or unit changed: re-default the size, as enroll-form does. There
   * is no stored size to protect while creating, so a preset that no longer
   * fits is replaced by the new list's default; a typed "Other…" size is left.
   */
  function retarget(next: { category?: string; unitType?: UnitType }) {
    const ctx = { category: next.category ?? category, unitType: next.unitType ?? unitType };
    if (next.category !== undefined) {
      if (next.category !== category) setSubcategory("");
      setCategory(next.category);
    }
    if (next.unitType !== undefined) setUnitType(next.unitType);
    if (sizeMode === SIZE_OTHER) return;
    if (!isPresetSizeMl(Number(sizeMl), ctx)) setSizeMl(String(defaultSizeMlFor(ctx)));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setFieldErrors({});

    const code = barcode.replace(/\s+/g, "");
    const result = await createProductAction({
      name,
      ...(brand.trim() ? { brand } : {}),
      category,
      ...(subcategory ? { subcategory } : {}),
      unitType,
      sizeMl: Number(sizeMl),
      ...(countedByCase && caseSize.trim() ? { caseSize: Number(caseSize) } : {}),
      ...(vendorId ? { vendorId: Number(vendorId) } : {}),
      ...(canEditCost && cost.trim() ? { currentUnitCost: cost.trim() } : {}),
      ...(code ? { barcode: { barcode: code, packLevel: countedByCase ? packLevel : "each", isPrimary: true } } : {}),
    });

    if (!result.ok) {
      setPending(false);
      setError(result.error.message);
      setFieldErrors(result.error.fieldErrors ?? {});
      return;
    }
    // Straight to the product's own page: par and reorder point are set there.
    router.push(`/office/catalog/${result.data.id}?created=1`);
  }

  return (
    // method="post": a pre-hydration submit degrades to a 405, never a GET
    // that serialises the form into the URL (AGENTS.md).
    <form method="post" onSubmit={save} className="mt-6 flex flex-col gap-section-gap" noValidate>
      <section className="flex flex-col gap-4">
        <h2 className="text-label uppercase text-muted-foreground">Details</h2>

        <Field
          label="Name"
          htmlFor="name"
          error={fieldErrors.name}
          hint={nameMissing ? "Enter a name to save" : undefined}
        >
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. House Pineapple Rum"
            className="placeholder:italic"
            required
          />
        </Field>

        <Field
          label="Brand / producer"
          htmlFor="brand"
          error={fieldErrors.brand}
          hint={category === "Wine" ? "Wine needs a producer before it can be costed or scanned." : "Optional."}
        >
          <Input id="brand" value={brand} onChange={(e) => setBrand(e.target.value)} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category" htmlFor="category" error={fieldErrors.category}>
            <Select id="category" value={category} onChange={(e) => retarget({ category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type" htmlFor="subcategory" error={fieldErrors.subcategory} hint="Optional.">
            <Select id="subcategory" value={subcategory} onChange={(e) => setSubcategory(e.target.value)}>
              <option value="">— None —</option>
              {subcategoryOptions(category, null).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unit" htmlFor="unitType" error={fieldErrors.unitType}>
            <Select
              id="unitType"
              value={unitType}
              onChange={(e) => retarget({ unitType: e.target.value as UnitType })}
            >
              {UNIT_TYPES.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </Select>
          </Field>
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

        {countedByCase ? (
          <Field
            label="Case size"
            htmlFor="caseSize"
            error={fieldErrors.caseSize}
            hint="Bottled beer is counted by the case and by the each — enter it if you know it."
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

      <section className="flex flex-col gap-4">
        <h2 className="text-label uppercase text-muted-foreground">Barcode</h2>
        <Field
          label="Barcode"
          htmlFor="barcode"
          error={fieldErrors["barcode.barcode"] ?? fieldErrors.barcode}
          hint="Optional. Leave blank for house infusions, damaged labels and wine without a usable code — it can be scanned onto the product later."
        >
          <Input
            id="barcode"
            inputMode="numeric"
            autoComplete="off"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
          />
        </Field>
        {countedByCase && barcode.trim() ? (
          <Field label="This barcode is on the" htmlFor="packLevel">
            <Select id="packLevel" value={packLevel} onChange={(e) => setPackLevel(e.target.value as "each" | "case")}>
              <option value="each">Single bottle or can</option>
              <option value="case">Case carton</option>
            </Select>
          </Field>
        ) : null}
      </section>

      {canEditCost ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-label uppercase text-muted-foreground">Pricing</h2>
          <Field label="Current unit cost" htmlFor="cost" error={fieldErrors.currentUnitCost} hint="Optional.">
            <Input id="cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.0000" />
          </Field>
        </section>
      ) : null}

      {error ? (
        <p className="rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="primary" disabled={pending || nameMissing || sizeMl.trim() === ""}>
          {pending ? "Adding…" : "Add product"}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.push("/office/catalog")}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
