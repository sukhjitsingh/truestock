"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  actionListUsers,
  actionSetUserActive,
  actionSetUserRole,
} from "@/app/actions/users";
import type { UserSummary } from "@/lib/domain/users";
import { Button } from "@/components/ui/button";

export function UsersList() {
  const router = useRouter();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const showFeedback = (kind: "ok" | "err", msg: string) => {
    setFeedback({ kind, msg });
    setTimeout(() => setFeedback(null), 3500);
  };

  const loadUsers = async () => {
    try {
      const result = await actionListUsers();
      if (result.ok) {
        setUsers(result.data);
      } else {
        showFeedback("err", result.error.message || "Failed to load users");
      }
    } catch {
      showFeedback("err", "An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRoleChange = async (userId: number, role: string) => {
    const result = await actionSetUserRole({ userId, role: role as "owner" | "manager" | "staff" });
    if (result.ok) {
      showFeedback("ok", "Role updated");
      router.refresh();
      await loadUsers();
    } else {
      showFeedback("err", result.error.message || "Failed to update role");
    }
  };

  const handleActiveChange = async (userId: number, active: boolean) => {
    const result = await actionSetUserActive({ userId, active });
    if (result.ok) {
      showFeedback("ok", active ? "User activated" : "User deactivated");
      router.refresh();
      await loadUsers();
    } else {
      showFeedback("err", result.error.message || "Failed to update status");
    }
  };

  if (isLoading) {
    return <div className="p-4 text-center text-muted-foreground">Loading users…</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {feedback && (
        <div
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
              users.map((u) => (
                <tr key={u.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{u.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                  <td className="px-4 py-3">
                    <select
                      className="rounded border border-input bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      defaultValue={u.role}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                    >
                      <option value="owner">Owner</option>
                      <option value="manager">Manager</option>
                      <option value="staff">Staff</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={u.active}
                        onChange={(e) => handleActiveChange(u.id, e.target.checked)}
                      />
                      <span className={`text-xs ${u.active ? "text-green-400" : "text-muted-foreground"}`}>
                        {u.active ? "Active" : "Inactive"}
                      </span>
                    </label>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
