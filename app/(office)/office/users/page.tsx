import { requireRole } from "@/lib/authz";
import { UsersList } from "@/components/office/users-list";

export default async function UsersPage() {
  await requireRole("owner");

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Users</h1>
        <p className="text-muted-foreground text-sm">
          Manage organization access and roles. Accounts are created via the
          CLI using{" "}
          <code className="bg-muted rounded px-1">bun run create-user</code>.
        </p>
      </div>
      <UsersList />
    </div>
  );
}
