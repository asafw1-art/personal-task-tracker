# AI context review and service health

## Scope and decisions (2026-09-24)

- Existing Gemini and Vercel AI Gateway remain enabled by default. Asaf explicitly declined blocking an unverified provider before further investigation. No billing, new provider, model switch or credential change is included.
- Privacy verification and operational availability are separate facts. A working response does not establish acceptable processing terms. Unverified routes are labelled in the review and administrator panel.
- Public policy drafts and the Drive replacement decision are outside this release.

## Outbound data boundary

- The server authenticates the user and loads only owned cloud tasks using the user's bearer token, RLS and an owner predicate. It ignores client task snapshots, taxonomy and historical messages.
- Shared-with-me tasks and historical shared records are excluded. A user can still manually type third-party information; the application cannot guarantee detection of such text.
- Deterministic answers need no external provider. Other requests show the current message, selected fields and possible providers before transmission.
- Explicit P/W IDs select at most eight tasks. Prioritization selects up to eight active tasks by due date then priority. Other messages send no task context.
- Base context is ID/status/priority/due date; explicit IDs also include titles. Notes and up to eight steps per task require the details checkbox. Titles are limited to 200 characters and notes to 500.
- The SHA-256 preview digest includes owner, message, details choice, selected data and recipients/models. Any change requires a fresh preview. This is a consent binding, not an authentication token.
- No automatic conversation-history transmission. Follow-up questions must identify the relevant task or repeat needed context. Conversation records remain in the application; cancelling external transmission does not delete the user's saved message.
- Unsynced edits are not in the cloud context. More than 1,000 owned tasks fails explicitly rather than returning an incomplete deterministic count.

## Operator settings

- `ASSISTANT_DISABLED_PROVIDERS`: comma-separated `gemini,gateway`; empty preserves existing availability. Checks apply again at the outbound and fallback boundary. A Vercel environment change requires deployment.
- `ASSISTANT_GEMINI_REVIEWED_MODEL` / `ASSISTANT_GATEWAY_REVIEWED_MODEL`: optional exact model IDs, set only after documented review of the actual account, route and processing terms. These flags do not activate billing or verify terms themselves. Review again on account, route, terms or model changes.
- No new environment values are required for this release.

## Monitoring and limits

- Apply `supabase/add-service-health.sql` before release. Production migration was approved and executed on 2026-09-24; observed checks: RLS=true, anonymous read=false, client insert=false, client RPC execution=false.
- `service_health` stores only latest operational metadata per service, not prompts, tasks, provider error bodies, keys or user identities. Server-only RPC writes; administrator-only RLS reads.
- AI health comes from real requests or explicit synthetic checks. Merely having keys configured is not a successful health check. Observations older than 24 hours become unknown.
- Database health uses a bounded read. Drive health reflects stored connection/backup records, not a new live Google request. Scheduler health records actual cron runs; this release does not change their schedule.
- AI probe is admin-only, synthetic, and checks the most recent observation to avoid ordinary repeats within one minute. It is not a globally atomic rate limiter. It uses the existing account quota; no paid plan is enabled.
- The administrator panel polls once per minute while visible and on window focus. Problems enter the existing bell centre; there is no email, push service or always-on external watchdog. With the app closed, notifications are seen at next use.
- Incident IDs remain stable during an unchanged incident and renew after observed recovery. Last-success time is retained after failures. Out-of-order writes are ignored.
- Monitoring failure is visible but does not block approved AI calls. Service-role outages may prevent persistent incident recording.

## Verification / rollout

- Completed acceptance evidence: `ai-privacy-health-acceptance-2026-09-24.md`. Production application release `c49ca75`; review, cancellation, approved synthetic reply, persistence and observed service-health recording verified.
- `node scripts/test-assistant-privacy.mjs`: mocked auth, ownership, request limits, exact preview approval, changed context, details opt-in, fallback controls, local answers, safe errors and admin isolation.
- `node scripts/test-service-health-sql.mjs <pglite-dist-index-path>`: isolated database, repeatable migration, RLS and server-only writes, incident lifecycle and observation ordering.
- `npm run lint` and `npm run build` are required.
- `node scripts/serve-privacy-qa.mjs` serves synthetic component fixtures only, at port 4174. This is not the live application or an interaction test. Visual checks covered 390px mobile and 1366px desktop, light/dark; no page horizontal overflow observed.
- Production acceptance: authenticated administrator panel, unknown vs healthy distinction, review/cancel and synthetic confirmation without personal task data, and bell navigation. Record final deployment evidence separately in the task log.
- Rollback: redeploy the prior application build; the additive metadata table can remain. Do not delete task data or drop the table as an automatic rollback step. A rollback also restores the previous broader AI context behaviour, so evaluate privacy impact first.
