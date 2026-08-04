"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { actionSetUserActive, actionSetUserRole } from "@/app/actions/users";
import type { UserSummary } from "@/lib/domain/users";

/**
 * User management table — role select and active toggle per row.
 *
 * `users` arrives as a server-component prop rather than being fetched in an
 * effect, matching VendorsList and every other office screen. This is not only
 * convention: fetching in `useEffect` and calling `setState` in it is the
 * cascading-render pattern the lint rule rejects, and it also renders an empty
 * table on first paint before the list arrives.
 *
 * After a write, `router.refresh()` re-runs the server component so the row
 * shows the value the database actually holds. The optimistic local state is
 * deliberately NOT kept — a role change that the server refuses (last-owner
 * lockout) must snap back to the real value rather than leave the select
 * showing a role the user does not have. That is the same silent-wrong-value
 * failure class CLAUDE.md warns about, applied to authorization instead of
 * counts.
 *
 * Controls are disabled during the write so a double-click cannot fire two
 * conflicting role changes at the same row.
 */
export function UsersList({ users }: { users: UserSummary[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );

  const run = async (userId: number, fn: () => Promise<{ ok: boolean; error?: { message: string } }>, okMsg: string) => {
    setBusyId(userId);
    const result = await fn();
    setBusyId(null);

    if (result.ok) {
      setFeedback({ kind: "ok", msg: okMsg });
    } else {
      setFeedback({
        kind: "err",
        msg: result.error?.message ?? "The change was not saved",
      });
    }
    // Refresh either way: on success to show the new value, on failure to snap
    // the control back to the value the database still holds.
    startTransition(() => router.refresh());
  };

  const handleRoleChange = (userId: number, role: string) =>
    run(
      userId,
      () =>
        actionSetUserRole({
          userId,
          role: role as "owner" | "manager" | "staff",
        }),
      "Role updated",
    );

  const handleActiveChange = (userId: number, active: boolean) =>
    run(
      userId,
      () => actionSetUserActive({ userId, active }),
      active ? "User activated" : "User deactivated",
    );

  return (
    <div className="flex flex-col gap-3">
      {feedback && (
        <div
          role="status"
          className={`rounded-md px-4 py-2 text-sm ${
            feedback.kind === "ok"
              ? "bg-green-900/30 text-green-300"
              : "bg-destructive/20 text-destructive-foreground"
          }`}
        >
          {feedback.msg}
        </div>
      )}

      <div className="rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={4} className="h-24 text-center text-muted-foreground">
                  No users found.
                </td>
              </tr>
            ) : (
              users.map((u) => {
                const busy = busyId === u.id || isPending;
                return (
                  <tr
                    key={u.id}
                    className="border-b border-border last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-4 py-3 font-medium">{u.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                    <td className="px-4 py-3">
                      <select
                        aria-label={`Role for ${u.name}`}
                        className="min-h-11 rounded border border-input bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                        value={u.role}
                        disabled={busy}
                        onChange={(e) => handleRoleChange(u.id, e.target.value)}
                      >
                        <option value="owner">Owner</option>
                        <option value="manager">Manager</option>
                        <option value="staff">Staff</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <label className="flex min-h-11 cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Active for ${u.name}`}
                          className="h-5 w-5 accent-primary"
                          checked={u.active}
                          disabled={busy}
                          onChange={(e) => handleActiveChange(u.id, e.target.checked)}
                        />
                        <span
                          className={`text-xs ${
                            u.active ? "text-green-400" : "text-muted-foreground"
                          }`}
                        >
                          {u.active ? "Active" : "Inactive"}
                        </span>
                      </label>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
