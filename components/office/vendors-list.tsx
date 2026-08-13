"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { VendorSummary } from "@/lib/domain/catalog";
import { Button } from "@/components/ui/button";
import { VendorEditForm } from "./vendor-edit-form";

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
          <div>
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

          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 text-label uppercase text-muted-foreground">
                    Vendor
                  </th>
                  <th scope="col" className="py-2 text-label uppercase text-muted-foreground">
                    Contact
                  </th>
                  <th scope="col" className="py-2 text-label uppercase text-muted-foreground">
                    Order method
                  </th>
                  <th scope="col" className="py-2 text-label uppercase text-muted-foreground">
                    Lead time
                  </th>
                  <th scope="col" className="py-2 text-right text-label uppercase text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((vendor) => (
                  <tr key={vendor.id} className="border-b border-border align-top">
                    <td className="py-3">
                      <span className="block text-row-subtitle font-semibold text-foreground">
                        {vendor.name}
                      </span>
                    </td>
                    <td className="py-3 text-row-subtitle text-muted-foreground">
                      {vendor.contact || "—"}
                    </td>
                    <td className="py-3 text-row-subtitle text-muted-foreground">
                      {vendor.orderMethod || "—"}
                    </td>
                    <td className="py-3 text-row-subtitle text-muted-foreground">
                      {vendor.leadTimeDays != null ? `${vendor.leadTimeDays}d` : "—"}
                    </td>
                    <td className="py-3 text-right">
                      <Button variant="outline" size="tap" onClick={() => handleEditClick(vendor.id)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
