# Architecture and safety boundary

```mermaid
flowchart LR
  Schedule[Explicit local timer / finite tick] --> Admission[Atomic admission and overlap skip]
  Admission --> DB[(SQLite jobs / runs / attempts)]
  Admission -->|accepted only| WF[Local dispatch: conditional activation]
  WF --> DB
  UI[Mobile viewer] --> API[Node loopback authenticated API]
  API --> DB
  W[WSL serial poller / profile] -->|outbound claim + heartbeat + complete| API
  W --> CLI[Codex CLI / Pi CLI + existing connector]
```

No dedicated agent framework, no automatic tool execution, no model-approved actions. Both current profiles require the WSL executor. An agent graph (including a future LangGraph Runner) is separate from scheduling/leases/admission/auth.

## State and concurrency

- Job = immutable task + finite schedule. A run is one `(job_id, slot)` occurrence. An attempt is one lease token. Small output artifacts live in the run result field; no separate artifact service.
- Due slots are deterministic and unique. Atomic admission persists starting before activation. Same-job starting/queued/running or unacknowledged capacity reservations cause a skipped record, and no new activation. Only the current slot is considered; missed slots are never caught up. Skip records are bounded by maxRuns=10. The saved starting row is the durable outbox. Startup recovery activates only existing pending rows; it does not generate new occurrences. Cancelled, disabled or claimed runs cannot be activated. Scheduling defaults to disabled; only explicit local configuration starts a timer.
- Claim is one conditional SQL UPDATE with model and auth-group occupancy checks. SQLite serializes the mutation. Owner isolation is part of every operation. Claims also enforce a per-owner 40-attempt/day budget and one active reservation per worker id.
- Lease is 20 seconds with 5-second heartbeat; server execution deadline is 60 seconds after `issued_at`. Before sending claim, the worker records its Linux monotonic time. It maps `(deadline - issued_at)` onto that pre-request anchor, subtracting the entire request/response/preparation delay without comparing host wall clocks. An expired response never launches inference. The independent Linux `deadline-guard.mjs` receives the **same absolute monotonic deadline**, rechecks it before spawning and kills its entire process group at expiry, even if the polling parent is killed. Its startup delay does not reset a relative timeout. Reclaim waits until **server deadline + 3 seconds**. This margin is additional cleanup grace, not the fix for network delay. Poller and guard use the same host's CLOCK_MONOTONIC; bounded normal clock-rate drift/kernel scheduling is assumed. Host suspension/uninterruptible processes remain outside a strict remote-processing guarantee.
- Claims require protocol `absolute-deadline-v1`, and responses without valid `issued_at/deadline` fail closed. Stop old worker binaries before updating the control-plane/worker pair; legacy requests are rejected rather than allowed to use the old relative-timeout contract.
- Completion requires owner + worker + token + live lease/deadline. Equal duplicate reports are harmless; conflicting/old-token reports are rejected. A provider failure is terminal, so it does not silently consume another paid attempt. Only abandoned lease attempts are reacquired, up to 2 attempts total. This is at-least-once external inference, not exactly once: a completed remote inference whose acknowledgement is lost can consume quota twice.
- Cancel changes the visible state immediately, but **does not release capacity**. A trusted worker reports after its CLI closes, releasing the cancelled reservation without publishing output. Otherwise the reservation remains until deadline + grace. Disable atomically prevents further slots and cancels existing queued/running ones.
- Activation checks `starting AND attempt=0 AND token IS NULL` and the enabled job at UPDATE time. Database errors propagate and preserve starting for recovery. No provider or TAKT process is launched by dispatch. HTTP shutdown drains request/timer work before closing SQLite and never cancels an independent watch execution.
- Model/group upper limits accept integers 0..16. Zero stops new claims. Limits are global within this SQLite database, and group IDs must reflect actual shared auth/subscription identity. Different provider/model profiles sharing one account can share a group.
- A machine pause/uninterruptible kernel process or provider-side processing after HTTP disconnect cannot be proven stopped by client leases. Capacity is a local execution bound, not a guarantee about remote vendor processing. Before production, use a dedicated managed worker process boundary and monitor orphan processes. Do not widen permissions or use external tools in these profiles.

## CLI boundary

Fixed executable and argv; job text only on stdin. No shell string, arbitrary executable/path/URL API, or implicit model fallback. Prompt max 4 KiB, persisted result max 16 KiB, combined child stdout/stderr max 256 KiB, runtime 60 seconds. JSON event completion is validated; tool events/error/incomplete output are rejected. No provider diagnostics/stderr are stored because they may contain secrets. CLI failure messages are normalized.

Codex ignores user config/rules, disables project instructions, shell, unified exec, patch tool, skills, hooks, apps, delegation and web search, uses read-only sandbox and forced ChatGPT auth. Pi disables all tools, context files, automatic extensions/skills/templates/themes, session saving and startup networking, and explicitly loads only the existing trusted Devin connector. No credentials are generated, copied or read by this app; CLI libraries own authentication. Environment is allowlisted; worker token and API-key overrides are excluded. Both run in an empty throwaway directory.

Model connections necessarily send the explicitly supplied task text to the selected model service. No other user data is intentionally read or posted. CLI implementations may write their own auth refresh, catalog/cache or operational logs. Empty throwaway directories are removed after execution. Provider outputs are untrusted text (`textContent` in UI), never approvals or executable instructions. UI logout and token replacement abort the old session's requests, clear its DOM immediately, and reject late success/error/body results using a session-generation check; abort alone is not relied upon.

The CLI versions and flags are a compatibility boundary: keep versions validated before upgrades. The existing third-party `pi-devin-connector` encapsulates reverse-engineered provider details; this repo does not fork or maintain that protocol. Replacing it with the official Devin CLI is possible behind `invoke` but requires validating tools-off/config isolation first. No unofficial new connector was installed.

## Deferred scope and data

private-knowledge commit reading, INDEX interpretation, source citations, Git updates, code edits, external messaging, automatic approval and richer task graphs are out of this narrowed first acceptance. private-knowledge and development-memory were not changed or merged. Prompts, schedule and results are private SQLite data; no analytics or CDN caching is added. Retention/export/deletion policy remains a production decision. There is no payment/account administration code, deployment command in CI, or enabled production cron.

## Official references checked 2026-10-01

- [Codex non-interactive mode](https://developers.openai.com/codex/non-interactive-mode)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [Codex configuration](https://developers.openai.com/codex/config-reference/)
- [Devin CLI](https://docs.devin.ai/cli) and [configuration](https://docs.devin.ai/cli/reference/configuration/config-file)
- [Cloudflare Workflows local development](https://developers.cloudflare.com/workflows/build/local-development/)

The Cloudflare reference above records research at the dated previous implementation. Current operations use Node 24 and SQLite only; see [local setup and manual migration](local-control.md). Existing acceptance measurements remain historical and are not local SQLite measurements.
