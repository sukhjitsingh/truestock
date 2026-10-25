import { requireRole } from "@/lib/authz";
import { actionListUsers } from "@/app/actions/users";
import { PageHeader } from "@/components/office/page-header";
import { UsersList } from "@/components/office/users-list";

export const metadata = { title: "Users · Truestock" };

/**
 * User management screen (Phase 1.5, open item #3).
 *
 * Owner-only. `requireRole("owner")` runs here as well as inside every action
 * the table calls — invariant 7 says authorization is checked in each server
 * action, not only at the edge, so this page guard is the outer layer rather
 * than the only one.
 *
 * The list is read on the server and passed down, so the table renders with
 * real rows on first paint and `router.refresh()` is enough to show a write.
 *
 * Account creation stays on the CLI on purpose: there is no signup, no email
 * verification and no password-reset path in the MVP, so a create form here
 * would need to invent a way to set the first password. Deactivation, not
 * deletion, is the removal mechanism (invariant 6's spirit — sessions and
 * counts reference the user).
 */
export default async function UsersPage() {
  await requireRole("owner");

  const result = await actionListUsers();
  const users = result.ok ? result.data : [];

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle={
          <p className="text-row-subtitle text-muted-foreground">
            Manage organization access and roles. Accounts are created from the command line with{" "}
            <code className="rounded bg-muted px-1">bun run create-user</code>. Removing someone is a
            deactivation, which also ends their open sessions.
          </p>
        }
      />

      {!result.ok ? (
        <p className="mt-6 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {result.error.message}
        </p>
      ) : (
        <div className="mt-6">
          <UsersList users={users} />
        </div>
      )}
    </div>
  );
}
