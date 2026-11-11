"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { orderMethodLabel } from "@/lib/vendor-order-methods";
import { useRouter } from "next/navigation";
import type { VendorSummary } from "@/lib/domain/catalog";
import {
  TableContainer,
  Table,
  TableCaption,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { NullValue } from "@/components/ui/null-value";
import { Button } from "@/components/ui/button";
import { deactivateVendorAction, reactivateVendorAction } from "@/app/actions/catalog";
import { VendorEditForm } from "./vendor-edit-form";

type Armed = { id: number; kind: "retire" | "reactivate" };

function productsLabel(n: number): string {
  return `${n} ${n === 1 ? "product" : "products"}`;
}

/** Text shown under an armed Retire: names the product count. */
export function retireWarning(count: number): string {
  if (count === 0) return "No products use this vendor.";
  return count === 1
    ? "1 product still uses this vendor. It stays usable; reassign it to keep reordering it."
    : `${count} products still use this vendor. They stay usable; reassign them to keep reordering them.`;
}

/** Text shown under an armed Reactivate. */
export function reactivateWarning(name: string, count: number): string {
  const base = `Reactivate ${name}? It will appear in every vendor list again`;
  return count === 0
    ? `${base}.`
    : `${base}, and ${productsLabel(count)} assigned to it will stop being flagged.`;
}

/**
 * Vendors list with inline create/edit form.
 *
 * Shows all vendors in a table. An empty state explains that vendors group
 * reorder lines and why they matter. A "Create vendor" button reveals an inline
 * form for adding the first vendor or subsequent ones. Each row carries an
 * explicit Edit button.
 *
 * The empty state is critical — docs/mvp-gaps.md finding A calls this out: the
 * reorder screen's empty state once said "Nothing is below its reorder point,"
 * which was reassuring and false when the root cause was "no vendors exist."
 * This screen's empty state must explain what vendors are, what they enable,
 * and how to create one.
 *
 * Editing is inline in the same form used for creation (VendorEditForm detects
 * mode by checking if vendor is undefined vs populated). The row's Edit button
 * sets editingId and scrolls the form into view. Cancel or successful save
 * closes it.
 *
 * Edit is a real button rather than a click on the whole `<tr>`, and the form
 * heading names the vendor. Both were changed 2026-08-12 (open item 27) after
 * the identical pattern on `/office/locations` put a click on the wrong row:
 * rows reflow as the inline form opens above them, so a click aimed at one row
 * landed on another and prefilled its name, one confirm away from renaming a
 * real record with nothing on screen looking wrong. A `<tr>` with an `onClick`
 * is also unreachable by keyboard and invisible to a screen reader. See
 * `locations-table.tsx` for the reference implementation.
 */
export function VendorsList({ vendors }: { vendors: VendorSummary[] }) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  // One armed row at a time (retire or reactivate); the first tap only arms.
  const [armed, setArmed] = useState<Armed | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const tableRef = useRef<HTMLDivElement>(null);
  // Focus to apply after the next render: Cancel on the armed row (a stray
  // second tap then cancels, not confirms), or the row's primary button.
  const pendingFocus = useRef<{ kind: "cancel" | "primary"; id: number } | null>(null);

  useEffect(() => {
    const target = pendingFocus.current;
    const root = tableRef.current;
    if (!target || !root) return;
    const attr = target.kind === "cancel" ? "data-vendor-cancel" : "data-vendor-primary";
    const el = root.querySelector<HTMLElement>(`[${attr}="${target.id}"]`);
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  }, [vendors, armed, pendingId]);

  function arm(vendorId: number, kind: Armed["kind"]) {
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[vendorId];
      return next;
    });
    setArmed({ id: vendorId, kind });
    pendingFocus.current = { kind: "cancel", id: vendorId };
  }

  function cancelArm(vendorId: number) {
    setArmed(null);
    pendingFocus.current = { kind: "primary", id: vendorId };
  }

  async function confirmArm(vendor: VendorSummary, kind: Armed["kind"]) {
    setPendingId(vendor.id);
    let result: Awaited<ReturnType<typeof deactivateVendorAction>>;
    try {
      result =
        kind === "retire"
          ? await deactivateVendorAction({ vendorId: vendor.id })
          : await reactivateVendorAction({ vendorId: vendor.id });
    } catch {
      // A server action throws (rather than returning an error) when the network
      // is down; without this the row stays on "Retiring…" until a reload.
      setRowErrors((prev) => ({
        ...prev,
        [vendor.id]: "Couldn’t reach the server. Reload to see the vendor’s current status, then try again.",
      }));
      return;
    } finally {
      setPendingId(null);
      setArmed(null);
      pendingFocus.current = { kind: "primary", id: vendor.id };
    }
    if (!result.ok) {
      setRowErrors((prev) => ({ ...prev, [vendor.id]: result.error.message }));
      return;
    }
    router.refresh();
  }

  const activeCount = vendors.filter((v) => v.active).length;
  const retiredCount = vendors.length - activeCount;

  /**
   * `vendors` is a server-component prop, so closing the form does not by itself
   * re-read it — the row keeps rendering its pre-edit values until something
   * forces a refetch. Without this the write succeeds and the screen still shows
   * the old name, which reads as a save that silently failed; a manager's
   * reasonable next move is to type it again.
   *
   * VendorEditForm does call router.refresh(), but only on the branch where no
   * `onSuccess` prop was passed — and this component always passes one, so that
   * path is dead here. The refresh belongs with whoever owns the stale data,
   * which is this list.
   */
  function handleFormSuccess() {
    setShowForm(false);
    setEditingId(null);
    router.refresh();
  }

  function handleEditClick(vendorId: number) {
    setEditingId(vendorId);
    setShowForm(true);
  }

  return (
    <div className="mt-6">
      {vendors.length === 0 ? (
        <div className="max-w-prose space-y-4">
          <p className="text-row-subtitle text-muted-foreground">
            No vendors exist yet. Vendors group products on the reorder list — every item
            without a vendor assignment groups under <strong className="text-foreground">No vendor set</strong>.
          </p>
          <p className="text-row-subtitle text-muted-foreground">
            Create a vendor to set up a supplier, then assign products to it in the catalog.
          </p>

          {!showForm ? (
            <div className="pt-2">
              <Button
                onClick={() => {
                  setEditingId(null);
                  setShowForm(true);
                }}
                size="primary"
              >
                Create first vendor
              </Button>
            </div>
          ) : (
            <div className="rounded-md border border-border bg-card p-6">
              <VendorEditForm
                vendor={editingId ? vendors.find((v) => v.id === editingId) : undefined}
                onSuccess={handleFormSuccess}
              />
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                }}
                className="mt-4 text-caption text-muted-foreground underline hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-row-subtitle text-muted-foreground">
              {activeCount} active, {retiredCount} retired.
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
              {showForm ? "Cancel" : "Create vendor"}
            </Button>
          </div>

          {showForm && (
            <div className="rounded-md border border-border bg-card p-6">
              <VendorEditForm
                vendor={editingId ? vendors.find((v) => v.id === editingId) : undefined}
                onSuccess={handleFormSuccess}
              />
            </div>
          )}

          <div ref={tableRef}>
          <TableContainer>
            <Table className="min-w-[48rem]">
              <TableCaption>
                Vendors, {activeCount} active{retiredCount > 0 ? `, ${retiredCount} retired` : ""}
              </TableCaption>
              <TableHeader>
                <TableRow interactive={false}>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Order method</TableHead>
                  <TableHead>Lead time</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead numeric>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vendors.map((vendor) => {
                  const isArmed = armed?.id === vendor.id;
                  const busy = pendingId === vendor.id;
                  const muted = vendor.active ? "text-muted-foreground" : "text-muted-foreground/70";
                  return (
                    <Fragment key={vendor.id}>
                      <TableRow interactive={true} className="align-top">
                        <TableCell className="py-3">
                          <span
                            className={`block text-row-subtitle font-semibold ${
                              vendor.active ? "text-foreground" : "text-muted-foreground"
                            }`}
                          >
                            {vendor.name}
                          </span>
                        </TableCell>
                        <TableCell className="py-3">
                          {vendor.contact ? (
                            <span className={`text-row-subtitle ${muted}`}>{vendor.contact}</span>
                          ) : (
                            <NullValue reason="not-entered" />
                          )}
                        </TableCell>
                        <TableCell className="py-3">
                          {vendor.orderMethod ? (
                            <span className={`text-row-subtitle ${muted}`}>
                              {orderMethodLabel(vendor.orderMethod)}
                            </span>
                          ) : (
                            <NullValue reason="not-entered" />
                          )}
                        </TableCell>
                        <TableCell className="py-3">
                          {vendor.leadTimeDays != null ? (
                            <span className={`text-row-subtitle ${muted}`}>{vendor.leadTimeDays}d</span>
                          ) : (
                            <NullValue reason="not-entered" />
                          )}
                        </TableCell>
                        <TableCell className="py-3">
                          {vendor.active ? (
                            <span className="inline-flex items-center rounded-full bg-success-bg px-2.5 py-0.5 text-label uppercase font-semibold text-success">
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-negative-bg px-2.5 py-0.5 text-label uppercase font-semibold text-negative">
                              Retired
                            </span>
                          )}
                        </TableCell>
                        <TableCell numeric className="py-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            {vendor.active ? (
                              <Button
                                variant="outline"
                                size="tap"
                                aria-label={`Edit ${vendor.name}`}
                                onClick={() => handleEditClick(vendor.id)}
                              >
                                Edit
                              </Button>
                            ) : null}
                            {armed && isArmed ? (
                              <>
                                <Button
                                  variant="outline"
                                  size="tap"
                                  data-vendor-cancel={vendor.id}
                                  aria-label={`Cancel ${armed.kind === "retire" ? "retiring" : "reactivating"} ${vendor.name}`}
                                  onClick={() => cancelArm(vendor.id)}
                                  disabled={busy}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  variant={armed.kind === "retire" ? "destructive" : "primary"}
                                  size="tap"
                                  aria-label={`Confirm ${armed.kind === "retire" ? "retiring" : "reactivating"} ${vendor.name}`}
                                  aria-describedby={`vendor-warn-${vendor.id}`}
                                  onClick={() => confirmArm(vendor, armed.kind)}
                                  disabled={busy}
                                >
                                  {busy
                                    ? armed.kind === "retire"
                                      ? "Retiring…"
                                      : "Reactivating…"
                                    : armed.kind === "retire"
                                      ? "Confirm retire?"
                                      : "Confirm reactivate?"}
                                </Button>
                              </>
                            ) : (
                              <Button
                                variant="outline"
                                size="tap"
                                data-vendor-primary={vendor.id}
                                aria-label={`${vendor.active ? "Retire" : "Reactivate"} ${vendor.name}`}
                                onClick={() => arm(vendor.id, vendor.active ? "retire" : "reactivate")}
                              >
                                {vendor.active ? "Retire" : "Reactivate"}
                              </Button>
                            )}
                          </div>
                          {armed && isArmed ? (
                            <p
                              id={`vendor-warn-${vendor.id}`}
                              className="mt-2 text-right text-caption text-accent"
                            >
                              {armed.kind === "retire"
                                ? retireWarning(vendor.productCount)
                                : reactivateWarning(vendor.name, vendor.productCount)}
                            </p>
                          ) : null}
                        </TableCell>
                      </TableRow>
                      {rowErrors[vendor.id] ? (
                        <TableRow interactive={false}>
                          <TableCell colSpan={6} className="pb-3">
                            <p
                              className="rounded-md bg-negative-bg px-3 py-2 text-caption text-negative"
                              role="alert"
                            >
                              {rowErrors[vendor.id]}
                            </p>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
          </div>
        </div>
      )}
    </div>
  );
}
