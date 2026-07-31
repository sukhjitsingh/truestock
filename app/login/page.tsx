import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { LoginForm } from "@/components/login-form";
import { PreflightOriginCheck } from "@/components/count/preflight-origin-check";

export const metadata = { title: "Sign in · Truestock" };

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
        <h1 className="text-header-title text-foreground">Truestock</h1>
        <p className="mt-1 text-row-subtitle text-muted-foreground">
          Counted, costed, and correct.
        </p>
        <LoginForm className="mt-section-gap" />
        {/*
          The origin check has to live HERE, not only on /count/preflight, or it
          cannot fire in the case it exists for.

          When DEV_LAN_ORIGIN is empty, client chunks 403 and nothing hydrates —
          so this form is inert and no one can sign in. /count/preflight is
          behind requireUser, so an unauthenticated device bounces 307 to /login
          and never reaches the row explaining why. The diagnosis was gated
          behind the very login the failure prevents; confirmed by a curl that
          redirected instead of rendering it.

          Server-rendered, so it survives the no-JavaScript state that is the
          whole point. Returns null outside development, so this adds no
          production surface and leaks nothing on a public page.
        */}
        <div className="mt-section-gap">
          <PreflightOriginCheck />
        </div>
      </div>
    </div>
  );
}
