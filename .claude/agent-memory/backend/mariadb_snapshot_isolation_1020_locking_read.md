---
name: mariadb-snapshot-isolation-1020-locking-read
description: MariaDB 11.8 FOR UPDATE after an earlier plain read in the same tx throws 1020 ER_CHECKREAD instead of seeing the winner; how the F7 duplicate-file claim handles it
metadata:
  type: project
---

On MariaDB 11.8 (innodb_snapshot_isolation on), a `SELECT ... FOR UPDATE` that touches a row committed by another tx AFTER this tx's consistent-read snapshot was taken fails with 1020 `ER_CHECKREAD`, not a current-read hit. A plain select would read the old snapshot and miss the row.

**Why:** F7 (invoice.live_file_sha256 unique claim, slice 7) names the race winner after a 1062 in `claimFileTx`. Verified by test 2026-11-07.

**How to apply:** after a 1062, use a locking read (`.for("update")`) AND wrap the tx in `withLockRetry` (retries 1020). In `markUploadConfirmed` the tx starts with a locking read (`lockJobForUpload`) so no snapshot exists and the winner is found first try; the 1020 path only appears if a plain read ran earlier in the tx. Test it by forcing a plain select first and accepting "holder found OR isTransientLockError", never "no holder". Also: do NOT use FOR UPDATE for the pre-insert lookup (`findLiveCopy` is plain) - a missed FOR UPDATE takes a gap lock and two concurrent upload inserts can deadlock. 1062 on a specific index: `isDuplicateKeyOnIndex` in lib/domain/db-errors.ts (message substring, through the cause chain).
