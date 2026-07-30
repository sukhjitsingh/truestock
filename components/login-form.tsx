"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

export function LoginForm({ className }: { className?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Sign-in is a client-side call to Better Auth, so this form genuinely
  // cannot work before React attaches. Tracking that explicitly lets the
  // submit stay inert until it can do the right thing — see the `method`
  // comment on the <form> for the failure this prevents.
  const [hydrated, setHydrated] = useState(false);
  // The has-hydrated idiom, and the one thing the rule cannot see: whether
  // React has attached is not derivable during render — on the server and on
  // the first client pass it is false by definition, and the *only* signal
  // that it became true is the effect running. Rewriting this to satisfy the
  // rule would mean inventing a different hydration signal, and the failure
  // it guards is the credential leak recorded in CLAUDE.md. Same carve-out,
  // and same reason, as count-leg.tsx's flush-on-mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setHydrated(true), []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const { error: signInError } = await signIn.email({ email, password });

    if (signInError) {
      // Better Auth returns a deliberately generic failure for both "no such
      // account" and "account is deactivated" (lib/auth.ts's session hook
      // returns false, which surfaces as FAILED_TO_CREATE_SESSION). Keep it
      // generic here too — telling someone their account exists but is
      // disabled is an account-enumeration answer.
      setError("Sign-in failed. Check your email and password.");
      setPending(false);
      return;
    }

    // The server decides where to land, based on the role it reads from the
    // database — not on anything this component knows. `refresh()` lets the
    // root redirect in app/page.tsx run with the new session cookie.
    router.replace("/");
    router.refresh();
  }

  return (
    /*
      `method="post"` is a safety net, not a working submit path. `onSubmit`
      calls preventDefault(), so this method is only ever reached if React
      has not attached — and then the browser submits natively. A form with
      no method defaults to **GET**, which serializes every field into the
      query string: the typed password lands in the server access log, the
      user's history, and the Referer of any later outbound link. That is not
      hypothetical — a CSP that blocked Next's inline scripts stopped this
      page hydrating entirely, and the dev password ended up in the container
      log exactly this way (docs/session-handoff.md). POST degrades to a bare
      405 instead, which leaks nothing.

      The disabled-until-hydrated submit below closes the same hole from the
      other side, so the native path is not normally reachable at all. Both
      are kept: the flag handles the ordinary race, the method handles
      hydration failing outright, which is the case that actually happened.
    */
    <form onSubmit={onSubmit} method="post" className={className} noValidate>
      <div className="flex flex-col gap-4">
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field label="Password" htmlFor="password" error={error ?? undefined}>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {/*
          No "remember me". Better Auth's rememberMe flag does not extend the
          12h absolute session — passing false actually swaps in a *different*
          1-day session, undermining the policy (see lib/auth.ts's session
          comment). This phone is shared across shifts and left on the bar.
        */}
        <Button type="submit" size="primary" full disabled={pending || !hydrated}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </div>
    </form>
  );
}
