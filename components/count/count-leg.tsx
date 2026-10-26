"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, MapPin, ScanLine, Search, CloudOff, Check, Zap } from "lucide-react";
import {
  scanCountLineAction,
  incrementCountLineAction,
  setCountLineQuantitiesAction,
  editCountLineFillsAction,
} from "@/app/actions/counts";
import { resolveBarcodeAction, searchProductsAction } from "@/app/actions/catalog";
import type { LocationSummary, ProductSummary } from "@/lib/domain/catalog";
import type { CountLineDetail } from "@/lib/domain/counts";
import {
  newWriteId,
  enqueue,
  dequeue,
  markAttempt,
  pendingFor,
  type QueuedWrite,
  type QueuedWriteKind,
} from "@/lib/count-queue";
import { cn, formatUnits } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CardStack } from "@/components/ui/card";
import { CountLineCard, type CountLineCardData } from "@/components/count/count-line-card";
import { BarcodeScanner } from "@/components/count/barcode-scanner";
import { QuantityEntry, type QuantitySubmission } from "@/components/count/quantity-entry";
import { FillEntry } from "@/components/count/fill-entry";
import { planFillSave } from "@/lib/fill-save";
import { afterSave, saveStillApplies } from "@/lib/entry-drafts";
import { EnrollForm } from "@/components/count/enroll-form";
import { LocationPicker } from "@/components/count/location-picker";
import { StrayBottleModal } from "@/components/count/stray-bottle-modal";
import { useHideTabBar } from "@/components/count/tab-bar";

interface LocalLine extends CountLineCardData {
  lineId: number | null;
  productId: number;
  locationId: number;
  /** Set briefly after a rescan lands on an existing line. */
  note?: string;
}

type Phase =
  | { kind: "pick-location" }
  | { kind: "counting" }
  | { kind: "entry"; product: ProductSummary; locationId: number; isStray: boolean }
  | { kind: "enroll"; barcode: string };

/** Which half of the entry screen just saved while the other half still holds unsaved input. */
type EntryNotice = "fill-saved" | "qty-saved" | null;
/** Where the "Discard unsaved entry?" row is shown — next to the control that was tapped. */
type DiscardPrompt = "top" | "fill" | "qty" | null;

interface RapidEvent {
  key: string;
  ok: boolean;
  title: string;
  detail: string;
}

const RAPID_LOG_LIMIT = 4;

const OFFLINE_LOOKUP_MESSAGE =
  "Offline — couldn't look that up, and nothing was recorded for it. " +
  "Readings you already entered are saved and will sync when you are back in range. " +
  "Move back into WiFi range and scan that one again.";

function lineKey(productId: number, locationId: number) {
  return `${productId}:${locationId}`;
}

function writeLabel(product: ProductSummary, location: LocationSummary) {
  return `${product.name} · ${location.name}`;
}

/**
 * Mobile Floor Counting Leg Coordinator (spec §5, prototypes/count-scan.html)
 *
 * Enforces:
 * 1. Locked Location Leg Flow (station chosen once per leg, locked loc-pill).
 * 2. Stray Bottle Modal escape hatch.
 * 3. 56px primary tap targets on all counting controls.
 * 4. Paired search and barcode scan at the bottom of the screen.
 * 5. Invariant 3 rescan pulse and aria-live="polite" screen reader announcements.
 * 6. Offline write queue with optimistic updates and UUID idempotency.
 */
export function CountLeg({
  countId,
  locations,
  initialLines,
  canSeeCost,
  initialLocationId = null,
}: {
  countId: number;
  locations: LocationSummary[];
  initialLines: CountLineDetail[];
  canSeeCost: boolean;
  /**
   * Deep link from a count line's Edit arrow: start already inside that leg, as
   * if it had been picked. The scan page validates it against the active
   * locations; it is re-checked here so a bad value can only ever mean the
   * picker, never a leg on a location this screen doesn't hold.
   */
  initialLocationId?: number | null;
}) {
  const startLocationId =
    initialLocationId != null && locations.some((l) => l.id === initialLocationId)
      ? initialLocationId
      : null;
  const [phase, setPhaseRaw] = useState<Phase>(() =>
    startLocationId != null ? { kind: "counting" } : { kind: "pick-location" },
  );
  const [activeLocationId, setActiveLocationId] = useState<number | null>(startLocationId);

  // The bottom tab bar's links bypass requestLeave's discard guard, so with an
  // entry or enroll draft on screen one stray tap on Catalog or Account threw it
  // away silently. Entry and enroll leave through their own Back/Cancel, which
  // do go through the guard; picking and counting have no draft and keep the bar.
  useHideTabBar(phase.kind === "entry" || phase.kind === "enroll");

  // Unsaved-input tracking for the entry screen. Refs, not state: nothing
  // renders from them, and the save continuations below must read the value AT
  // THE MOMENT THE SAVE RESOLVES — a closure would hold whatever it was at the
  // tap, and the other editor is not locked while a save is in flight.
  const fillDirtyRef = useRef(false);
  const qtyDirtyRef = useRef(false);
  // Bumped on every phase change. A save captures it before its first await and
  // skips its post-save bookkeeping if it has moved (see saveStillApplies).
  const entrySessionRef = useRef(0);
  // Bumped to remount ONE editor to a clean state after it saves, while leaving
  // the other (dirty) one mounted. Remounting re-seeds from the line.
  const [fillKey, setFillKey] = useState(0);
  const [qtyKey, setQtyKey] = useState(0);
  const [entryNotice, setEntryNotice] = useState<EntryNotice>(null);
  const [discardPrompt, setDiscardPrompt] = useState<DiscardPrompt>(null);

  // Every phase change clears the entry screen's bookkeeping, so a flag or
  // notice from one product's entry can never leak into the next one.
  const setPhase = useCallback((next: Phase) => {
    entrySessionRef.current += 1;
    fillDirtyRef.current = false;
    qtyDirtyRef.current = false;
    setEntryNotice(null);
    setDiscardPrompt(null);
    setPhaseRaw(next);
  }, []);
  const onFillDirty = useCallback((dirty: boolean) => {
    fillDirtyRef.current = dirty;
    // "Your open-bottle entry hasn't been saved" is moot once it is clean.
    if (!dirty) setEntryNotice((n) => (n === "qty-saved" ? null : n));
  }, []);
  const onQtyDirty = useCallback((dirty: boolean) => {
    qtyDirtyRef.current = dirty;
    if (!dirty) setEntryNotice((n) => (n === "fill-saved" ? null : n));
  }, []);
  const [lines, setLines] = useState<Map<string, LocalLine>>(() => {
    const map = new Map<string, LocalLine>();
    for (const l of initialLines) {
      map.set(lineKey(l.productId, l.locationId), { ...l, lineId: l.id });
    }
    return map;
  });
  const [pendingWrites, setPendingWrites] = useState(0);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [strayModalOpen, setStrayModalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<ProductSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rescanAnnouncement, setRescanAnnouncement] = useState<string | null>(null);

  const [rapid, setRapid] = useState(false);
  const [rapidLog, setRapidLog] = useState<RapidEvent[]>([]);
  const rapidInFlight = useRef(false);

  const activeLocation = locations.find((l) => l.id === activeLocationId) ?? null;
  const rapidAvailable = activeLocation?.countMode !== "tenths";

  const refreshPending = useCallback(async () => {
    setPendingWrites((await pendingFor(countId)).length);
  }, [countId]);

  /** Send one queued write, reusing its stored id. Returns false if the network is still down. */
  const sendQueued = useCallback(async (write: QueuedWrite): Promise<boolean> => {
    const body = { ...write.payload, clientLineId: write.id };
    try {
      const result =
        write.kind === "scan"
          ? await scanCountLineAction(body)
          : write.kind === "increment"
            ? await incrementCountLineAction(body)
            : write.kind === "fills"
              ? await editCountLineFillsAction(body)
              : await setCountLineQuantitiesAction(body);

      if (result.ok) {
        await dequeue(write.id);
        return true;
      }
      // A rejection from the server is an answer, not a network failure: the
      // server has decided, and replaying the identical write will get the
      // identical refusal. So it is DROPPED from the queue, not kept.
      //
      // Keeping it was the old behaviour and it broke the one signal this
      // screen has. `markAttempt` retains the record, so `pendingFor` kept
      // returning it, every mount and every `online` event resent it, and the
      // chip read "1 pending" forever — never returning to "Synced". After
      // that a genuinely lost write in the walk-in is indistinguishable from
      // the stuck one, which is precisely the failure the badge exists to
      // make visible (spec §11).
      //
      // Dropping it silently would be its own bug, so the write is named:
      // whoever is counting needs to know WHICH bottle to re-check, not just
      // that something was refused.
      await dequeue(write.id);
      setError(
        `${write.label ?? "A queued save"} was refused by the server and has been dropped: ` +
          `${result.error.message} Re-count that one to be sure.`,
      );
      return true;
    } catch {
      // The fetch itself threw — still offline. Leave the write queued with
      // its ORIGINAL id: that id is what makes the eventual resend safe if
      // this request actually did reach the server before the connection
      // dropped. Minting a new one here would double-count.
      await markAttempt(write.id, "Offline — will retry");
      return false;
    }
  }, []);

  /**
   * Drain the queue in creation order. Order matters: writes to the same line
   * must replay as they were made, or a SET followed by an ADD replays as an
   * ADD followed by a SET and lands on a different number.
   *
   * Stops at the first network failure rather than grinding through the rest
   * — if one request can't reach the server, neither can the next, and
   * burning through the queue would just mark every write failed.
   */
  const flush = useCallback(async () => {
    for (const write of await pendingFor(countId)) {
      const reachable = await sendQueued(write);
      if (!reachable) break;
    }
    await refreshPending();
  }, [countId, sendQueued, refreshPending]);

  // Drain on mount — a leg reopened after a dropped connection must actually
  // send what is still waiting, not merely display a count of it — and again
  // whenever the browser says the network is back.
  useEffect(() => {
    // `flush` is async: it talks to IndexedDB and the network and only
    // touches state in a promise continuation, which the rule's static
    // analysis can't see. This is external-system synchronization — the
    // carve-out the rule's own docs describe — not derived state. The queue
    // must actually be drained on mount, not merely counted.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void flush();
    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [flush]);

  /**
   * Every count-line write goes through here.
   *
   * The `clientLineId` is minted ONCE, here, and stored on the queue record.
   * A retry of this same write reuses that id — which is what makes the
   * resend safe. A *new* action by the user mints a new id, which is what
   * makes a genuine second scan of the same bottle count twice instead of
   * being swallowed as a duplicate. See lib/count-queue.ts.
   */
  const runWrite = useCallback(
    async (
      kind: QueuedWriteKind,
      key: string,
      label: string,
      payload: Record<string, unknown>,
      optimistic: (prev: Map<string, LocalLine>) => Map<string, LocalLine>,
    ) => {
      const id = newWriteId();
      setError(null);
      setBusy(true);

      // Optimistic first — the UI never waits on the network to show the
      // bottle as counted (spec §11: <300ms perceived).
      //
      // The pre-write value of THIS line is captured on the way past, so a
      // write the server refuses can be undone. Capturing inside the updater
      // is what makes it exact rather than a render behind: React may re-run
      // an updater (StrictMode does, in development), but it re-runs it
      // against the same `prev`, so the capture is idempotent.
      //
      // One line, not the whole map: a blanket snapshot would also revert any
      // write that landed in between. Nothing can today — `busy` gates every
      // entry screen's submit, so writes are serialized — but a rollback that
      // silently depends on that gate is a trap for whoever removes it.
      let before: LocalLine | undefined;
      let existed = false;
      setLines((prev) => {
        before = prev.get(key);
        existed = prev.has(key);
        return optimistic(prev);
      });

      await enqueue({
        id,
        kind,
        countId,
        payload,
        label,
        createdAt: Date.now(),
        attempts: 0,
      });
      await refreshPending();

      const body = { ...payload, clientLineId: id };
      let result: Awaited<ReturnType<typeof incrementCountLineAction>>;
      try {
        result =
          kind === "scan"
            ? await scanCountLineAction(body)
            : kind === "increment"
              ? await incrementCountLineAction(body)
              : kind === "fills"
                ? await editCountLineFillsAction(body)
                : await setCountLineQuantitiesAction(body);
      } catch {
        // The fetch threw — offline, which is the case this queue exists for.
        // The write is already durably enqueued under `id`, the optimistic row
        // is already on screen, and `flush` will resend it with that same id
        // when the network returns. So this is NOT an error state: nothing was
        // lost and the counter should keep going. Saying "something went
        // wrong" here would push someone into re-entering a bottle that is
        // already recorded, which is how a queue designed to prevent lost
        // counts starts causing double ones.
        await markAttempt(id, "Offline — will retry");
        await refreshPending();
        setBusy(false);
        return true;
      }

      if (result.ok) {
        await dequeue(id);
        // Adopt the server's line id and authoritative quantities. The server
        // stays the source of truth; the optimistic row was only a placeholder.
        const row = result.data;
        setLines((prev) => {
          const next = new Map(prev);
          const lineK = lineKey(row.productId, row.locationId);
          const existing = next.get(lineK);
          if (existing) {
            next.set(lineK, {
              ...existing,
              lineId: row.id,
              sealedCaseQty: row.sealedCaseQty,
              sealedEachQty: row.sealedEachQty,
              partialFills: row.partialFills,
              units: row.units,
              caseSizeAtCount: row.caseSizeAtCount,
              ...(canSeeCost ? { extendedValue: row.extendedValue } : {}),
            });
          }
          return next;
        });
      } else {
        // The server refused. Undo the optimistic row and drop the write.
        //
        // Leaving it on screen was the worst bug this component had: the line
        // still read as counted, its units still counted toward the leg, and
        // `applyIncrement` used it as the base for the NEXT scan of the same
        // product — so a refused write silently became a phantom that later
        // writes compounded onto. Screen says counted, database disagrees,
        // nothing looks broken. That is the exact failure mode CLAUDE.md's
        // invariants exist to prevent.
        //
        // Dropped rather than queued for the same reason as in `sendQueued`:
        // the server has already decided, so a retry gets the same answer.
        setLines((prev) => {
          const next = new Map(prev);
          if (existed && before) {
            next.set(key, before);
          } else {
            next.delete(key);
          }
          return next;
        });
        await dequeue(id);
        setError(result.error.message);
      }

      await refreshPending();
      setBusy(false);
      return result.ok;
    },
    [countId, refreshPending, canSeeCost],
  );

  async function onBarcode(barcode: string) {
    if (activeLocationId == null) return;

    // Rapid mode keeps the camera up and records +1 per scan. It is only
    // offered on quantity locations, so there is no fill reading to collect
    // and no reason to leave the scanner.
    if (rapid && activeLocation?.countMode !== "tenths") {
      await rapidScan(barcode, activeLocationId);
      return;
    }

    setScannerOpen(false);
    setBusy(true);
    let resolved: Awaited<ReturnType<typeof resolveBarcodeAction>>;
    try {
      resolved = await resolveBarcodeAction({ barcode });
    } catch {
      // The fetch itself threw — offline. See OFFLINE_LOOKUP_MESSAGE for why
      // this is not queued and must not claim to be.
      setError(OFFLINE_LOOKUP_MESSAGE);
      return;
    } finally {
      // In a `finally` so the flag clears on EVERY exit, including the throw.
      // It used to be cleared on the line after the await, which is skipped
      // entirely when the await rejects — leaving `busy` stuck true, which
      // silently disables the submit button on the next entry screen reached.
      setBusy(false);
    }

    if (!resolved.ok) {
      setError(resolved.error.message);
      return;
    }
    if (!resolved.data) {
      // Unknown barcode -> scan-to-enroll. The catalog builds itself during
      // the first count (spec §12); an unknown code is the expected path, not
      // an error state.
      setPhase({ kind: "enroll", barcode });
      return;
    }
    setPhase({
      kind: "entry",
      product: resolved.data.product,
      locationId: activeLocationId,
      isStray: false,
    });
  }

  /**
   * One rapid scan: resolve, write +1 of whatever pack level the barcode is,
   * and stay on the camera.
   *
   * The write goes through `scanCountLine` (the "scan" kind) rather than
   * `incrementCountLine`, and that is the point of the mode: the barcode is
   * re-resolved on the SERVER, so the pack level that decides whether this is
   * a case or an each is never taken from the client. A case barcode adds one
   * case, an each barcode adds one each, and invariant 4 holds without the
   * client having an opinion.
   *
   * An unknown barcode drops out of rapid mode into the enroll form instead of
   * being counted or skipped. Skipping it would lose the bottle silently, and
   * enrolling mid-count is the catalog's designed growth path (spec §12) — but
   * enrolment needs the form, so the camera closes for it and rapid mode
   * resumes when the form is done.
   */
  async function rapidScan(barcode: string, locationId: number) {
    // Serialize rapid writes explicitly.
    //
    // `runWrite` captures the pre-write value of a line so a refused write can
    // be rolled back, and its own comment notes that this is only exact while
    // writes do not overlap — until now `busy` guaranteed that, because every
    // entry screen gated its submit on it. Rapid mode has no submit button to
    // gate, so the guarantee has to be restored here or the rollback silently
    // stops being correct: two scans of the same product in flight together
    // would both capture the same "before", and undoing one would erase the
    // other.
    //
    // A ref, not `busy`, because `busy` is state — a second scan arriving in
    // the same tick would read the stale value and sail through the check.
    if (rapidInFlight.current) return;
    rapidInFlight.current = true;
    try {
      await rapidScanInner(barcode, locationId);
    } finally {
      rapidInFlight.current = false;
    }
  }

  async function rapidScanInner(barcode: string, locationId: number) {
    setBusy(true);
    let resolved: Awaited<ReturnType<typeof resolveBarcodeAction>>;
    try {
      resolved = await resolveBarcodeAction({ barcode });
    } catch {
      // Offline, in the one mode where the camera never closes — so this log
      // line is the ONLY thing that can tell the counter the sweep stopped
      // recording. Without it you keep sweeping a shelf into nothing, which is
      // precisely the silent shortfall lib/rescan-guard.ts is written to avoid,
      // arrived at from the network side instead of the frame side.
      setBusy(false);
      pushRapid({
        ok: false,
        title: "Offline — not recorded",
        detail: "Can't reach the server. Come back into range and scan it again.",
      });
      return;
    }

    if (!resolved.ok) {
      setBusy(false);
      pushRapid({ ok: false, title: "Scan failed", detail: resolved.error.message });
      return;
    }

    if (!resolved.data) {
      setBusy(false);
      setScannerOpen(false);
      setPhase({ kind: "enroll", barcode });
      return;
    }

    const { product, packLevel } = resolved.data;
    const location = locations.find((l) => l.id === locationId);
    if (!location) {
      setBusy(false);
      return;
    }

    const k = lineKey(product.id, locationId);
    const existing = lines.get(k);

    const ok = await runWrite(
      "scan",
      k,
      writeLabel(product, location),
      { countId, barcode, locationId, qty: 1 },
      (prev) =>
        applyIncrement(
          prev,
          product,
          location,
          packLevel === "case" ? 1 : 0,
          packLevel === "each" ? 1 : 0,
          [],
        ),
    );

    if (ok && existing) {
      // A case of unknown size adds an unknown number of units; announcing a
      // total built on a guessed size would be a confident wrong number.
      const addedUnits = packLevel === "case" ? product.caseSize : 1;
      setRescanAnnouncement(
        addedUnits != null
          ? `Updated ${product.name} in ${location.name}: now ${formatUnits((existing.units ?? 0) + addedUnits)} units`
          : `Updated ${product.name} in ${location.name}: case added, case size unknown`,
      );
    }

    pushRapid({
      ok,
      title: product.name,
      detail: ok
        ? `+1 ${packLevel === "case" ? "case" : "each"}`
        : "Not saved — scan it again",
    });
  }

  function pushRapid(event: Omit<RapidEvent, "key">) {
    setRapidLog((prev) =>
      [{ ...event, key: newWriteId() }, ...prev].slice(0, RAPID_LOG_LIMIT),
    );
  }

  async function search(value: string) {
    setQuery(value);
    if (value.trim().length < 2) {
      setResults([]);
      return;
    }
    try {
      const found = await searchProductsAction({ query: value, limit: 20 });
      if (found.ok) setResults(found.data);
    } catch {
      setResults([]);
      setError(OFFLINE_LOOKUP_MESSAGE);
    }
  }

  // ---- entry screen: leaving without losing input ---------------------------

  const leaveEntry = () => setPhase({ kind: "counting" });

  /**
   * Back / Cancel. A clean entry screen leaves at once; one holding unsaved
   * input asks first — inline, not a modal (a dialog on a control used this
   * often is clicked through blind), and next to the control that was tapped.
   */
  function requestLeave(from: Exclude<DiscardPrompt, null>) {
    if (fillDirtyRef.current || qtyDirtyRef.current) {
      setDiscardPrompt(from);
      return;
    }
    leaveEntry();
  }

  /**
   * Call after a save SUCCEEDED. The entry screen mounts the open-bottle and
   * sealed editors together, each with its own Save; leaving unmounts both, so
   * a save from one used to silently discard whatever was typed in the other.
   * If the other holds unsaved input, stay: remount only the half that saved
   * (it re-seeds from the already-updated line) and say what is still pending.
   * The other half's draft is never written on its behalf.
   *
   * `startedSession` is `entrySessionRef.current` as read BEFORE the save's
   * first await. If the counter left this entry meanwhile (Back → Discard, then
   * scanned something else) the write has landed but the screen is no longer
   * the one it was for, and the dirty refs now describe a different entry.
   */
  function afterEntrySave(saved: "fill" | "qty", startedSession: number) {
    if (!saveStillApplies(startedSession, entrySessionRef.current)) return;
    const otherDirty = saved === "fill" ? qtyDirtyRef.current : fillDirtyRef.current;
    if (afterSave({ otherDirty }) === "leave") {
      leaveEntry();
      return;
    }
    if (saved === "fill") setFillKey((k) => k + 1);
    else setQtyKey((k) => k + 1);
    setEntryNotice(saved === "fill" ? "fill-saved" : "qty-saved");
    setDiscardPrompt(null);
  }

  // ---- location picker -----------------------------------------------------

  if (phase.kind === "pick-location") {
    return (
      <LocationPicker
        countId={countId}
        locations={locations}
        counted={lines}
        onPick={(id) => {
          setActiveLocationId(id);
          setPhase({ kind: "counting" });
          setRapid(false);
          setRapidLog([]);
        }}
      />
    );
  }

  // ---- scan-to-enroll ------------------------------------------------------

  if (phase.kind === "enroll") {
    return (
      <EnrollForm
        barcode={phase.barcode}
        onCancel={() => setPhase({ kind: "counting" })}
        onResolved={(product) => {
          if (activeLocationId == null) return;
          setPhase({ kind: "entry", product, locationId: activeLocationId, isStray: false });
        }}
      />
    );
  }

  // ---- quantity / fill entry ----------------------------------------------

  if (phase.kind === "entry") {
    const { product, locationId, isStray } = phase;
    const location = locations.find((l) => l.id === locationId)!;
    const existing = lines.get(lineKey(product.id, locationId));
    const showFill = location.countMode === "tenths";
    // Keyed on the line too, so a different product's entry can never inherit
    // this one's typed state even if React reuses the component position.
    const entryKey = `${product.id}:${locationId}`;

    return (
      <div className="px-bar-pad pb-8 pt-6">
        {discardPrompt === "top" ? (
          <DiscardRow className="mb-4" onKeep={() => setDiscardPrompt(null)} onDiscard={leaveEntry} />
        ) : (
          <button
            type="button"
            onClick={() => requestLeave("top")}
            className="mb-2 flex min-h-tap-min items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" aria-hidden="true" /> Back to {location.name}
          </button>
        )}

        <h1 className="text-header-title text-foreground">{product.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-row-subtitle text-muted-foreground">
            {product.unitType === "keg" ? "Keg" : `${product.sizeMl}ml`} &middot; {location.name}
          </span>
          {isStray ? (
            <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-label font-semibold uppercase text-accent">
              Stray bottle
            </span>
          ) : null}
        </div>

        {error ? (
          <p className="mt-3 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-section-gap">
          {showFill ? (
            <FillEntry
              key={`fill:${entryKey}:${fillKey}`}
              productId={product.id}
              productName={product.name}
              sizeMl={product.sizeMl}
              unitType={product.unitType}
              locationName={location.name}
              existingFills={existing?.partialFills ?? []}
              canCorrect={existing?.lineId != null}
              canSeeCost={canSeeCost}
              unitCost={product.currentUnitCost}
              pending={busy}
              onSaveFills={async (allFills) => {
                const startedSession = entrySessionRef.current;
                // FillEntry hands back the WHOLE open-bottle list, seeded from
                // the line's existing fills. Sending that array through the
                // ledgered `increment` would append it onto itself and
                // double-count every bottle already there, so classify the edit
                // first (lib/fill-save.ts).
                const plan = planFillSave(existing?.partialFills ?? [], allFills);

                if (plan.kind === "none") {
                  // Nothing was written, so don't claim a save; just don't
                  // strand the counter (or eat the other editor's input).
                  if (afterSave({ otherDirty: qtyDirtyRef.current }) === "leave") leaveEntry();
                  return;
                }

                if (plan.kind === "append") {
                  // Only the NEW bottles go out, through the ledgered, additive
                  // path with a fresh id per attempt: retry-safe, and it works
                  // before the line has synced.
                  const ok = await runWrite(
                    "increment",
                    lineKey(product.id, locationId),
                    writeLabel(product, location),
                    {
                      countId,
                      productId: product.id,
                      locationId,
                      sealedCaseQtyDelta: 0,
                      sealedEachQtyDelta: 0,
                      newPartialFills: plan.added,
                    },
                    (prev) => applyIncrement(prev, product, location, 0, 0, plan.added),
                  );
                  if (ok) afterEntrySave("fill", startedSession);
                  return;
                }

                // plan.kind === "replace": a bottle was changed or removed. That
                // corrects a row that exists server-side. Before the first write
                // lands there is nothing to correct, and REPLACE is not ledgered,
                // so refuse rather than guess.
                if (existing?.lineId == null) {
                  setError(
                    "This line hasn't finished syncing, so a bottle can't be changed or removed yet. Wait for the sync indicator to clear, then try again.",
                  );
                  return;
                }
                const ok = await runWrite(
                  "fills",
                  lineKey(product.id, locationId),
                  writeLabel(product, location),
                  { countLineId: existing.lineId, partialFills: plan.fills },
                  (prev) => applyFillCorrection(prev, product, location, plan.fills),
                );
                if (ok) afterEntrySave("fill", startedSession);
              }}
              onDirtyChange={onFillDirty}
              onCancel={() => requestLeave("fill")}
            />
          ) : null}

          {entryNotice === "fill-saved" ? (
            <p
              role="status"
              className="mt-3 rounded-md bg-warning-bg px-3 py-2 text-caption font-medium text-warning"
            >
              Saved. Your sealed-bottle entry below hasn&rsquo;t been saved yet.
            </p>
          ) : null}
          {discardPrompt === "fill" ? (
            <DiscardRow className="mt-3" onKeep={() => setDiscardPrompt(null)} onDiscard={leaveEntry} />
          ) : null}

          {/*
            Sealed bottles are counted in EVERY location, tenths or not. A Speed
            Rail or Back Bar line is open bottles AND the sealed backup behind
            them, and sealed is the larger share of units (60-75%). Gating this
            behind `!showFill` makes every sealed bottle on a tenths shelf
            uncountable, with no error anywhere.
          */}
          <div className={showFill ? "mt-section-gap border-t border-border pt-5" : ""}>
            {showFill ? (
              <p className="mb-3 text-label uppercase text-muted-foreground">
                Sealed bottles here
              </p>
            ) : null}
            <QuantityEntry
              key={`qty:${entryKey}:${qtyKey}`}
              productId={product.id}
              productName={product.name}
              currentCases={existing?.sealedCaseQty ?? 0}
              currentEaches={existing?.sealedEachQty ?? 0}
              caseSize={existing?.caseSizeAtCount ?? product.caseSize}
              category={product.category}
              unitType={product.unitType}
              canSet={existing?.lineId != null}
              canSeeCost={canSeeCost}
              unitCost={product.currentUnitCost}
              pending={busy}
              onSubmit={async (submission: QuantitySubmission) => {
                const startedSession = entrySessionRef.current;
                const ok =
                  submission.mode === "set" && existing?.lineId != null
                    ? await runWrite(
                        "set",
                        lineKey(product.id, locationId),
                        writeLabel(product, location),
                        {
                          countLineId: existing.lineId,
                          sealedCaseQty: submission.cases,
                          sealedEachQty: submission.eaches,
                        },
                        (prev) => applySet(prev, product, location, submission),
                      )
                    : await runWrite(
                        "increment",
                        lineKey(product.id, locationId),
                        writeLabel(product, location),
                        {
                          countId,
                          productId: product.id,
                          locationId,
                          sealedCaseQtyDelta: submission.cases,
                          sealedEachQtyDelta: submission.eaches,
                          newPartialFills: [],
                        },
                        (prev) =>
                          applyIncrement(
                            prev,
                            product,
                            location,
                            submission.cases,
                            submission.eaches,
                            [],
                          ),
                      );
                if (ok) afterEntrySave("qty", startedSession);
              }}
              onDirtyChange={onQtyDirty}
              onCancel={() => requestLeave("qty")}
            />
            {entryNotice === "qty-saved" ? (
              <p
                role="status"
                className="mt-3 rounded-md bg-warning-bg px-3 py-2 text-caption font-medium text-warning"
              >
                Saved. Your open-bottle entry above hasn&rsquo;t been saved yet.
              </p>
            ) : null}
            {discardPrompt === "qty" ? (
              <DiscardRow className="mt-3" onKeep={() => setDiscardPrompt(null)} onDiscard={leaveEntry} />
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // ---- the counting leg ----------------------------------------------------

  const legLines = [...lines.values()].filter((l) => l.locationId === activeLocationId);

  return (
    <div className="pb-action-bar">
      {/* Screen Reader Live Region for Invariant 3 Announcements */}
      <div aria-live="polite" className="sr-only">
        {rescanAnnouncement}
      </div>

      {scannerOpen ? (
        <BarcodeScanner
          onDetected={onBarcode}
          onClose={() => setScannerOpen(false)}
          continuous={rapidAvailable && rapid}
          overlay={
            rapidAvailable && rapid ? (
              <div className="flex flex-col gap-1">
                {rapidLog.map((e) => (
                  <div
                    key={e.key}
                    className={cn(
                      "rounded-md px-3 py-2 text-caption backdrop-blur-sm",
                      e.ok ? "bg-black/70 text-white" : "bg-negative-bg/95 text-negative",
                    )}
                  >
                    <span className="font-medium">{e.title}</span>
                    <span className="opacity-80"> · {e.detail}</span>
                  </div>
                ))}
              </div>
            ) : null
          }
          footer={
            rapidAvailable ? (
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setRapid((v) => !v);
                    setRapidLog([]);
                  }}
                  aria-pressed={rapid}
                  className={cn(
                    "flex min-h-tap-primary items-center gap-2 rounded-full px-5 text-body font-medium",
                    rapid
                      ? "bg-accent text-accent-foreground"
                      : "border border-white/25 text-white active:bg-white/10",
                  )}
                >
                  <Zap className="size-5" aria-hidden="true" />
                  {rapid ? "Rapid mode on" : "Rapid mode off"}
                </button>
                <p className="text-center text-caption text-white/70">
                  {rapid
                    ? "Each scan records one more. The camera stays open."
                    : "Point at the barcode. Damaged label? Close this and search instead."}
                </p>
              </div>
            ) : null
          }
        />
      ) : null}

      {/* Top Bar: Navigation + Identity + Sync Badge */}
      <div className="flex items-center justify-between gap-2 px-bar-pad pt-4">
        <Link
          href={`/count/${countId}`}
          aria-label="Back to count"
          className="flex size-11 items-center justify-center rounded-full border border-border/80 bg-card/85 text-foreground backdrop-blur-md shadow-xs transition-all hover:border-accent/40 active:scale-95"
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </Link>
        <div className="text-center">
          <p className="text-label font-bold uppercase text-foreground">Count #{countId}</p>
          <p className="text-caption text-muted-foreground">In progress</p>
        </div>
        <SyncIndicator pending={pendingWrites} />
      </div>

      {/* Locked Location Context Row */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-bar-pad pt-4">
        <div
          className="inline-flex min-h-tap-min items-center gap-2 rounded-full border border-border/80 bg-card/85 px-3.5 py-1.5 backdrop-blur-md shadow-xs"
          aria-label={`Current location for this leg: ${activeLocation?.name}`}
        >
          <MapPin className="size-4 text-accent" aria-hidden="true" />
          <span className="text-label font-bold uppercase text-foreground">
            {activeLocation?.name}
          </span>
          <span className="text-caption text-muted-foreground">
            · {activeLocation?.countMode === "tenths" ? "fill levels" : "quantities only"}
          </span>
        </div>

        {/* Stray Bottle Escape Hatch Button */}
        <button
          type="button"
          onClick={() => setStrayModalOpen(true)}
          className="inline-flex min-h-tap-min items-center rounded-full border border-dashed border-input bg-transparent px-3.5 text-caption font-semibold text-muted-foreground hover:border-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Count a stray bottle elsewhere
        </button>
      </div>

      {/* Top Search + Scan Input (Pinned at top) */}
      <div className="px-bar-pad pt-4">
        <div className="flex h-tap-min items-center gap-2 rounded-md border border-input bg-card px-4 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50">
          <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(e) => void search(e.target.value)}
            placeholder="Search products"
            className="min-w-0 flex-1 bg-transparent text-body text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <button
            type="button"
            aria-label="Scan barcode"
            onClick={() => setScannerOpen(true)}
            className="-mr-2 flex size-tap-primary shrink-0 items-center justify-center rounded-md text-accent active:bg-muted"
          >
            <ScanLine className="size-6" aria-hidden="true" />
          </button>
        </div>
      </div>

      {error ? (
        <p className="mx-bar-pad mt-3 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {error}
        </p>
      ) : null}

      {/* Search Results Dropdown */}
      {results.length > 0 ? (
        <div className="px-bar-pad pt-4">
          <p className="mb-2 text-label uppercase text-muted-foreground">Search results</p>
          <CardStack>
            {results.map((p) => (
              <button
                key={p.id}
                type="button"
                className="flex min-h-tap-primary flex-col justify-center rounded-xl border border-border/80 bg-card/85 backdrop-blur-md p-card-pad text-left shadow-xs transition-all hover:border-accent/40 hover:bg-muted/60 active:scale-[0.985]"
                onClick={() => {
                  setResults([]);
                  setQuery("");
                  if (activeLocationId == null) return;
                  setPhase({ kind: "entry", product: p, locationId: activeLocationId, isStray: false });
                }}
              >
                <p className="text-row-title text-card-foreground">{p.name}</p>
                <p className="text-row-subtitle text-muted-foreground">
                  {p.unitType === "keg" ? "Keg" : `${p.sizeMl}ml`}
                  {p.brand ? ` · ${p.brand}` : ""}
                </p>
              </button>
            ))}
          </CardStack>
        </div>
      ) : null}

      {/* Just Counted List */}
      <div className="px-bar-pad pt-5">
        <div className="mb-3 flex items-baseline justify-between">
          <p className="text-label uppercase text-muted-foreground">Just counted</p>
          <p className="text-caption text-muted-foreground">
            {legLines.length} in {activeLocation?.name}
          </p>
        </div>
        {legLines.length === 0 ? (
          <p className="text-row-subtitle text-muted-foreground">
            Nothing here yet. Scan a bottle or search for it.
          </p>
        ) : (
          <CardStack>
            {legLines.map((l) => (
              <CountLineCard key={lineKey(l.productId, l.locationId)} data={l} highlight={l.note} />
            ))}
          </CardStack>
        )}
      </div>

      {/* Stray Bottle Modal */}
      <StrayBottleModal
        isOpen={strayModalOpen}
        activeLocationId={activeLocationId ?? 0}
        locations={locations}
        onClose={() => setStrayModalOpen(false)}
        onRecordStray={(targetLocationId, product) => {
          setPhase({ kind: "entry", product, locationId: targetLocationId, isStray: true });
        }}
      />

      {/* Floating Bottom Action Bar — One-Handed Accessible 56px Floor */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-2 border-t border-border bg-background px-bar-pad pt-bar-pad pb-safe-bottom">
        <Button
          variant="outline"
          size="icon"
          aria-label="Search products"
          onClick={() => {
            searchInputRef.current?.scrollIntoView({ block: "center" });
            searchInputRef.current?.focus();
          }}
        >
          <Search className="size-5" aria-hidden="true" />
        </Button>
        <Button
          variant="accent"
          size="primary"
          className="flex flex-1 items-center justify-center gap-2"
          onClick={() => setScannerOpen(true)}
        >
          <ScanLine className="size-5" aria-hidden="true" />
          <span className="text-label uppercase">Scan</span>
        </Button>
        <Button
          variant="outline"
          size="primary"
          className="whitespace-nowrap"
          onClick={() => setPhase({ kind: "pick-location" })}
        >
          Finish section
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Optimistic Reducers
// ---------------------------------------------------------------------------

function baseLine(product: ProductSummary, location: LocationSummary): LocalLine {
  return {
    lineId: null,
    productId: product.id,
    locationId: location.id,
    productName: product.name,
    category: product.category,
    sizeMl: product.sizeMl ?? 0,
    unitType: (product.unitType as "bottle" | "can" | "keg") ?? "bottle",
    locationName: location.name,
    sealedCaseQty: 0,
    sealedEachQty: 0,
    partialFills: [],
    units: 0,
    caseSizeAtCount: product.caseSize,
  };
}

function applyIncrement(
  prev: Map<string, LocalLine>,
  product: ProductSummary,
  location: LocationSummary,
  cases: number,
  eaches: number,
  newFills: number[],
): Map<string, LocalLine> {
  const next = new Map(prev);
  const key = lineKey(product.id, location.id);
  const existing = next.get(key) ?? baseLine(product, location);
  const sealedCaseQty = existing.sealedCaseQty + cases;
  const sealedEachQty = existing.sealedEachQty + eaches;
  const partialFills = [...existing.partialFills, ...newFills];
  next.set(key, {
    ...existing,
    sealedCaseQty,
    sealedEachQty,
    partialFills,
    units: computeUnits(sealedCaseQty, sealedEachQty, partialFills, existing.caseSizeAtCount),
    note: existing.lineId != null ? "Already on this count — updated, not duplicated" : undefined,
  });
  return next;
}

function applyFillCorrection(
  prev: Map<string, LocalLine>,
  product: ProductSummary,
  location: LocationSummary,
  allFills: number[],
): Map<string, LocalLine> {
  const next = new Map(prev);
  const key = lineKey(product.id, location.id);
  const existing = next.get(key) ?? baseLine(product, location);
  next.set(key, {
    ...existing,
    partialFills: allFills,
    units: computeUnits(
      existing.sealedCaseQty,
      existing.sealedEachQty,
      allFills,
      existing.caseSizeAtCount,
    ),
    note: undefined,
  });
  return next;
}

function applySet(
  prev: Map<string, LocalLine>,
  product: ProductSummary,
  location: LocationSummary,
  submission: QuantitySubmission,
): Map<string, LocalLine> {
  const next = new Map(prev);
  const key = lineKey(product.id, location.id);
  const existing = next.get(key) ?? baseLine(product, location);
  next.set(key, {
    ...existing,
    sealedCaseQty: submission.cases,
    sealedEachQty: submission.eaches,
    units: computeUnits(
      submission.cases,
      submission.eaches,
      existing.partialFills,
      existing.caseSizeAtCount,
    ),
    note: undefined,
  });
  return next;
}

function computeUnits(
  cases: number,
  eaches: number,
  fills: number[],
  caseSize: number | null,
): number | null {
  if (cases > 0 && caseSize == null) return null;
  return cases * (caseSize ?? 0) + eaches + fills.reduce((s, f) => s + f, 0);
}

/**
 * Inline "throw away what I typed?" row — deliberately NOT a modal. The safe
 * answer (Keep editing) takes focus so a stray tap or Enter doesn't discard,
 * and Discard sits where Cancel does so the thumb path stays the same.
 */
function DiscardRow({
  className,
  onKeep,
  onDiscard,
}: {
  className?: string;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Discard unsaved entry?"
      className={cn("rounded-md border border-negative bg-negative-bg p-3", className)}
    >
      <p className="text-caption font-semibold text-negative">Discard unsaved entry?</p>
      <div className="mt-2 flex gap-3">
        <Button variant="destructive" size="primary" className="flex-1" onClick={onDiscard}>
          Discard
        </Button>
        <Button
          variant="primary"
          size="primary"
          className="flex-[1.5]"
          autoFocus
          onClick={onKeep}
        >
          Keep editing
        </Button>
      </div>
    </div>
  );
}

function SyncIndicator({ pending }: { pending: number }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-label uppercase",
        pending > 0 ? "bg-warning-bg text-warning" : "bg-success-bg text-success",
      )}
      aria-live="polite"
    >
      {pending > 0 ? (
        <>
          <CloudOff className="size-3.5" aria-hidden="true" />
          {pending} pending
        </>
      ) : (
        <>
          <Check className="size-3.5" aria-hidden="true" />
          Synced
        </>
      )}
    </div>
  );
}
