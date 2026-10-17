# Velora — Final Recovery Report (non-functional QA pass)

**Environment:** isolated test stack — disposable MongoDB replica set `velora_test` on `127.0.0.1:27019`, temporary private storage root outside the repository, throwaway keys. Synthetic data only; no production system or snapshot was involved.
**Commands:** `node server/scripts/restore-drill.js`, `node server/scripts/reconcile-documents.js` (dry run, then `--apply --operator`)
**Raw output:** [qa/evidence/restore-drill.txt](../qa/evidence/restore-drill.txt), [qa/evidence/reconcile-dry-run.txt](../qa/evidence/reconcile-dry-run.txt), [qa/evidence/reconcile-apply.txt](../qa/evidence/reconcile-apply.txt)

## 1. Verdict

| Area | Verdict |
| --- | --- |
| Isolated logical restore of rows, indexes and encrypted objects | **PASSED** |
| Verification by reading the restored copy back (checksums, index shape, decryption) | **PASSED** |
| Reconciliation detects drift and repairs only with an operator attribution | **PASSED** (live repair performed on the disposable root, then a clean re-check) |
| Backup *coverage* of every asset that must travel together | **PASSED for this topology** (see §3) |
| RPO / RTO bounding, scheduled backup, provider snapshot, cross-region or point-in-time restore | **NOT PROVEN — owner decision** (no backup schedule exists) |
| Live failure injection against shared infrastructure | **PARTIAL** — real outages were not induced on a shared local stack; the suite asserts them instead (§5) |

## 2. Restore drill result (synthetic volume)

```
PASS  content checksums identical            (per-collection sha256, 0 mismatches)
PASS  indexes identical                      (name/key/uniqueness/partial filter/TTL per collection)
PASS  object store bytes identical           (8 encrypted objects, 5 536 bytes -> 5 536 restored)
PASS  restored documents decrypt and match   (no ready document present; row/object checks still applied)
PASS  source unchanged by the drill          (read-only)
RESULT: PASSED
collections 49 · rows 849 · dump 131 ms · restore 3 705 ms · objects copy 21 ms · verify 206 ms
target: velora_restore_drill_20261017112830   (isolated, drill-suffixed, dropped at the end)
```

The command's own limitations are quoted in its output and are accurate: it is a **logical, same-host** restore driven by the MongoDB driver (no `mongodump`/`mongorestore`, no provider snapshot), the document key is read from configuration as a real restore would, and no cross-region or point-in-time recovery was exercised. The millisecond timings are **not** a production RTO.

## 3. Backup coverage of the assets that must travel together

| Asset | Covered by the drill? | Evidence |
| --- | --- | --- |
| MongoDB rows (all 49 collections) | ✅ | 849 rows copied; per-collection sha256 identical |
| MongoDB indexes / configuration | ✅ | index name/key/uniqueness/partial-filter/TTL compared per collection |
| Encrypted document objects | ✅ | 8 objects, byte-for-byte identical |
| Encryption key (documents, MFA, session pepper, export key) | ✅ present as a **required** input | the drill reads `DOCUMENT_ENCRYPTION_KEY` from configuration — a restore without it yields unreadable objects, which is the documented dependency |
| Application configuration | ✅ | validated env (`zod`) is part of the deployment artifact; the drill runs with the same loader and fails closed on an invalid config |
| Job state (extraction jobs, retention runs, delivery attempts, reminders) | ✅ | these are MongoDB collections and therefore included in the row copy and checksums |
| Privacy export artifacts | ✅ (storage root) | export artifacts live under the same storage root as document objects; covered by the object copy |
| Scheduled backup job, retention schedule, off-host copy | ❌ **does not exist** | owner decision; RPO is therefore unbounded |

## 4. Reconciliation (drift detection and repair)

```text
dry run : missing 0 · unreadable 0 · integrity mismatches 0 · orphan objects 8
apply   : APPLIED by qa.nonfunctional@synthetic.invalid - 0 document(s) failed,
          8 orphan object(s) removed, all audited
re-check: missing 0 · unreadable 0 · integrity mismatches 0 · orphan objects 0
```

- The 8 orphans were **residue of the QA runs themselves** (documents written by the integration suite and by the upload probes whose metadata row was dropped when the suite reset the database). Detecting them is exactly the intended behaviour: the command reports drift, repairs nothing without `--apply --operator`, and never deletes a metadata row.
- The repair path is additionally asserted by `server/tests/integration/reconcile.test.js`, which deliberately corrupts a restored-equivalent state (lost object, tampered object, orphan) and drives `reconcile()`.

## 5. Resilience evidence asserted by the integration suite (not by killing shared infrastructure)

| Failure | Asserted behaviour | Evidence |
| --- | --- | --- |
| MongoDB / dependency unreachable | requests answer **retryable `503 SERVICE_UNAVAILABLE`** (never a misleading 500); readiness fails closed | `server/tests/integration/health.test.js:147,157` |
| Storage root unusable | readiness fails closed and names the dependency | `health.test.js:84` |
| Draining / shutdown | readiness 503 while draining, liveness unaffected, recovers afterwards | `health.test.js:62` |
| Parser worker stall | parent-side timeout terminates the worker and records `PARSER_TIMEOUT` (quarantine), never a partial accept | `documents.test.js:318` |
| Ciphertext tampering / missing object | download fails closed instead of returning corrupt bytes | `documents.test.js:439` |
| Duplicate request / retry | idempotent retry returns the same job instead of a second one | `extractions.test.js:558` |
| Repeated approval | idempotent retry; the transaction keeps exactly one current approved version | `plans.test.js:776` |
| Document/index drift | reconciliation reports and repairs with operator attribution | `reconcile.test.js` |
| Provider absent | extraction fails closed with a stable "not enabled" code; manual plan workflow still works | `extractions.test.js`, CI job step |

These are suite-level assertions on a real replica set, not live outages: **no live chaos was run against the shared local stack**, and the resilience of a multi-instance or proxied deployment was not exercised.

## 6. Residual recovery risk

1. **No scheduled backup exists**, so there is no RPO/RTO to test against — the single most important owner decision for real use (P1 for production readiness).
2. **Key management**: the document/MFA/export keys must travel with the backup; losing them makes the objects unreadable. Rotation exists (`npm run keys:reseal -w server`) and is proven by tests, but operational key custody is a deployment decision.
3. **Same-host logical restore** does not prove durability against host loss, and the drill cannot detect silent data loss between backups.
4. **Deletion requests are evidence-only** in this product (no real destructive deletion); retention holds are modelled and tested, but a real delete/erase path remains out of scope by design.
