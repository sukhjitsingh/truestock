import { requireRole } from "@/lib/authz";
import { listUsers } from "@/lib/domain/users";
import { UserManagementTable } from "@/components/office/user-management-table";

export default async function UsersPage() {
  // Invariant 7: auth checked in the route handler, not only middleware.
  // Owner-only surface (spec §4).
  const actor = await requireRole("owner");

  const users = await listUsers(actor);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-row-title">User Management</h1>
          <p className="text-caption text-muted-foreground">
            Manage staff access and roles for your organization
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <UserManagementTable initialUsers={users} currentUserId={actor.userId} />
      </div>
    </div>
  );
}
