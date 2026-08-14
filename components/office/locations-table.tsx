"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createLocationAction,
  updateLocationAction,
  deactivateLocationAction,
} from "@/app/actions/catalog";
import type { LocationSummary } from "@/lib/domain/catalog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";

const countModeLabel: Record<string, string> = {
  tenths: "Tenths",
  quantity: "Quantity",
};

/**
 * Location create/edit form. Mirrors `VendorEditForm`: `location` undefined
 * means create mode, populated means edit mode.
 *
 * `countMode` is a required select (no "leave blank" option) — every
 * location must have one, and the row it drives (`components/count/count-leg.tsx`
 * keying off `location.countMode === "tenths"`) has no sensible undefined
 * state. `notes` follows the empty-string-clears-to-null convention already
 * used on `VendorEditForm`'s `contact`/`orderMethod`.
 */
function LocationEditForm({
  location,
  onSuccess,
}: {
  location?: LocationSummary;
  onSuccess?: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(location?.name ?? "");
  const [countMode, setCountMode] = useState<string>(location?.countMode ?? "tenths");
  const [sortOrder, setSortOrder] = useState(
    location?.sortOrder != null ? String(location.sortOrder) : "",
  );
  const [notes, setNotes] = useState(location?.notes ?? "");

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

    const input = {
      ...(location ? { locationId: location.id } : {}),
      name: name.trim(),
      countMode,
      ...(sortOrder.trim() === "" ? {} : { sortOrder: Number(sortOrder) }),
      notes: notes.trim() === "" ? null : notes.trim(),
    };

    const action = location ? updateLocationAction : createLocationAction;
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

  const isCreate = !location;

  return (
    <form method="post" onSubmit={save} className="flex flex-col gap-section-gap" noValidate>
      <section className="flex flex-col gap-4">
        <h2 className="text-label uppercase text-muted-foreground">
          {location ? `Edit ${location.name}` : "New location"}
        </h2>

        <Field label="Name" htmlFor="loc-name" error={fieldErrors.name}>
          <Input
            id="loc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Patio Bar"
            required
          />
        </Field>

        <Field
          label="Counting mode"
          htmlFor="loc-count-mode"
          error={fieldErrors.countMode}
          hint="Tenths offers a fill pad for open bottles (and still accepts sealed quantities). Quantity is numbers only, for sealed backstock."
        >
          <Select
            id="loc-count-mode"
            value={countMode}
            onChange={(e) => setCountMode(e.target.value)}
          >
            <option value="tenths">Tenths</option>
            <option value="quantity">Quantity</option>
          </Select>
        </Field>

        <Field
          label="Sort order"
          htmlFor="loc-sort-order"
          error={fieldErrors.sortOrder}
          hint="Lower numbers list first on the counting screen. Leave blank to default to 0."
        >
          <Input
            id="loc-sort-order"
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            placeholder="Optional"
          />
        </Field>

        <Field label="Notes" htmlFor="loc-notes" error={fieldErrors.notes} hint="Optional operational notes.">
          <Input
            id="loc-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
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
          {pending ? (isCreate ? "Creating…" : "Saving…") : isCreate ? "Create location" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Locations management screen: list + inline create/edit form, mirroring
 * `VendorsList` + `VendorEditForm`'s combined shape.
 *
 * `locations` is `listAllLocationsAction`'s payload — active AND retired.
 * A retired row is shown, marked, and still editable (renaming a retired
 * location is harmless — its name still occupies the unique-name slot per
 * Decision 1).
 *
 * Retire (Slice 3) is a row-level, two-step tap-to-confirm control — no
 * modal, per Gate 2 Flow 2: this action is rare enough that a confirmation
 * dialog isn't earning its keep the way it would on a control used 150
 * times a count. The first tap arms `retireCandidateId`; a second tap on
 * "Confirm retire?" calls `deactivateLocationAction`. Either guard refusal
 * (last active location / in use by an open count) surfaces as an inline
 * message on that row, not a page-level banner — this table can have many
 * rows and the message is about ONE of them.
 */
export function LocationsTable({ locations }: { locations: LocationSummary[] }) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [retireCandidateId, setRetireCandidateId] = useState<number | null>(null);
  const [retirePendingId, setRetirePendingId] = useState<number | null>(null);
  const [retireErrors, setRetireErrors] = useState<Record<number, string>>({});

  /**
   * `locations` is a server-component prop — closing the form does not by
   * itself re-read it. Force a refetch on every successful save, the same
   * way `VendorsList.handleFormSuccess` does, so a save never leaves the
   * screen showing stale pre-edit values.
   */
  function handleFormSuccess() {
    setShowForm(false);
    setEditingId(null);
    router.refresh();
  }

  function handleEditClick(locationId: number) {
    setEditingId(locationId);
    setShowForm(true);
  }

  /** First tap: arm the row's confirm step. Does not call the server yet. */
  function handleRetireClick(event: React.MouseEvent, locationId: number) {
    event.stopPropagation();
    setRetireErrors((prev) => {
      const next = { ...prev };
      delete next[locationId];
      return next;
    });
    setRetireCandidateId(locationId);
  }

  function handleCancelRetire(event: React.MouseEvent) {
    event.stopPropagation();
    setRetireCandidateId(null);
  }

  /** Second tap: the actual call. Either guard refusal shows on this row only. */
  async function handleConfirmRetire(event: React.MouseEvent, locationId: number) {
    event.stopPropagation();
    setRetirePendingId(locationId);
    const result = await deactivateLocationAction({ locationId });
    setRetirePendingId(null);
    setRetireCandidateId(null);

    if (!result.ok) {
      setRetireErrors((prev) => ({ ...prev, [locationId]: result.error.message }));
      return;
    }
    setRetireErrors((prev) => {
      const next = { ...prev };
      delete next[locationId];
      return next;
    });
    router.refresh();
  }

  const activeCount = locations.filter((l) => l.active).length;

  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-row-subtitle text-muted-foreground">
          {activeCount} active, {locations.length - activeCount} retired.
        </p>
        <Button
          onClick={() => {
            if (showForm) {
              setShowForm(false);
              setEditingId(null);
            } else {
              setEditingId(null);
              setShowForm(true);
            }
          }}
          size="primary"
        >
          {showForm ? "Cancel" : "Add location"}
        </Button>
      </div>

      {showForm ? (
        <div className="rounded-md border border-border bg-card p-6">
          <LocationEditForm
            location={editingId ? locations.find((l) => l.id === editingId) : undefined}
            onSuccess={handleFormSuccess}
          />
        </div>
      ) : null}

      {locations.length === 0 ? (
        <p className="max-w-prose text-row-subtitle text-muted-foreground">
          No locations yet. Add one to give the counting screen a place to scan into.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-2 text-label uppercase text-muted-foreground">
                  Name
                </th>
                <th scope="col" className="py-2 text-label uppercase text-muted-foreground">
                  Counting mode
                </th>
                <th scope="col" className="py-2 text-right text-label uppercase text-muted-foreground">
                  Sort order
                </th>
                {/* `pl-4` because the column to the left is right-aligned, so
                    its content ends flush against this one's start and the two
                    render as "SORT ORDERSTATUS" / "1Active" with nothing
                    between them. */}
                <th scope="col" className="py-2 pl-4 text-label uppercase text-muted-foreground">
                  Status
                </th>
                <th scope="col" className="py-2 text-right text-label uppercase text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {locations.map((loc) => (
                <Fragment key={loc.id}>
                  <tr className="border-b border-border align-top">
                    <td className="py-3">
                      <span className="block text-row-subtitle font-semibold text-foreground">
                        {loc.name}
                      </span>
                      {loc.notes ? (
                        <span className="block text-caption text-muted-foreground">{loc.notes}</span>
                      ) : null}
                    </td>
                    <td className="py-3 text-row-subtitle text-muted-foreground">
                      {countModeLabel[loc.countMode] ?? loc.countMode}
                    </td>
                    <td className="py-3 text-right text-row-subtitle tabular-nums text-muted-foreground">
                      {loc.sortOrder}
                    </td>
                    <td className="py-3 pl-4 text-row-subtitle">
                      {loc.active ? (
                        <span className="text-muted-foreground">Active</span>
                      ) : (
                        <span className="text-negative">Retired</span>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="tap"
                          onClick={() => handleEditClick(loc.id)}
                        >
                          Edit
                        </Button>
                        {loc.active ? (
                          retireCandidateId === loc.id ? (
                            <>
                              <Button
                                variant="outline"
                                size="tap"
                                onClick={(e) => handleCancelRetire(e)}
                                disabled={retirePendingId === loc.id}
                              >
                                Cancel
                              </Button>
                              <Button
                                variant="destructive"
                                size="tap"
                                onClick={(e) => handleConfirmRetire(e, loc.id)}
                                disabled={retirePendingId === loc.id}
                              >
                                {retirePendingId === loc.id ? "Retiring…" : "Confirm retire?"}
                              </Button>
                            </>
                          ) : (
                            <Button variant="outline" size="tap" onClick={(e) => handleRetireClick(e, loc.id)}>
                              Retire
                            </Button>
                          )
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {retireErrors[loc.id] ? (
                    <tr key={`${loc.id}-error`} className="border-b border-border">
                      <td colSpan={5} className="pb-3">
                        <p
                          className="rounded-md bg-negative-bg px-3 py-2 text-caption text-negative"
                          role="alert"
                        >
                          {retireErrors[loc.id]}
                        </p>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
