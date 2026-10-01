# V1 acceptance and measurements

Measured 2026-10-01 in Ubuntu WSL, Node 24.20.0. Original main was `85da744` (`README.md` only); work is on `feat/knowledge-summary-mvp`. Nothing was merged or deployed. Production cron is empty/disabled.

## Evidence

| Check | Result |
|---|---|
| Codex CLI 0.159.0 / ChatGPT login / GPT-6 Luna | Real synthetic `2+3` call returned `5` |
| Pi 0.87.1 + installed pi-devin-connector 0.1.2 / SWE-2 Medium | Real synthetic `2+3` call returned `5` |
| Manual finite schedule simulation, both profiles, 2 occurrences each | 4/4 real provider results stored as `succeeded` in local D1 before review fixes; this used past tick requests and direct `once()` calls |
| Duplicate scheduler deliveries | No duplicate provider runs; 4 unique Workflows for 4 admitted runs |
| Overlap skip, queued/starting/running, outbox recovery, no catchup | Automated SQLite tests passed |
| Shared model/auth-group limits across owners and competing workers | 20 competing claims stayed within limits; 0 pauses; negative rejected |
| Lease expiry, worker restart, old completion, attempt limit | Automated SQLite tests passed; conservative deadline + grace reservation |
| Provider failure, subprocess timeout/output cap/cancel | Actual local subprocess tests passed; provider error path covered |
| Authentication and other-owner isolation | Unit tests and real local HTTP checks passed |
| D1 local migrations | Both migrations applied successfully with `--local` |
| Workflows local runtime | Admission + actual Workflow step + D1 activation + status verified under Wrangler 4.145.0 |
| Mobile UI | Existing Chromium, 390×844 viewport: authenticated results, no horizontal overflow/JS errors, logout clears results |
| Original TypeScript / tests / dry build | Passed; 16 tests before review fixes; no deployment |

Raw final measurement: [live-measurement.json](evidence/live-measurement.json). GNU time: [worker-time.txt](evidence/worker-time.txt). All inputs and outputs are synthetic. No private-knowledge documents were sent to either model. The sample private-knowledge PR was not merged; development-memory and rejected personal instruction files were not read by this task.

The original actual inference path is **Codex CLI and Pi CLI**, not a mocked provider. CI intentionally replaces inference with a fixture and uses real local D1/Workflows. Manual-tick inference evidence is separate from the real-time scheduler/poller check described below; neither establishes production Cloudflare cron operation.

## Review corrections and separate regression evidence

Independent review found a delayed-claim timeout gap, an in-flight UI logout/token-switch race, and terminal Workflow failures leaving starts blocked. All three were corrected in this PR:

- Shared absolute monotonic deadline: claim round-trip/preparation and supervisor startup consume the original server budget. Local and server wall-clock offsets are never compared. Expired responses do not launch a CLI. A Linux process test delays preparation, SIGKILLs the poller, and verifies that the independent guard still terminates its synthetic child by the original deadline. Old worker claim protocol is rejected.
- UI session abort plus generation fencing: deferred fetch/body completion after logout or token replacement cannot restore old private results or error text. Both immediate DOM clearing and stale-response rejection are tested.
- Terminal activation Workflow reconciliation: only unclaimed starts transition to `failed/workflow_failed`; already-running work is unchanged, unknown status stays retryable, and future occurrences can proceed. No unbounded Workflow restart loop is added.

The regression suite has 24 tests. `scripts/realtime-check.ts` additionally starts the **actual polling process** and uses a wall-clock timer at 60-second intervals for exactly two occurrences, through local D1 admission, actual Workflows and the independent subprocess guard to result storage. The CLI is explicitly a fixture; this test makes **no additional real-model call**. See [real-time evidence](evidence/realtime-measurement.json). CI runs this finite real-time path as well as the shorter manual-tick integration check. The original real-model measurements below were not rerun or relabelled as post-fix inference measurements.

## What the local test measured

Final live test: 4 executions, 2 providers × 2 scheduled occurrences. Each scheduler occurrence was delivered twice. Each accepted run creates one Workflow with one activation step. The scheduler skips overlaps before creating a new Workflow.

| Metric | Four-run batch | Notes |
|---|---:|---|
| Logical Workflow steps | 4 | 1 per admitted run; local emulator, not invoice evidence |
| JS harness elapsed | 17.50 s | Includes inference/network waits |
| GNU time elapsed | 16.55 s | Independent process timer; WSL timers differ, do not treat as billing precision |
| WSL user + system CPU | 2.12 + 1.30 = 3.42 s | Test harness and reaped CLI child tree; excludes separately running workerd and remote inference |
| Peak process RSS | 208,244 KiB | GNU time maximum, not aggregate resident footprint |
| Control-plane HTTP requests | 28 | Includes setup, duplicates, status inspection and results reading |
| HTTP request / response bodies | 1,204 / 9,308 bytes | Excludes headers/TLS and model-service traffic |
| D1 SQL statements | 59 | 55 HTTP path + 4 Workflow activation statements |
| D1 reported rows read / written | 537 / 72 | 533/64 HTTP + 4/8 Workflow; emulator metadata, indexes/triggers affect counts |
| API handler elapsed sum | 547 ms | Includes D1 waits; **not CPU time** |
| Workflow step elapsed sum | 50 ms | Includes D1 waits; **not CPU time** |
| Result text | 4 bytes | Four single-character answers; not representative of useful summaries |

After all local development trials, the local D1 data file was 69,632 bytes. This is the whole database containing previous trials, schemas and indexes, **not** a per-run storage measurement. Prompts/results and metadata grow with retained history; SQLite page/WAL overhead is not captured by multiplying result bytes.

Cloudflare billable CPU, production D1 metadata, production request billing, and end-to-end deployed latency were **not measured**. Local elapsed time and WSL CPU cannot substitute for Cloudflare CPU. A tiny deployed trial needs separate approval for account/authentication, resource creation, cost and deploy scope. No paid-plan hard stop or spend guarantee is implied.

## 30-day scenario model (not an enabled schedule)

| Workload | Runs / 30 days | Logical steps at current 1 step/run |
|---|---:|---:|
| AI secretary, every 10 minutes | 4,320 | 4,320 |
| Companion activity, every 10 minutes | 4,320 | 4,320 |
| One additional hourly task | 720 | 720 |
| One additional daily task | 30 | 30 |
| Total | **9,390** | **9,390** |
| Plus one child task per frequent-task run | +8,640 | +8,640 (18,030 total) |

These are admitted runs with no skips, not a throughput commitment. If a frequent job is still active at its next tick, that occurrence is skipped and never caught up. Parallelism itself does not multiply charges: sum the number and work of actual tasks, including children. Child tasks are a projection only; V1 does not spawn them.

Illustrative linear scaling of this **tiny synthetic batch**, not a price estimate: `measured_batch × runs / 4`. At 9,390 runs this gives about 65,730 HTTP requests, 138,503 SQL statements, 1.26 million reported rows read, 169,020 rows written, 8,028 WSL CPU seconds (~2.23 h), and 9,390 bytes of answer text. Real secretary/companion contexts and answers can be orders of magnitude larger, and read cost grows with retained rows. Measure representative approved inputs before using these figures for capacity/cost decisions.

Idle polling is separate and can dominate request count. Two always-on workers polling every 30 seconds add up to **172,800 idle claim requests / 30 days** (about two SQL statements each), before active heartbeats, dashboard refresh, retries or extra schedulers. Poll frequency is configurable; increase it or stop idle workers when appropriate. A 60-second run adds roughly 11 heartbeat calls at 5-second intervals. These are not Workflow steps. Skipped ticks still incur admission checks, even though they create no new Workflow or model call.

V1 intentionally keeps finite `maxRuns <= 10`, `maxJobs <= 10/owner`, and `40 attempts/day/owner`. Therefore this monthly scenario **cannot be enabled by the delivered defaults**. Indefinite scheduling, retained-history cleanup and tuning these safety budgets belong to the production decision, alongside Cloudflare vs self-host selection. No step-budget accounting engine was added.

## Remaining decisions

- User review of draft PR; no CodeRabbit or auto-merge configured.
- Cloudflare versus self-host after production-sized measurements; LangGraph remains optional within the Runner boundary.
- Production account/resources/HTTPS/authentication, actual schedule times, model/account-group limits, quota and data-retention choices.
- Existing CLI credentials and subscription availability can expire/change; the app fails clearly instead of switching to a paid API key.
