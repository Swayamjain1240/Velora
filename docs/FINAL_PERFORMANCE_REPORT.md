# Velora — Final Performance Report (non-functional QA)

**Branch:** `test/non-functional-security-qa`
**Environment:** isolated test stack — API `NODE_ENV=test` on `127.0.0.1:4101`, disposable MongoDB replica set `velora_test` on `127.0.0.1:27019`, seeded synthetic clinic (`server/scripts/seed.js`), `EXTRACTION_PROVIDER=fake`. Never production.
**Driver:** `node qa/perf-load.js` (bounded: ≤40 concurrent connections, phases ≤60 s, ~5 min total)
**Raw evidence:** [qa/evidence/perf-load.json](../qa/evidence/perf-load.json)

## 1. Verdict

| Area | Verdict | Basis |
| --- | --- | --- |
| Performance targets | **BLOCKED (production acceptance)** | No approved SLO exists in `docs/`; results below are CHARACTERIZATION baselines on a developer Windows machine, not acceptance evidence. |
| Latency characterization | **PASSED (characterization)** | Every measured route answered 2xx with no error response. |
| Load (expected concurrency) | **PASSED (bounded)** | C=5 sustained 20 s: 2 124 requests, 105.97 rps, 0 5xx. |
| Stress ramp | **PASSED (bounded)** | C=1→40 shows graceful latency growth and a throughput plateau; 0 5xx. |
| Spike | **PASSED (bounded)** | 40-way read burst and a 20-way login storm: 0 5xx, no crash. |
| Soak | **PASSED (bounded, 60 s)** | 6 700 requests, RSS +3.3 MB, health RTT p95 19 ms — no growth trend in this window. |
| Scalability | **PARTIAL** | Single Node process, single MongoDB node: throughput plateaus ≈110 rps at ~1 CPU. Horizontal scaling is untested (no cluster, no load balancer). |
| Recovery after load | **PASSED** | Post-load p50 31.72 ms ≈ baseline p50 30.35 ms. |

> **No production performance claim is made.** Numbers are for one developer machine; a load balancer, replica-set secondaries, TLS termination, or a different Mongo host will change them.

## 2. Workload and data profile

- Sessions: three real API logins (MFA-enrolled) — `docsview@` (care coordinator, document journey), `plan.coordinator@` (plan/schedule journey), `admin@` (metrics/audit).
- Seeded data: 1 synthetic clinic, ~16 staff/patient identities, 3 document-journey episodes (draft/closed/patient-linked), plan journey episode, extraction journey episode, approved schedule journey with occurrences; probe runs added synthetic patients, one uploaded document and one extraction job.
- Reads exercised: `GET /api/auth/me`, `/api/patients?page=1&limit=20`, `/api/patients/:id`, `/api/episodes?page=1&limit=20`, `/api/dashboard`, `/api/today?patientId&date`, `/api/audit?page=1&limit=20`, `/api/metrics`, `/api/health`.
- Mutations exercised: `POST /api/patients` (create), document upload (`RAW` body + `X-Document-Filename`), extraction job create+run, per-route limiter pressure.
- Rate-limit hygiene: per-route Mongo limiter buckets are cleared on a 3 s interval during throughput phases so the numbers characterize the application + database, **not** refusals. The limiter is verified separately (SEC-2 and the dedicated limiter phase below) with buckets left intact.

## 3. Characterization (40 sequential requests per route unless noted)

| Operation | min | p50 | p90 | p95 | p99 | max | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Cold start → `/api/health` 200 | — | — | — | — | — | **2 015 ms** | 200 |
| Auth/session probe `/api/auth/me` | 9.37 | 14.91 | 18.44 | 21.08 | 25.78 | 25.78 | 200×40 |
| Paginated patient list (limit 20) | 25.58 | 30.35 | 34.66 | 36.93 | 40.69 | 40.69 | 200×40 |
| Single patient read | 15.60 | 30.29 | 34.04 | 35.03 | 35.21 | 35.21 | 200×40 |
| Episode list | 17.49 | 30.91 | 33.36 | 33.81 | 34.08 | 34.08 | 200×40 |
| Dashboard queues | 23.79 | 30.75 | 34.95 | 38.10 | 43.74 | 43.74 | 200×40 |
| Today view | 24.91 | 45.33 | 49.27 | 50.25 | 53.39 | 53.39 | 200×40 |
| Audit page | 12.87 | 30.26 | 35.03 | 36.91 | 45.41 | 45.41 | 200×40 |
| Metrics read | 13.66 | 30.22 | 34.31 | 34.98 | 36.05 | 36.05 | 200×40 |
| Health (anonymous baseline) | 1.12 | 15.17 | 15.84 | 16.04 | 16.38 | 16.38 | 200×40 |
| **Authentication verify (Argon2id, wrong password)** | — | **63.53** | — | 64.49 | — | 64.49 | 403×5 |
| **Mutation — patient create** | 47.23 | **61.65** | 63.47 | 63.82 | 63.82 | 63.82 | 201×10 |
| **Document upload** (451 B PDF, validate+inspect+encrypt+store) | — | — | — | — | — | **99.67 ms** | 201 |
| **Document download** | 44.54 | 46.47 | 48.22 | 50.98 | 50.98 | 50.98 | 200×10 |
| **AI fake-provider job (create → run → terminal state)** | — | — | — | — | — | **31 ms** (`state=needs_review`) | 200 |
| **Clinical approval transaction** | — | — | — | — | — | **BLOCKED-LIVE** | asserted by `plans.test.js` (approval invariants, 409 paths); a live probe would mutate the seeded journey state |

Cold start varied 1.57–2.33 s across runs (module load + env validation + Mongo connect + index init).

## 4. Bounded load, stress, spike and soak

| Phase | Concurrency | Duration | Requests | Throughput | p50 | p95 | p99 | 5xx |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline | 1 | 10.0 s | 375 | 37.5 rps | 28.77 | 41.10 | 47.71 | 0 |
| Expected load | 5 | 20.0 s | 2 124 | 105.97 rps | 46.55 | 71.36 | 87.99 | 0 |
| Stress ramp | 10 | 20.1 s | 2 361 | 117.48 rps | 83.03 | 130.38 | 160.10 | 0 |
| Stress ramp | 20 | 20.1 s | 2 192 | 108.92 rps | 177.70 | 297.27 | 351.98 | 0 |
| Saturation | 40 | 15.2 s | 1 772 | 116.72 rps | 327.57 | 571.68 | 652.05 | 0 |
| Spike (reads) | 40 | 5.2 s | 548 | 106.24 rps | 364.91 | 593.95 | 675.01 | 0 |
| Spike (logins, 20 parallel, distinct identities) | 20 | — | 20 | — | — | 221.92 | — | 0 |
| **Limiter under pressure** (150 hits, buckets NOT wiped) | 10 | 1.4 s | 150 | — | — | — | — | 0 |
| **Soak** (paginated page-cycle 1→10) | 5 | 60.9 s | 6 700 | 110.09 rps | 45.01 | 67.34 | — (max 117.10) | 0 |

**Saturation reading:** throughput plateaus at ≈110–117 rps while p95 grows 41 ms → 572 ms between C=1 and C=40 — the classic single-process queueing curve. No request failed; nothing was refused with 5xx. The saturation point is *queue latency*, not errors, which is the designed behaviour with the in-process limiter disabled under `NODE_ENV=test`.

**Limiter behaviour under pressure (PASS):** 150 rapid `GET /api/metrics` returned `200×119` + `429×31`, `GET /api/health` still 200 during the pressure, and the endpoint answered again after the window — controlled refusal, no crash, no 5xx. (Durable Mongo-backed limiter, per-user key.)

## 5. Resource use

| Sample | Value |
| --- | --- |
| API RSS during soak | 273.51 MB → 276.78 MB (**+3.3 MB** over 60.9 s) |
| API RSS during earlier 60 s soak (independent run) | 337.63 MB → 343.28 MB (+5.65 MB) |
| CPU during soak | 46.35 CPU-seconds over 60.9 s wall (≈0.76 core average) |
| Health round-trip during soak (1 Hz proxy for event-loop responsiveness) | p50 12 ms, p95 19 ms, no sample lost |
| Mongo connections | **NOT EXPOSED** by `/api/metrics` (gap, see §7) |
| Worker queue depth | **NOT EXPOSED** (gap) |
| Event-loop delay | **NOT EXPOSED** (gap; health RTT used as an out-of-process proxy) |

No connection leak, listener leak or unbounded growth was observed in the 60 s windows; a multi-hour soak was **NOT RUN** (bounded by the task's "keep traffic bounded" rule).

## 6. How to reproduce

```bash
npm run mongo:test-rs -w server                 # disposable replica set on 27019
# seed + start the isolated test API on 4101 (env in qa/lib/qaEnv.js)
node server/scripts/seed.js
QA_API_PID=<api pid> node qa/perf-load.js       # ~5 minutes, bounded
```

## 7. Observability gaps found by trying to measure (P3)

The following are missing from `/api/metrics`, so a production operator cannot see them; each is recorded in the defect log as a hardening item, not a functional defect:

1. `process.memoryUsage()` (RSS/heap) — measured here from the OS instead.
2. Event-loop delay histogram — proxied here by 1 Hz health RTT.
3. MongoDB connection-pool state (current/available/queued).
4. Worker/queue depth for extraction and reminder processing.
5. Per-route latency histograms (the metrics surface exposes counters).

## 8. Residual performance risk

- Single-process, single-Mongo-node topology: a CPU-bound route (Argon2id verify ≈63 ms, document inspect ≈100 ms) will queue behind sustained saturation; a real deployment needs multiple API instances or a worker split for CPU-heavy document work.
- MongoDB index/query plans were not profiled (`explain`) — p50 ≈30 ms per read on a tiny seeded dataset says nothing about a million-document collection.
- Client-side rendering timings (first load, route transition) were **NOT MEASURED** in this pass; the browser journeys are asserted functionally and for one-viewport layout (see the accessibility report), not for performance budgets.
