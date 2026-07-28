"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, MapPin, ScanLine, Search, CloudOff, Check } from "lucide-react";
import {
  scanCountLineAction,
  incrementCountLineAction,
  setCountLineQuantitiesAction,
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

function lineKey(productId: number, locationId: number) {
  return `${productId}:${locationId}`;
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

  const activeLocation = locations.find((l) => l.id === activeLocationId) ?? null;

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
            : await setCountLineQuantitiesAction(body);

      if (result.ok) {
        await dequeue(write.id);
        return true;
      }
      // A rejection from the server is an answer, not a network failure. The
      // write will never succeed on replay (a closed count, a validation
      // error), so it stays queued with its reason recorded rather than
      // being retried forever against a server that has already decided.
      await markAttempt(write.id, result.error.message);
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
      kind: "scan" | "increment" | "set",
      payload: Record<string, unknown>,
      optimistic: (prev: Map<string, LocalLine>) => Map<string, LocalLine>,
    ) => {
      const id = newWriteId();
      setError(null);
      setBusy(true);

      // Optimistic first — the UI never waits on the network to show the
      // bottle as counted (spec §11: <300ms perceived).
      setLines(optimistic);

      await enqueue({
        id,
        kind,
        countId,
        payload,
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
        await markAttempt(id, result.error.message);
        setError(result.error.message);
      }

      await refreshPending();
      setBusy(false);
      return result.ok;
    },
    [countId, refreshPending, canSeeCost],
  );

  async function onBarcode(barcode: string) {
    setScannerOpen(false);
    if (activeLocationId == null) return;
    setBusy(true);
    const resolved = await resolveBarcodeAction({ barcode });
    setBusy(false);

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

  async function search(value: string) {
    setQuery(value);
    if (value.trim().length < 2) {
      setResults([]);
      return;
    }
    const found = await searchProductsAction({ query: value, limit: 20 });
    if (found.ok) setResults(found.data);
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
        onCreated={(product) => {
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
              pending={busy}
              onSubmit={async (newFills) => {
                const ok = await runWrite(
                  "increment",
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
              canSet={existing?.lineId != null}
              pending={busy}
              onSubmit={async (submission: QuantitySubmission) => {
                const ok =
                  submission.mode === "set" && existing?.lineId != null
                    ? await runWrite(
                        "set",
                        {
                          countLineId: existing.lineId,
                          sealedCaseQty: submission.cases,
                          sealedEachQty: submission.eaches,
                        },
                        (prev) => applySet(prev, product, location, submission),
                      )
                    : await runWrite(
                        "increment",
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
        <BarcodeScanner onDetected={onBarcode} onClose={() => setScannerOpen(false)} />
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
        <div className="flex h-tap-min items-center gap-2 rounded-md border border-input bg-card px-4">
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
            className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-md text-accent"
          >
            <ScanLine className="size-5" aria-hidden="true" />
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
                className="rounded-lg border border-border bg-card p-card-pad text-left"
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

      <div className="fixed inset-x-0 bottom-0 z-40 flex gap-3 border-t border-border bg-background p-bar-pad">
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
