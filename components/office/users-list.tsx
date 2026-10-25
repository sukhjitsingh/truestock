"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { actionSetUserActive, actionSetUserRole } from "@/app/actions/users";
import type { UserSummary } from "@/lib/domain/users";
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
import { StatusPill } from "@/components/ui/status-pill";

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
    <div className="flex flex-col gap-4">
      {feedback && (
        <div
          role={feedback.kind === "ok" ? "status" : "alert"}
          className={`rounded-md px-4 py-2.5 text-caption font-medium ${
            feedback.kind === "ok"
              ? "bg-success-bg text-success"
              : "bg-negative-bg text-negative"
          }`}
        >
          {feedback.msg}
        </div>
      )}

      <TableContainer>
        <Table className="min-w-[40rem]">
          <TableCaption>
            Users, {users.length} {users.length === 1 ? "user" : "users"}
          </TableCaption>
          <TableHeader>
            <TableRow interactive={false}>
              <TableHead>User & Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead numeric>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <TableRow interactive={false}>
                <TableCell colSpan={4} className="py-section-gap text-center text-row-subtitle text-muted-foreground">
                  No users found.
                </TableCell>
              </TableRow>
            ) : (
              users.map((u) => {
                const busy = busyId === u.id || isPending;
                return (
                  <TableRow key={u.id} interactive={true}>
                    <TableCell className="py-3.5">
                      <div className="font-semibold text-foreground">{u.name}</div>
                      <div className="text-caption text-muted-foreground">{u.email}</div>
                    </TableCell>
                    <TableCell className="py-3.5">
                      <select
                        aria-label={`Role for ${u.name}`}
                        className="min-h-tap-min rounded-lg border border-border/80 bg-background px-3 py-1.5 text-caption font-semibold uppercase text-foreground transition-all hover:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
                        value={u.role}
                        disabled={busy}
                        onChange={(e) => handleRoleChange(u.id, e.target.value)}
                      >
                        <option value="owner">Owner</option>
                        <option value="manager">Manager</option>
                        <option value="staff">Staff</option>
                      </select>
                    </TableCell>
                    <TableCell className="py-3.5">
                      <StatusPill tone={u.active ? "success" : "negative"}>
                        {u.active ? "Active" : "Inactive"}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="py-3.5 text-right">
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`${u.active ? "Deactivate" : "Activate"} ${u.name}`}
                        onClick={() => handleActiveChange(u.id, !u.active)}
                        className={`inline-flex min-h-tap-min items-center rounded-lg border px-3 py-1.5 text-caption font-semibold uppercase transition-all active:scale-95 disabled:opacity-50 ${
                          u.active
                            ? "border-destructive/30 text-destructive hover:bg-destructive/10"
                            : "border-success/30 text-success hover:bg-success/10"
                        }`}
                      >
                        {u.active ? "Deactivate" : "Activate"}
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </div>
  );
}
