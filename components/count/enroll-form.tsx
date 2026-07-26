"use client";

import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import { createProductAction } from "@/app/actions/catalog";
import type { ProductSummary } from "@/lib/domain/catalog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";

const CATEGORIES = ["Spirits", "Beer", "Wine", "Liqueur", "NA"];

/**
 * Scan-to-enroll: an unknown barcode opens this, the product is created, and
 * counting continues.
 *
 * THIS FORM HAS A 20-SECOND BUDGET (CLAUDE.md, spec §12, and risk #2 in spec
 * §14). It is the single highest-risk interaction in the MVP: if enrolling a
 * product is painful, the catalog decays and the whole system dies with it.
 * Everything that follows is in service of that:
 *
 *  - Four fields. Name, category, size, unit type. Nothing else is required,
 *    because everything else is editable later from the back office at a desk.
 *  - No cost field at all. Cost is owner-only and would be dropped for anyone
 *    else anyway (lib/domain/catalog.ts), so showing it to the manager or
 *    bartender who is actually mid-count would be a field that silently does
 *    nothing. Cost comes off a supplier invoice, not off a bottle in the dark.
 *  - No vendor, no par, no reorder point. Same reason.
 *  - Size defaults to 750 — the overwhelming majority of the catalog
 *    (CLAUDE.md: "Spirits default to 750 ml"), so the common case is zero taps.
 *
 * If a field is ever added here, something else has to come off. That is the
 * trade, and it is deliberate.
 */
export function EnrollForm({
  barcode,
  onCancel,
  onCreated,
}: {
  barcode: string;
  onCancel: () => void;
  onCreated: (product: ProductSummary) => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Spirits");
  const [sizeMl, setSizeMl] = useState("750");
  const [unitType, setUnitType] = useState<"bottle" | "can" | "keg">("bottle");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
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
      return;
    }
    onCreated(result.data);
  }

  return (
    <div className="px-bar-pad pb-8 pt-6">
      <button
        type="button"
        onClick={onCancel}
        className="mb-4 flex items-center gap-1 text-caption text-muted-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden="true" /> Back
      </button>

      <h1 className="text-header-title text-foreground">New product</h1>
      <p className="mt-1 text-row-subtitle text-muted-foreground">
        Barcode <span className="tabular-nums text-foreground">{barcode}</span> isn&rsquo;t in
        the catalog yet. Name it and keep counting — the rest can be filled in later.
      </p>

      <form onSubmit={submit} className="mt-section-gap flex flex-col gap-4" noValidate>
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
          <Select id="p-category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Size (ml)" htmlFor="p-size" error={fieldErrors.sizeMl}>
            <Input
              id="p-size"
              type="number"
              inputMode="numeric"
              value={sizeMl}
              onChange={(e) => setSizeMl(e.target.value)}
              required
            />
          </Field>
          <Field label="Unit" htmlFor="p-unit" error={fieldErrors.unitType}>
            <Select
              id="p-unit"
              value={unitType}
              onChange={(e) => setUnitType(e.target.value as typeof unitType)}
            >
              <option value="bottle">Bottle</option>
              <option value="can">Can</option>
              <option value="keg">Keg</option>
            </Select>
          </Field>
        </div>

        {error ? (
          <p className="rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex gap-3">
          <Button variant="outline" size="primary" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="primary" className="flex-[1.4]" disabled={pending || !name}>
            {pending ? "Saving…" : "Save and count"}
          </Button>
        </div>
      </form>
    </div>
  );
}
