"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { 
  actionListUsers, 
  actionSetUserActive, 
  actionSetUserRole 
} from "@/app/actions/users";
import { UserSummary } from "@/lib/domain/users";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

export function UsersList() {
  const router = useRouter();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadUsers = async () => {
    try {
      const result = await actionListUsers();
      if (result.ok) {
        setUsers(result.data);
      } else {
        toast.error(result.error?.message || "Failed to load users");
      }
    } catch (e) {
      toast.error("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleRoleChange = async (userId: number, role: string) => {
    const result = await actionSetUserRole({ userId, role: role as any });
    if (result.ok) {
      toast.success("Role updated");
      router.refresh();
      await loadUsers();
    } else {
      toast.error(result.error?.message || "Failed to update role");
    }
  };

  const handleActiveChange = async (userId: number, active: boolean) => {
    const result = await actionSetUserActive({ userId, active });
    if (result.ok) {
      toast.success(active ? "User activated" : "User deactivated");
      router.refresh();
      await loadUsers();
    } else {
      toast.error(result.error?.message || "Failed to update status");
    }
  };

  if (isLoading) return <div className="p-4 text-center">Loading users...</div>;

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="h-24 text-center">
                No users found.
              </TableCell>
            </TableRow>
          ) : (
            users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.name}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  <Select 
                    defaultValue={user.role} 
                    onValueChange={(val: string) => handleRoleChange(user.id, val)}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="owner">Owner</SelectItem>
                      <SelectItem value="manager">Manager</SelectItem>
                      <SelectItem value="staff">Staff</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Switch 
                      checked={user.active} 
                      onCheckedChange={(val: boolean) => handleActiveChange(user.id, val)} 
                    />
                    <span className="text-xs text-muted-foreground">
                      {user.active ? "Active" : "Inactive"}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
