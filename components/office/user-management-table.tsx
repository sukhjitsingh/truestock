"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { updateUserRoleAction, setUserActiveAction } from "@/app/actions/users";
import type { ManagedUser } from "@/lib/domain/users";
import type { Role } from "@/lib/authz";

const ROLES: Role[] = ["owner", "manager", "staff"];

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function UserManagementTable({
  initialUsers,
  currentUserId,
}: {
  initialUsers: ManagedUser[];
  currentUserId: number;
}) {
  const [users, setUsers] = useState<ManagedUser[]>(initialUsers);
  const [loadingUsers, setLoadingUsers] = useState<Set<number>>(new Set());
  const router = useRouter();

  const isLoading = (userId: number) => loadingUsers.has(userId);

  function withLoading(userId: number, on: boolean) {
    setLoadingUsers((prev) => {
      const next = new Set(prev);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  async function handleRoleChange(userId: number, newRole: Role) {
    withLoading(userId, true);
    try {
      const result = await updateUserRoleAction({ userId, role: newRole });
      if (result.ok) {
        setUsers((prev) => prev.map((u) => (u.id === userId ? result.data : u)));
        toast.success(`Role updated to ${newRole}.`);
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    } finally {
      withLoading(userId, false);
    }
  }

  async function handleToggleActive(userId: number, nextActive: boolean) {
    withLoading(userId, true);
    try {
      const result = await setUserActiveAction({ userId, active: nextActive });
      if (result.ok) {
        setUsers((prev) => prev.map((u) => (u.id === userId ? result.data : u)));
        toast.success(nextActive ? "User activated." : "User deactivated and signed out.");
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    } finally {
      withLoading(userId, false);
    }
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => {
          const isSelf = user.id === currentUserId;
          const busy = isLoading(user.id);
          return (
            <TableRow key={user.id}>
              <TableCell className="font-medium">{user.name}</TableCell>
              <TableCell className="text-muted-foreground">{user.email}</TableCell>
              <TableCell>
                <Badge variant="outline">{user.role.toUpperCase()}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant={user.active ? "default" : "secondary"}>
                  {user.active ? "Active" : "Inactive"}
                </Badge>
              </TableCell>
              <TableCell className="text-right space-x-2">
                {/* Change role */}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="tap" disabled={busy}>
                      {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Change Role
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Change role for {user.name}</AlertDialogTitle>
                      <AlertDialogDescription>
                        Role changes take effect on {user.name}&apos;s next request. Pick the
                        new role below.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="flex gap-2 py-4">
                      {ROLES.map((role) => (
                        <Button
                          key={role}
                          variant={user.role === role ? "primary" : "outline"}
                          size="tap"
                          disabled={busy || user.role === role}
                          onClick={() => handleRoleChange(user.id, role)}
                        >
                          {titleCase(role)}
                        </Button>
                      ))}
                    </div>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Close</AlertDialogCancel>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                {/* Activate / deactivate. Owners cannot deactivate themselves —
                    the domain layer rejects it, and the UI hides it so the
                    control is never offered in the first place. */}
                {user.active ? (
                  isSelf ? null : (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="tap"
                          className="text-destructive hover:text-destructive"
                          disabled={busy}
                        >
                          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                          Deactivate
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Deactivate {user.name}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This immediately revokes all of {user.name}&apos;s active sessions
                            and blocks sign-in. Their history is preserved and they can be
                            reactivated later.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => handleToggleActive(user.id, false)}
                          >
                            Deactivate
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )
                ) : (
                  <Button
                    variant="ghost"
                    size="tap"
                    disabled={busy}
                    onClick={() => handleToggleActive(user.id, true)}
                  >
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Activate
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
