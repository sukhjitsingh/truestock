"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function SignOutInner() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <Button
      variant="ghost"
      size="primary"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await signOut();
        router.replace("/login");
        router.refresh();
      }}
    >
      {pending ? "Signing out..." : "Sign out"}
    </Button>
  );
}

export function SignOutButton() {
  return <SignOutInner />;
}
