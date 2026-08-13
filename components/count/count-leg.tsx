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
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CardStack } from "@/components/ui/card";
import { CountLineCard, type CountLineCardData } from "@/components/count/count-line-card";
import { BarcodeScanner } from "@/components/count/barcode-scanner";
import { QuantityEntry, type QuantitySubmission } from "@/components/count/quantity-entry";
import { FillEntry } from "@/components/count/fill-entry";
import { EnrollForm } from "@/components/count/enroll-form";

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

/**
 * One rapid-mode scan, kept only long enough to be shown over the camera.
 *
 * `ok: false` entries matter more than the successes: in rapid mode the
 * scanner does not close, so a refusal has no screen of its own to land on.
 * If a failure were silent the counter would keep scanning past it and the
 * bottle would simply be missing from the count — the same quiet shortfall
 * CLAUDE.md's `client_line_id` note warns about, arrived at from the UI side.
 */
interface RapidEvent {
  /** Fresh per scan, so React keys stay unique when the same bottle repeats. */
  key: string;
  ok: boolean;
  title: string;
  detail: string;
}

/** How many rapid scans stay on screen. Enough to see a mistake, not a wall of text. */
const RAPID_LOG_LIMIT = 4;

/**
 * Shown when a READ-side server call cannot reach the server at all.
 *
 * The asymmetry this exists to fix: `runWrite` has always wrapped its server
 * action in try/catch, because the offline case is the whole reason the write
 * queue exists. The read-side calls beside it — `resolveBarcodeAction`,
 * `searchProductsAction` — did not. Offline, the fetch threw straight out of an
 * async event handler, so `setBusy(false)` never ran, `setError` was never
 * reached, and `setPhase` never fired. You scanned, the scanner closed, and
 * NOTHING happened: no entry screen, no error, no queued write. Silent, and the
 * exact shape of every other bug this project has had to find the hard way.
 *
 * A read cannot be queued the way a write can, and the message must not imply
 * otherwise. The barcode has to resolve to a product BEFORE there is an entry
 * screen to collect a reading on, so there is nothing to replay later — and the
 * search picker is no fallback here, being equally server-backed. The honest
 * advice is: what you already entered is safe, this scan is not, come back into
 * range and do it again.
 */
const OFFLINE_LOOKUP_MESSAGE =
  "Offline — couldn't look that up, and nothing was recorded for it. " +
  "Readings you already entered are saved and will sync when you are back in range. " +
  "Move back into WiFi range and scan that one again.";

function lineKey(productId: number, locationId: number) {
  return `${productId}:${locationId}`;
}

/**
 * How a write is named back to the person who made it, when the server
 * refuses one that was queued offline. "Tito's Handmade Vodka · Back Bar" is
 * something a counter can walk over and re-check; "a queued save" is not.
 */
function writeLabel(product: ProductSummary, location: LocationSummary) {
  return `${product.name} · ${location.name}`;
}

/**
 * One counting leg: a locked location, a scan/search input, and the running
 * list of what was just counted.
 *
 * WHY THE LOCATION IS LOCKED (CLAUDE.md, and the reason
 * prototypes/count-scan.html's free-switch dropdown must not be copied): a
 * wrong active location fails *silently*. Every scan lands on a real,
 * legitimate line in the wrong place. The count total stays correct and only
 * the distribution is wrong, so nothing looks broken until a reorder list is
 * nonsense weeks later. So the location is chosen once per leg and cannot be
 * changed by a dropdown sitting next to the scan button.
 *
 * The escape hatch is a separate, deliberately heavier action: "count
 * something elsewhere" records one stray bottle into another location and
 * returns you to the current leg. It never silently changes which leg you
 * are in.
 */
export function CountLeg({
  countId,
  locations,
  initialLines,
  canSeeCost,
}: {
  countId: number;
  locations: LocationSummary[];
  initialLines: CountLineDetail[];
  canSeeCost: boolean;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "pick-location" });
  const [activeLocationId, setActiveLocationId] = useState<number | null>(null);
  const [lines, setLines] = useState<Map<string, LocalLine>>(() => {
    const map = new Map<string, LocalLine>();
    for (const l of initialLines) {
      map.set(lineKey(l.productId, l.locationId), { ...l, lineId: l.id });
    }
    return map;
  });
  const [pendingWrites, setPendingWrites] = useState(0);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Rapid mode: the scanner stays open and every scan records "one more of
   * this" without an entry screen (open-item #10). Only meaningful where the
   * count is quantities-only — a tenths location needs a fill reading per
   * bottle, which is exactly the entry screen rapid mode skips.
   */
  const [rapid, setRapid] = useState(false);
  /** Last few rapid scans, newest first, for the on-scanner confirmation. */
  const [rapidLog, setRapidLog] = useState<RapidEvent[]>([]);
  /** Held for the duration of one rapid write, so two can never overlap. */
  const rapidInFlight = useRef(false);

  const activeLocation = locations.find((l) => l.id === activeLocationId) ?? null;

  /**
   * Rapid mode is offered only where the location is counted by quantity.
   *
   * On a tenths location every open bottle needs a fill reading, which is the
   * entry screen rapid mode exists to skip — a "+1 each" there would record a
   * whole sealed bottle for what is actually a part-full one, and the count
   * would read high with nothing on screen looking wrong. The mode is hidden
   * rather than disabled because the location already states its input mode
   * two lines up, so a greyed-out control would be asking a question the
   * screen has answered.
   */
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
          const key = lineKey(row.productId, row.locationId);
          const existing = next.get(key);
          if (existing) {
            next.set(key, {
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

    const ok = await runWrite(
      "scan",
      lineKey(product.id, locationId),
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

    pushRapid({
      ok,
      title: product.name,
      detail: ok
        ? `+1 ${packLevel === "case" ? "case" : "each"}`
        : "Not saved — scan it again",
    });
  }

  /** Prepend a rapid result, keeping the list short. */
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
      // Offline. Clear the list rather than leaving the PREVIOUS query's hits
      // sitting under the current text — stale results that look like an answer
      // are worse than none, because tapping one records the wrong bottle.
      setResults([]);
      setError(OFFLINE_LOOKUP_MESSAGE);
    }
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
          // Rapid mode does not survive a leg change. It is a per-location
          // decision (a tenths leg cannot use it at all), and carrying it
          // silently into the next leg would mean the first scan there
          // records +1 without the counter having asked for that.
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
        // Both enroll paths land here — whether the barcode was attached to a
        // product the catalog already had or to one just created, the next
        // step is identical: count the thing that is now in your hand.
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
    const done = () => setPhase({ kind: "counting" });

    // Fill levels are offered only where the location says so (CLAUDE.md:
    // the input-mode switch is driven entirely by location) and only for
    // things that can be partly full. A sealed case in the storeroom has no
    // fill level, and offering a pad there invites someone to tap one.
    const showFill = location.countMode === "tenths";

    return (
      <div className="px-bar-pad pb-8 pt-6">
        <button
          type="button"
          onClick={done}
          className="mb-4 flex items-center gap-1 text-caption text-muted-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden="true" /> Back to {location.name}
        </button>

        <h1 className="text-header-title text-foreground">{product.name}</h1>
        <p className="mt-1 text-row-subtitle text-muted-foreground">
          {product.unitType === "keg" ? "Keg" : `${product.sizeMl}ml`} &middot; {location.name}
          {isStray ? " · stray" : ""}
        </p>

        {error ? (
          <p className="mt-3 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-section-gap">
          {showFill ? (
            <FillEntry
              productName={product.name}
              existingFills={existing?.partialFills ?? []}
              // A correction edits a row that exists server-side. Before the
              // first write lands there is nothing to correct — and the local
              // array is still empty anyway, so the affordance would do
              // nothing if it were offered.
              canCorrect={existing?.lineId != null}
              pending={busy}
              onCorrect={async (allFills) => {
                if (existing?.lineId == null) return;
                const ok = await runWrite(
                  "fills",
                  lineKey(product.id, locationId),
                  writeLabel(product, location),
                  { countLineId: existing.lineId, partialFills: allFills },
                  (prev) => applyFillCorrection(prev, product, location, allFills),
                );
                if (ok) done();
              }}
              onSubmit={async (newFills) => {
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
                    newPartialFills: newFills,
                  },
                  (prev) => applyIncrement(prev, product, location, 0, 0, newFills),
                );
                if (ok) done();
              }}
              onCancel={done}
            />
          ) : null}

          <div className={showFill ? "mt-section-gap border-t border-border pt-5" : ""}>
            {showFill ? (
              <p className="mb-3 text-label uppercase text-muted-foreground">
                Sealed bottles here
              </p>
            ) : null}
            <QuantityEntry
              currentCases={existing?.sealedCaseQty ?? 0}
              currentEaches={existing?.sealedEachQty ?? 0}
              caseSize={existing?.caseSizeAtCount ?? product.caseSize}
              // Identity, not a flag: QuantityEntry asks `isCountedByCase`
              // itself so this screen never gets its own idea of what a case
              // is. Both fields come off the resolved product row.
              category={product.category}
              unitType={product.unitType}
              canSet={existing?.lineId != null}
              pending={busy}
              onSubmit={async (submission: QuantitySubmission) => {
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
                if (ok) done();
              }}
              onCancel={done}
            />
          </div>
        </div>
      </div>
    );
  }

  // ---- the counting leg ----------------------------------------------------

  const legLines = [...lines.values()].filter((l) => l.locationId === activeLocationId);

  return (
    <div className="pb-action-bar">
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

      <div className="flex items-center justify-between gap-2 px-bar-pad pt-4">
        <Link
          href={`/count/${countId}`}
          aria-label="Back to count"
          className="flex size-11 items-center justify-center rounded-full border border-border"
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </Link>
        <div className="text-center">
          <p className="text-label uppercase text-muted-foreground">Count #{countId}</p>
        </div>
        <SyncIndicator pending={pendingWrites} />
      </div>

      {/*
        The active location is a STATEMENT, not a control. It is deliberately
        not a dropdown — see this component's doc comment.
      */}
      <div className="px-bar-pad pt-4">
        <div className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-2">
          <MapPin className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-label uppercase text-foreground">{activeLocation?.name}</span>
          <span className="text-caption text-muted-foreground">
            · {activeLocation?.countMode === "tenths" ? "fill levels" : "quantities only"}
          </span>
        </div>
      </div>

      <div className="px-bar-pad pt-4">
        <div className="flex h-tap-min items-center gap-2 rounded-md border border-input bg-card px-4 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50">
          <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
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
        {/* Search is always beside scan, never behind it — damaged labels,
            house infusions and some wine have no usable barcode (CLAUDE.md). */}
      </div>

      {error ? (
        <p className="mx-bar-pad mt-3 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {error}
        </p>
      ) : null}

      {results.length > 0 ? (
        <div className="px-bar-pad pt-4">
          <p className="mb-2 text-label uppercase text-muted-foreground">Search results</p>
          <CardStack>
            {results.map((p) => (
              <button
                key={p.id}
                type="button"
                className="flex min-h-tap-primary flex-col justify-center rounded-lg border border-border bg-card p-card-pad text-left active:bg-muted"
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

      <div className="px-bar-pad pt-5">
        {/*
          The escape hatch. Note it never touches `activeLocationId` — it
          opens an entry screen pointed at another location and returns here.
          That is the whole difference between this and a location dropdown.
        */}
        <StrayPicker
          locations={locations.filter((l) => l.id !== activeLocationId)}
          onProduct={(product, locationId) =>
            setPhase({ kind: "entry", product, locationId, isStray: true })
          }
        />
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 flex gap-3 border-t border-border bg-background px-bar-pad pt-bar-pad pb-safe-bottom">
        <Button
          variant="outline"
          size="primary"
          className="flex-1"
          onClick={() => setPhase({ kind: "pick-location" })}
        >
          Finish section
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Optimistic reducers. These mirror the server's own rules — increments add,
// SET replaces — so the row on screen matches what the write will produce.
// ---------------------------------------------------------------------------

function baseLine(
  product: ProductSummary,
  location: LocationSummary,
): LocalLine {
  return {
    lineId: null,
    productId: product.id,
    locationId: location.id,
    productName: product.name,
    category: product.category,
    sizeMl: product.sizeMl,
    unitType: product.unitType,
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
    // Invariant 3 made visible: a second scan increments the existing line
    // rather than creating a second one, and the UI says so.
    note: existing.lineId != null ? "Already on this count — updated, not duplicated" : undefined,
  });
  return next;
}

/**
 * A fill correction REPLACES `partial_fills`, mirroring the server's
 * `editCountLineFills`. Sealed quantities are untouched — the two halves of a
 * line are counted separately and corrected separately (invariant 4).
 */
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

/** Mirrors lib/domain/valuation.ts's computeLineUnits, including its null case. */
function computeUnits(
  cases: number,
  eaches: number,
  fills: number[],
  caseSize: number | null,
): number | null {
  if (cases > 0 && caseSize == null) return null;
  return cases * (caseSize ?? 0) + eaches + fills.reduce((s, f) => s + f, 0);
}

// ---------------------------------------------------------------------------

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
      {/* Visible on purpose (spec §11): a dropped access point should be
          visible rather than silent. "12 pending" tells someone the walk-in
          killed the WiFi; nothing at all tells them everything is fine. */}
    </div>
  );
}

function LocationPicker({
  countId,
  locations,
  counted,
  onPick,
}: {
  countId: number;
  locations: LocationSummary[];
  counted: Map<string, LocalLine>;
  onPick: (id: number) => void;
}) {
  return (
    <div className="px-bar-pad pb-8 pt-6">
      <Link
        href={`/count/${countId}`}
        className="mb-4 flex items-center gap-1 text-caption text-muted-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden="true" /> Count #{countId}
      </Link>

      <h1 className="text-header-title text-foreground">Which section?</h1>
      <p className="mt-1 text-row-subtitle text-muted-foreground">
        Pick one and count it through. You stay in it until you tap{" "}
        <em className="not-italic text-foreground">Finish section</em>.
      </p>

      <div className="mt-section-gap flex flex-col gap-card-gap">
        {locations.map((location) => {
          const n = [...counted.values()].filter((l) => l.locationId === location.id).length;
          return (
            <button
              key={location.id}
              type="button"
              onClick={() => onPick(location.id)}
              className="flex min-h-tap-primary items-center justify-between rounded-lg border border-border bg-card p-card-pad text-left"
            >
              <span>
                <span className="block text-row-title text-card-foreground">{location.name}</span>
                <span className="block text-row-subtitle text-muted-foreground">
                  {location.countMode === "tenths" ? "Fill levels" : "Quantities only"}
                  {n > 0 ? ` · ${n} counted` : ""}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The escape hatch. A stray bottle found in the wrong place gets recorded
 * where it actually is, and then you land back in the leg you were already
 * in — the active location is never silently reassigned.
 */
function StrayPicker({
  locations,
  onProduct,
}: {
  locations: LocationSummary[];
  onProduct: (product: ProductSummary, locationId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSummary[]>([]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-tap-min w-full items-center justify-center rounded-lg border border-dashed border-border text-caption text-muted-foreground"
      >
        Count something elsewhere
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-card-pad">
      <p className="text-label uppercase text-foreground">Stray bottle</p>
      <p className="mt-1 text-caption text-muted-foreground">
        Records into another section and brings you straight back here.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {locations.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => setTarget(l.id)}
            className={cn(
              "min-h-tap-min rounded-full border px-3 text-label uppercase",
              target === l.id
                ? "border-accent bg-accent text-accent-foreground"
                : "border-input text-foreground",
            )}
          >
            {l.name}
          </button>
        ))}
      </div>

      {target != null ? (
        <div className="mt-3">
          <input
            type="search"
            value={query}
            placeholder="Find the product"
            onChange={async (e) => {
              setQuery(e.target.value);
              if (e.target.value.trim().length < 2) return setResults([]);
              const found = await searchProductsAction({ query: e.target.value, limit: 10 });
              if (found.ok) setResults(found.data);
            }}
            className="min-h-tap-min w-full rounded-md border border-input bg-background px-3 text-body text-foreground"
          />
          <div className="mt-2 flex flex-col gap-2">
            {results.map((p) => (
              <button
                key={p.id}
                type="button"
                className="rounded-md border border-border p-3 text-left"
                onClick={() => {
                  setOpen(false);
                  setResults([]);
                  setQuery("");
                  onProduct(p, target);
                }}
              >
                <span className="block text-row-subtitle text-foreground">{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-3 min-h-tap-min text-caption text-muted-foreground"
      >
        Cancel
      </button>
    </div>
  );
}
