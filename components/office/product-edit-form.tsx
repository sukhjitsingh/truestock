"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateProductAction, deactivateProductAction } from "@/app/actions/catalog";
import type { ProductSummary, VendorSummary } from "@/lib/domain/catalog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";

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
  const [sizeMl, setSizeMl] = useState(String(product.sizeMl));
  const [caseSize, setCaseSize] = useState(product.caseSize == null ? "" : String(product.caseSize));
  const [vendorId, setVendorId] = useState(product.vendorId == null ? "" : String(product.vendorId));
  const [cost, setCost] = useState(product.currentUnitCost ?? "");

  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

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
      sizeMl: Number(sizeMl),
      caseSize: caseSize.trim() === "" ? null : Number(caseSize),
      vendorId: vendorId === "" ? null : Number(vendorId),
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
    <form onSubmit={save} className="mt-6 flex flex-col gap-section-gap" noValidate>
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
              onChange={(e) => setCategory(e.target.value)}
            >
              {["Spirits", "Beer", "Wine", "Liqueur", "NA"].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Size (ml)" htmlFor="size" error={fieldErrors.sizeMl}>
            <Input
              id="size"
              type="number"
              inputMode="numeric"
              value={sizeMl}
              onChange={(e) => setSizeMl(e.target.value)}
            />
          </Field>
        </div>

        <Field
          label="Case size"
          htmlFor="caseSize"
          error={fieldErrors.caseSize}
          hint={
            // CLAUDE.md is explicit that a blank case size on a spirit, wine
            // or keg is correct rather than missing data, and that
            // backfilling one would invent a pack level the bar doesn't use.
            // The hint says so, so nobody "fixes" it.
            category === "Beer" && product.unitType !== "keg"
              ? "Bottled beer is counted by the case and by the each — this is needed."
              : "Leave blank. Only bottled beer is counted by the case."
          }
        >
          <Input
            id="caseSize"
            type="number"
            inputMode="numeric"
            value={caseSize}
            onChange={(e) => setCaseSize(e.target.value)}
          />
        </Field>

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
