/**
 * Lets a counting screen ask the bottom tab bar to get out of the way.
 *
 * The tab bar lives in the (count) layout; the entry and enroll screens are
 * PHASES of `CountLeg` — component state, not routes — so the two cannot talk
 * through props or the URL. This is a tiny client-side store the tab bar
 * subscribes to (`useSyncExternalStore`) and the leg writes to.
 *
 * Why the bar must go during entry: its tabs are plain links, so they bypass the
 * leg's "Discard unsaved entry?" guard. With an open-bottle level or a quantity
 * on screen, one stray thumb tap on Catalog or Account threw it away with no
 * prompt (phone test 2026-10-25, A18). Hiding the bar removes the route; the
 * in-screen Back goes through the guard. It also hands back the height — on a
 * phone the entry screen was mostly chrome.
 *
 * Reference-counted rather than a boolean: a screen that remounts can register
 * its new request before the old one is released, and a boolean would then let
 * the bar reappear mid-entry.
 */
let hiders = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeTabBarHidden(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isTabBarHidden(): boolean {
  return hiders > 0;
}

/**
 * Ask for the tab bar to be hidden. Returns the release function; calling it
 * more than once is harmless, so a double cleanup can't underflow the count and
 * leave the bar permanently suppressed.
 */
export function hideTabBar(): () => void {
  hiders += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hiders -= 1;
    emit();
  };
}
