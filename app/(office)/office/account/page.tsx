import { requireOfficeUser } from "@/lib/current-user";

export default async function AccountPage() {
  const user = await requireOfficeUser();

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-row-title">Your Profile</h1>
        <p className="text-caption text-muted-foreground">Read-only account information</p>
      </div>

      <div className="grid gap-4 rounded-lg border border-border p-6 bg-card">
        <div className="grid gap-1">
          <label className="text-xs font-medium text-muted-foreground uppercase">Full Name</label>
          <div className="text-sm font-medium">{user.name}</div>
        </div>
        <div className="grid gap-1">
          <label className="text-xs font-medium text-muted-foreground uppercase">Email Address</label>
          <div className="text-sm font-medium">{user.email}</div>
        </div>
        <div className="grid gap-1">
          <label className="text-xs font-medium text-muted-foreground uppercase">Role</label>
          <div className="text-sm font-medium uppercase">{user.role}</div>
        </div>
        <div className="grid gap-1">
          <label className="text-xs font-medium text-muted-foreground uppercase">Organization</label>
          <div className="text-sm font-medium">{user.organizationName}</div>
        </div>
      </div>
    </div>
  );
}
