"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createVendorAction, updateVendorAction } from "@/app/actions/catalog";
import type { VendorSummary } from "@/lib/domain/catalog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { ORDER_METHODS, isOrderMethod } from "@/lib/vendor-order-methods";

/**
 * Vendor create/edit form.
 *
 * Handles both creation (when vendor is undefined) and editing (when vendor
 * is provided). In create mode, the form is minimal; in edit mode it shows
 * the current values. No deactivate button — there is no delete path for
 * vendors (task spec).
 *
 * Order method is a fixed list (lib/vendor-order-methods.ts, QA 2026-11-08):
 * Email, Phone, Text message, Portal, Sales rep. There is no free-text
 * option. A value stored before the list was fixed is shown as its own
 * option and is only sent back if the user picks something else, so opening
 * and saving an old vendor never silently erases it or trips validation.
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
  const initialOrderMethod = vendor?.orderMethod ?? "";
  const [orderMethod, setOrderMethod] = useState(initialOrderMethod);
  const legacyOrderMethod = initialOrderMethod !== "" && !isOrderMethod(initialOrderMethod) ? initialOrderMethod : null;
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
      // An unchanged legacy value is left alone (not sent) rather than refused.
      ...(legacyOrderMethod !== null && orderMethod === legacyOrderMethod
        ? {}
        : { orderMethod: orderMethod === "" ? null : orderMethod }),
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
          {isCreate ? "New vendor" : `Edit ${vendor.name}`}
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
          hint="How orders are placed with this vendor."
        >
          <Select id="orderMethod" value={orderMethod} onChange={(e) => setOrderMethod(e.target.value)}>
            <option value="">No method set</option>
            {ORDER_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
            {legacyOrderMethod !== null ? (
              <option value={legacyOrderMethod}>{legacyOrderMethod} (no longer offered)</option>
            ) : null}
          </Select>
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
