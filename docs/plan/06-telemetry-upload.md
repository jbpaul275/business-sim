# Session telemetry — schema and the opt-in path

Sessions were local JSONL and nothing else: `.bizsim/sessions/*.jsonl`, gitignored, on whatever machine ran
them. That is right for a dev tool and does not survive shipping — once this is a game, those files are on
the *player's* device, and nothing is collected at all.

This is the collection path. It is off by default and stays off until somebody says otherwise.

---

## 1. What is being protected

Not the numbers. The text.

These files contain business ideas someone typed in confidence and a model's reasoning about them. Someone
who agrees to help compare two models on cost has **not** agreed to hand over their business plan, and the
only way that distinction survives a growing event schema is if it is enforced rather than remembered.

So there are two opt-ins, and the second is never implied by the first:

```sh
export BIZSIM_TELEMETRY=on              # the numbers: tokens, timings, cost, model, outcome
export BIZSIM_TELEMETRY_TRANSCRIPTS=on  # additionally the words
export SUPABASE_URL=https://<project>.supabase.co
export SUPABASE_PUBLISHABLE_KEY=<publishable key>

pnpm sim --upload
```

Consent is read strictly: `false`, `0`, `off` and the empty string all mean no. A truthiness check would
have read `BIZSIM_TELEMETRY=false` as yes, and that is a real way people turn things off.

Without `SUPABASE_URL` nothing is sent anywhere. **There is no default endpoint** — a checkout someone
cloned to read the code uploads nothing, to no one.

---

## 2. Schema

`supabase/migrations/0001_telemetry.sql`. Three tables.

**`sessions`** — one row per run. Build, timestamps, outcome, archetype, starting capital, turn and quarter
counts, and the four quality signals (`repair_rounds`, `questions_asked`, `fabricated_figures`,
`cancelled`). No free text: the *archetype* is here because it is one of six fixed strings and is the
analytic dimension; the business *name* is something a person wrote and is not.

**`calls`** — one row per model call, including the attempts that failed. Provider, model, effort tier,
`ms`, four token counts, `cost_usd`, `rates_known`, `attempt`, `ok`, `failure`. Keyed `(session_id, seq)`.

**`transcripts`** — `(session_id, seq, kind, payload jsonb)`. The content tier. `jsonb` rather than columns
because the journal's shape changes with the game, and a migration per event kind guarantees the schema lags
what is being recorded.

Two tables with two consent decisions rather than one table with a flag. A flag on a row is a thing that
gets forgotten in a `WHERE` clause.

### Row-level security

The publishable key ships inside the game, so treat it as public. Policies grant `anon` **insert and
nothing else** on all three tables — no select, no update, no delete. The worst a leaked key does is add
rows: it cannot read one player's session back, and it cannot alter or remove anyone's. Analysis runs on the
service role, server-side.

The absence of a select policy *is* the security property. Adding one for convenience during analysis would
quietly make every session readable by anyone holding the shipped key.

---

## 3. Redaction

`packages/sim-cli/src/upload.ts`, and it is the part with the tests that matter.

The classifier is a **deny-list of content kinds, with unrecognised kinds treated as content**. An
allow-list of safe kinds would default a newly-added event to uploadable, and the first one carrying text
would leak silently. This way, forgetting to classify something withholds it.

The load-bearing test serialises the whole metrics payload and asserts the player's own words do not appear
anywhere in it — searched rather than checked field by field, because a field-by-field check only covers the
fields someone remembered, and the failure being guarded against is the one nobody remembered. Both
directions were verified by breaking the guard and watching the tests go red.

**No user identifier.** The session id is derived from the journal filename, so a re-run of `--upload` is
idempotent all the way down to the primary key. Deliberately *not* a per-install id — a stable identifier
across sessions is a tracking decision, and comparing two models does not need one.

---

## 4. Sizing

A session is 30–60 events. Call rows are small; the outlier is the `draft` event, which embeds the entire
`ConceptDraft` at 4–8 KB and lives in the transcript tier.

- **Metrics only**: roughly 2–5 KB per session. 10k sessions/month ≈ 30 MB/mo.
- **With transcripts**: roughly 20–60 KB per session. 10k sessions/month ≈ 300–600 MB/mo, most of it the
  draft blob.

Which is the argument for the two tiers being two tables: the cheap one is the one that answers the cost
question, and it is an order of magnitude smaller than the one that does not.

---

## 5. The third consent surface: the per-session QA share

The ambient tiers above are *standing* grants, and standing grants have a coverage problem: the player who
declines them is exactly the player whose bug reports never arrive. So there is a third surface, narrower
than both, built for the exit prompt and the end-of-game wrap:

**"Share this run with QA?"** — asked once, at the end of a run, only when an endpoint is configured. On
approval, `shareRun()` uploads that one session with the transcript tier **forced on**, plus the player's
optional note to a `feedback` table (`0002_feedback.sql`, same insert-only RLS). It deliberately ignores
`BIZSIM_TELEMETRY*`: the explicit approval *is* the consent, and it is better consent than any standing
flag — per-run, freshly given, and fully informed, because the player can see everything the run contains.
Nothing about it widens any future session.

Three properties worth naming:

- **The exit path stays fast.** No endpoint, no journal, or a piped transcript means the question is never
  asked. Decline is one keypress. In the web shell the affordance is a quiet link plus a spot on the wrap
  banner, never a modal in the way of leaving.
- **The reference id is the deletion handle.** After sharing, the player is shown the session id and told
  to keep it. Because ids are content-derived (CLI) or per-session random (web) and there is no user
  identifier, "delete run `dcda1d0a…`" is a request support can honour without ever being able to *find* a
  player's other runs — deletion works precisely because lookup doesn't.
- **A shared run is a reproduction, not a story.** Journals now carry the `actions` event — each quarter's
  decisions with Money as exact cents strings — alongside the market seed. `actions` is classified as
  content (players type names into actions), so it travels only under the transcript tier or a share.

This reframes the signup question too: with a per-run share door, the account-creation prompt should ask
for the **metrics tier only** — "numbers, never your words" — and standing transcript consent should not
be offered at all. Transcripts flow through exactly one door, always deliberately.

## 6. Not done

- **The migration has not been applied** (0001 or 0002). The SQL is written; pointing it at a live project
  is a decision about a real database and is not one to take on someone's behalf.
- **No signup/account flow exists yet**, so the metrics-tier opt-in is still environment variables in the
  CLI and absent in the web shell. The share prompt is the consent screen that *does* exist.
- **Deletion is a handle, not yet a process.** The reference id makes the request expressible; someone
  still has to run the `delete` on the service role, and there is no TTL on the transcript tier.
