import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { LoginForm } from "@/components/login-form";

export const metadata = { title: "Sign in · Handlebar" };

/**
 * Sign-in. Rendered dark: this is opened on the bar phone far more often than
 * at a desk, and a full-white login screen is the one moment the app would
 * flash a dim room before the counting UI takes over.
 *
 * There is no sign-up link and no "forgot password" flow, both deliberately.
 * `emailAndPassword.disableSignUp` is true in lib/auth.ts — accounts are
 * created only by scripts/create-user.ts, because no public endpoint should
 * be able to hand out a role (docs/open-items.md item 3).
 */
export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect(user.role === "staff" ? "/count" : "/office");
  }

  return (
    <div className="dark flex min-h-dvh flex-col items-center justify-center bg-background px-bar-pad text-foreground">
      <div className="w-full max-w-sm">
        <h1 className="text-header-title text-foreground">Handlebar</h1>
        <p className="mt-1 text-row-subtitle text-muted-foreground">
          Get a handle on your bar.
        </p>
        <LoginForm className="mt-section-gap" />
      </div>
    </div>
  );
}
