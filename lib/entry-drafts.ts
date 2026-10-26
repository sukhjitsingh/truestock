/**
 * Pure decisions behind the counting screens' "don't lose what I just typed"
 * guards. No React, no component imports — so each branch is unit-testable
 * (tests/entry-drafts.test.ts) without rendering anything.
 *
 * The failure all of these exist to prevent is silent: the entry screen mounts
 * the open-bottle editor and the sealed-quantity editor together, each with its
 * own Save, and a successful save from one used to unmount BOTH. Whatever was
 * typed into the other vanished with no error and nothing looking wrong — the
 * counter believes the bottles are recorded and the count comes out short.
 */

/**
 * Has the open-bottle editor got anything the next Save would not send?
 *
 * `draftValue` is a level the counter has picked but not yet added to the line.
 * `stagedChanged` is the other half — bottles already added to the staged list
 * (or edited/removed) that no Save has written. Both are unsaved work. The
 * second parameter is required on purpose: a caller that left it out would miss
 * the common case — Half → "+ Add bottle to line" clears the draft and leaves
 * ONLY a staged change.
 */
export function hasUnsavedFillDraft(draftValue: number | null, stagedChanged: boolean): boolean {
  return draftValue != null || stagedChanged;
}

/**
 * The level in the open-bottle editor that "+ Add bottle" / "Update bottle"
 * has not applied yet — or `null` if there is none.
 *
 * Tapping an existing bottle's chip loads ITS level into the editor so it can be
 * adjusted. That is not a draft until the counter moves it: the value equals the
 * staged one, and treating it as unsaved made a plain chip tap trigger the
 * discard prompt on Back with nothing to lose.
 */
export function pendingDraftValue(
  draftValue: number | null,
  activeIndex: number | null,
  fills: readonly number[],
): number | null {
  if (draftValue == null) return null;
  if (activeIndex != null && fills[activeIndex] === draftValue) return null;
  return draftValue;
}

/**
 * Has the sealed-quantity editor got typed input that no Save has written?
 *
 * ADD mode starts from zero, so any non-zero input is unsaved. SET mode starts
 * from the line's recorded numbers, so only a DIFFERENCE from them is — an
 * untouched SET editor reads, say, 12 and is not a draft at all.
 */
export function hasUnsavedQuantity(args: {
  mode: "add" | "set";
  cases: number;
  eaches: number;
  initialCases: number;
  initialEaches: number;
}): boolean {
  const { mode, cases, eaches, initialCases, initialEaches } = args;
  if (mode === "add") return cases !== 0 || eaches !== 0;
  return cases !== initialCases || eaches !== initialEaches;
}

/**
 * Where to go after one half of the entry screen SAVED successfully.
 *
 * `stay` when the other half holds unsaved input: leaving would unmount it and
 * discard it. Nothing is ever written on the other half's behalf — a draft the
 * counter hasn't confirmed is not a count.
 */
export function afterSave(args: { otherDirty: boolean }): "leave" | "stay" {
  return args.otherDirty ? "stay" : "leave";
}

/**
 * Is the entry screen a save was started on still the one on screen?
 *
 * A save is async and the counter is not locked out while it is in flight: they
 * can tap Back → Discard and scan a different product before it resolves. The
 * continuation then reads the NEW entry's dirty flags and either leaves that
 * entry (throwing away what was just typed there) or remounts one of its
 * editors. `session` is a counter bumped on every phase change; a save carries
 * the value it started under and does nothing on completion if it has moved.
 * The write itself still landed — only the screen bookkeeping is skipped.
 */
export function saveStillApplies(startedSession: number, currentSession: number): boolean {
  return startedSession === currentSession;
}

/**
 * Click-time guard for "Submit count".
 *
 * `pending` is the number of writes still sitting in the IndexedDB queue for
 * this count. Submitting freezes the count, after which the server refuses
 * every further write — and the leg DROPS a refused queued write rather than
 * retry it. So submitting with writes still queued turns bottles the counter
 * already tapped in into silently lost ones. Refuse, and say what to do.
 */
export function canSubmitCount(
  pending: number,
): { ok: true } | { ok: false; message: string } {
  if (pending <= 0) return { ok: true };
  const subject = pending === 1 ? "1 save hasn't" : `${pending} saves haven't`;
  return {
    ok: false,
    message:
      `${subject} synced yet. Tap Keep counting and wait for the sync indicator ` +
      "to clear, then submit.",
  };
}
