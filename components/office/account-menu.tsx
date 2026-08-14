"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";

/**
 * The account control — docs/plans/phase-2-ui-redesign/ui-spec-web.md §5.
 *
 * Replaces the plain `<div>{user.name} · {user.role}</div>` that shipped in
 * `app/(office)/layout.tsx`: not focusable, not a button, and carried no
 * sign-out affordance on the office surface at all. A real `<button
 * aria-label="Account menu">` opening a `role="menu"` popover with name,
 * email, role, and sign-out — the same information `/count/account` already
 * surfaces on the mobile surface (parity, not a new decision).
 *
 * Sized to `size-tap-min` (44px) — the persistent identity/nav floor, not
 * the surrounding table's 32–36px dense-row allowance (§10). Initials render
 * in `bg-muted text-foreground`, the one neutral treatment — no per-user hue
 * coding (§7).
 *
 * No shadow — a hairline border plus `--popover`/`--popover-foreground`
 * tokens for depth, per the no-shadow elevation policy (design-system.md §5).
 *
 * Sign-out logic mirrors `components/count/sign-out-button.tsx` exactly:
 * `signOut()`, then `router.replace("/login")` + `router.refresh()`.
 */
export function AccountMenu({
  name,
  email,
  role,
}: {
  name: string;
  email: string;
  role: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?";

  // Move focus into the menu on open (design-system.md §9: a popover "moves focus
  // in on open and restores it to the trigger on close"). Without this a keyboard
  // user opens the menu and their focus is still on the trigger behind it, so the
  // next Tab walks past the menu entirely into the page.
  useEffect(() => {
    if (open) firstItemRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        // Only pull focus back to the trigger if it was inside the menu we are
        // closing. Restoring unconditionally would yank focus off whatever the
        // user just clicked outside, which is worse than not restoring at all.
        const focusWasInside =
          containerRef.current.contains(document.activeElement);
        setOpen(false);
        if (focusWasInside) triggerRef.current?.focus();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  async function handleSignOut() {
    setPending(true);
    await signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Account menu — signed in as ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex size-tap-min items-center justify-center rounded-full bg-muted text-label text-foreground"
      >
        {initials}
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-20 w-56 rounded-md border border-border bg-popover p-3 text-popover-foreground"
        >
          <p className="text-row-subtitle font-semibold text-popover-foreground">{name}</p>
          <p className="mt-0.5 truncate text-caption text-muted-foreground" title={email}>
            {email}
          </p>
          <p className="mt-0.5 text-caption capitalize text-muted-foreground">{role}</p>
          <button
            ref={firstItemRef}
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={handleSignOut}
            className="mt-3 flex min-h-tap-min w-full items-center justify-center rounded-md border border-input text-label uppercase text-foreground disabled:opacity-50"
          >
            {pending ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
