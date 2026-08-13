import Link from "next/link";
import { requireOfficeUser } from "@/lib/current-user";
import { OfficeNav } from "@/components/office/office-nav";
import { AccountMenu } from "@/components/office/account-menu";

/**
 * The back office: desk use, full daylight, and therefore LIGHT — no `.dark`
 * class anywhere in this tree (docs/design-system.md §1). Nothing here forks
 * a component per theme; the token set does all of it.
 *
 * Staff never reach this layout — `requireOfficeUser` sends them to the
 * counting app rather than showing a permission error for a surface they
 * will never have (spec §4: staff is count-only).
 */
export default async function OfficeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireOfficeUser();

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 overflow-x-auto px-4 py-4 sm:px-6">
          <Link href="/office" className="shrink-0 text-row-title text-foreground">
            Truestock
          </Link>
          <OfficeNav role={user.role} />
          <AccountMenu name={user.name} email={user.email} role={user.role} />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
