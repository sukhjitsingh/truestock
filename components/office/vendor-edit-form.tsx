"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createVendorAction, updateVendorAction } from "@/app/actions/catalog";
import type { VendorSummary } from "@/lib/domain/catalog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";

/**
 * Vendor create/edit form.
 *
 * Handles both creation (when vendor is undefined) and editing (when vendor
 * is provided). In create mode, the form is minimal; in edit mode it shows
 * the current values. No deactivate button — there is no delete path for
 * vendors (task spec).
 *
 * Common order methods are offered in a select with a free-text option:
 * "email", "phone", "portal", "rep" are typical, but the column is a free
 * varchar so any method can be stored. Offering presets with an "Other…"
 * option keeps the UI predictable while not constraining the data.
 *
 * Lead time is in days and must be a non-negative integer, or null for
 * "unknown". Empty input submits as null rather than 0, because 0 days is a
 * real claim (instant availability) and "we don't know" is different.
 */
export function VendorEditForm({
  vendor,
  onSuccess,
}: {
  vendor?: VendorSummary;
  onSuccess?: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(vendor?.name ?? "");
  const [contact, setContact] = useState(vendor?.contact ?? "");
  const [orderMethod, setOrderMethod] = useState(vendor?.orderMethod ?? "");
  /**
   * Order method is a free varchar but we offer common presets with an
   * "Other…" option for flexibility. When "other" is selected, show a text
   * input for free-form entry.
   */
  const [orderMethodMode, setOrderMethodMode] = useState<"preset" | "other">(
    vendor && vendor.orderMethod && !["email", "phone", "portal", "rep"].includes(vendor.orderMethod)
      ? "other"
      : "preset",
  );
  const [leadTimeDays, setLeadTimeDays] = useState(
    vendor?.leadTimeDays == null ? "" : String(vendor.leadTimeDays),
  );

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

    // Convert leadTimeDays to number or null
    const leadTime = leadTimeDays.trim() === "" ? null : Number(leadTimeDays);

    const input = {
      ...(vendor ? { id: vendor.id } : {}),
      name: name.trim(),
      contact: contact.trim() === "" ? null : contact.trim(),
      orderMethod: orderMethod.trim() === "" ? null : orderMethod.trim(),
      leadTimeDays: leadTime,
    };

    const action = vendor ? updateVendorAction : createVendorAction;
    const result = await action(input);

    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      setFieldErrors(result.error.fieldErrors ?? {});
      return;
    }

    setSaved(true);
    if (onSuccess) {
      onSuccess();
    } else {
      router.refresh();
    }
  }

  const isCreate = !vendor;

  return (
    <form method="post" onSubmit={save} className="flex flex-col gap-section-gap" noValidate>
      <section className="flex flex-col gap-4">
        <h2 className="text-label uppercase text-muted-foreground">
          {isCreate ? "New vendor" : "Edit vendor"}
        </h2>

        <Field label="Name" htmlFor="name" error={fieldErrors.name}>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Beverage Distributors Inc."
            required
          />
        </Field>

        <Field label="Contact" htmlFor="contact" error={fieldErrors.contact} hint="Phone, email, or contact person">
          <Input
            id="contact"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="Optional"
          />
        </Field>

        <Field
          label="Order method"
          htmlFor="orderMethod"
          error={fieldErrors.orderMethod}
          hint="How orders are placed with this vendor. Common methods shown; use Other for custom values."
        >
          <Select
            id="orderMethod"
            value={orderMethodMode === "other" ? "other" : orderMethod}
            onChange={(e) => {
              if (e.target.value === "other") {
                setOrderMethodMode("other");
              } else {
                setOrderMethodMode("preset");
                setOrderMethod(e.target.value);
              }
            }}
          >
            <option value="">No method set</option>
            <option value="email">Email</option>
            <option value="phone">Phone</option>
            <option value="portal">Portal</option>
            <option value="rep">Sales rep</option>
            <option value="other">Other…</option>
          </Select>
          {orderMethodMode === "other" ? (
            <Input
              id="orderMethod-other"
              type="text"
              aria-label="Custom order method"
              value={orderMethod}
              onChange={(e) => setOrderMethod(e.target.value)}
              placeholder="Enter custom method"
            />
          ) : null}
        </Field>

        <Field
          label="Lead time"
          htmlFor="leadTimeDays"
          error={fieldErrors.leadTimeDays}
          hint="Days from order to delivery. Leave blank if unknown."
        >
          <Input
            id="leadTimeDays"
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            value={leadTimeDays}
            onChange={(e) => setLeadTimeDays(e.target.value)}
            placeholder="Optional"
          />
        </Field>
      </section>

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
          {pending ? (isCreate ? "Creating…" : "Saving…") : isCreate ? "Create vendor" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
