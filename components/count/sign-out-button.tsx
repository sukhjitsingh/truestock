"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { signOut } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

/**
 * Mobile Shift Sign-Out Trigger (`SignOutButton`, Target 12)
 *
 * Atomically revokes Better Auth sessions (Invariant 11) and redirects to /login.
 */
export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <Button
      variant="destructive"
      size="primary"
      full
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await signOut();
        router.replace("/login");
        router.refresh();
      }}
      className="text-label uppercase font-bold"
    >
      <LogOut className="mr-2 size-4" aria-hidden="true" />
      {pending ? "Signing out…" : "Sign out of shift"}
    </Button>
  );
}

