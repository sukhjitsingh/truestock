import { requireUser } from "@/lib/current-user";
import { SignOutButton } from "@/components/count/sign-out-button";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Account · Truestock" };

export default async function AccountPage() {
  const user = await requireUser();

  return (
    <div className="px-bar-pad pb-8 pt-6">
      <h1 className="text-header-title text-foreground">Account</h1>

      <Card className="mt-section-gap">
        <p className="text-row-title text-card-foreground">{user.name}</p>
        <p className="text-row-subtitle text-muted-foreground">{user.email}</p>
        <p className="mt-2 text-label uppercase text-muted-foreground">{user.role}</p>
      </Card>

      {/*
        Sessions are 12h absolute and never refresh (lib/auth.ts), so this
        phone signs itself out roughly once a shift whether or not anyone taps
        this. Signing out matters anyway: the phone is shared and handed
        between bartenders, and every count line records who counted it.
      */}
      <div className="mt-section-gap">
        <SignOutButton />
      </div>

      <p className="mt-4 text-caption text-muted-foreground">
        Roles and accounts are managed by the owner. There is no self-signup.
      </p>
    </div>
  );
}
