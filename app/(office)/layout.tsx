import { requireOfficeUser } from "@/lib/current-user";
import { OfficeRail } from "@/components/office/office-rail";
import { OfficeBreadcrumb } from "@/components/office/office-breadcrumb";
import { AccountMenu } from "@/components/office/account-menu";

/**
 * The back office: desk use, full daylight, and therefore LIGHT — no `.dark`
 * class anywhere in this tree (docs/design-system.md §1). Nothing here forks
 * a component per theme; the token set does all of it.
 *
 * Staff never reach this layout — `requireOfficeUser` sends them to the
 * counting app rather than showing a permission error for a surface they
 * will never have (spec §4: staff is count-only).
 *
 * ## Shape: icon rail + top bar, not a top nav
 *
 * `prototypes/office-catalog.html` and `ui-spec-web.md` §2 both specify the
 * Part B shell as `app-shell → rail + main → topbar + content`. The first
 * Phase 2 pass shipped the navigation horizontally in the header instead,
 * which is the layout this replaces. Navigation is the rail; the top bar
 * carries the breadcrumb and the account control and nothing else.
 *
 * **What is deliberately absent from the top bar**: the prototype's global
 * search, notification bell (with its decorative unread dot) and messages
 * icon. §2 is explicit that these are present on every office screen or on
 * none — "never present on one screen and silently absent on four" — and
 * that notification controls ship "only if they are functional". There is no
 * search index, no notifications system and no messaging in Truestock, so all
 * three are omitted everywhere. That also keeps `ui-audit.md` P0.7 satisfied:
 * nothing in this shell announces as interactive without doing something.
 * Restore them together, when there is something behind them.
 *
 * The rail is one component in one layout rather than a per-screen assembly —
 * the same reason `PageHeader` is shared, and the mechanism that stops the
 * shell losing controls from screen to screen (P2.3, P2.8).
 */
export default async function OfficeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireOfficeUser();

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <OfficeRail role={user.role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-15 shrink-0 items-center gap-4 border-b border-border bg-card px-4 sm:px-6">
          <OfficeBreadcrumb />
          <div className="ml-auto">
            <AccountMenu name={user.name} email={user.email} role={user.role} />
          </div>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
