"use client";

import { useState } from "react";
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
    <form onSubmit={onSubmit} className={className} noValidate>
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
        <Button type="submit" size="primary" full disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </div>
    </form>
  );
}
