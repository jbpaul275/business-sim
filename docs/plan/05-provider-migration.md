# Provider migration — Anthropic → Kimi (Moonshot)

Written against the economics of shipping this as a paid game rather than a demo. At Opus-class rates the
model cost of one ideation session is a meaningful fraction of what a player would pay for the whole game,
and the four LLM calls are not equally responsible for that.

Prices below are per million tokens, checked August 2026. They go stale; `spend.ts` reads them from the
environment for exactly that reason.

---

## 1. The key

**There is no CLI command to add a key, for Anthropic or for anyone else, and there should not be.**
`conceptPathAvailable()` reads `ANTHROPIC_API_KEY` from the environment and the SDK resolves it the same way.
A command that stores a key puts it in a file, and the file ends up in the repo or in a cloud environment
where anyone with access can read it.

Kimi is the same shape:

```sh
pnpm install                       # the Kimi transport added `openai` as a dependency
export MOONSHOT_API_KEY=sk-...     # your shell, not the repo, not a config file
pnpm sim --new
```

That is the whole setup. `BIZSIM_LLM_PROVIDER` exists but is not needed: Kimi is used whenever its key is
present, and Anthropic is the fallback when it is not. Set it explicitly (`kimi` or `anthropic`) to force
one, which is what an A/B looks like — both keys exported, one variable moved.

---

## 2. The seam

`ConceptTransport` in `packages/llm/src/client.ts` is the whole migration surface:

```ts
export interface ConceptTransport {
  cancel?(): void;
  turn(system: string, messages: readonly InterviewMessage[]): Promise<TurnResult>;
  advise(system: string, messages: readonly InterviewMessage[]): Promise<AdviceResult>;
  adjudicate(system: string, input: string): Promise<Adjudication>;
  draft(system: string, messages: readonly InterviewMessage[]): Promise<ConceptDraft>;
  readonly usage: UsageTotal;
}
```

Nothing above this interface knows which provider is answering. `KimiConceptTransport` sits beside
`AnthropicConceptTransport` and every scripted-transport test in the suite keeps working unchanged.

The Moonshot API is OpenAI-compatible at `https://api.moonshot.ai/v1`, so the new transport is the `openai`
SDK pointed at a different `baseURL` — not a hand-rolled HTTP client.

`llm-never-sees-the-ledger` (§1.1) is unaffected: it forbids `packages/llm` → `packages/engine`, and a second
transport inside `packages/llm` does not touch that edge.

---

## 3. Model mapping

**Decided, then reversed the same day: everything on K3.** K2.6 took the turn default for half a day
(2026-08-03) once its parameter docs arrived, and failed its live gate in two sessions: one turn returned
double-encoded, one garbled twice in a row on the one-word input "oils", a first turn needed a silent
retry, and thinking latencies ran 23-60s against K3's 7-9s. Its thinking mode plus
`response_format.json_schema` is an unreliable pairing — the model's own docs carve thinking mode out of
other structured features. A 3-4x output saving that buys slower, less reliable turns is not a saving.

| Call | What it does | Model | Reasoning |
|---|---|---|---|
| `turn` | Interview reply: ~50 words and a CTA | `kimi-k3` | `reasoning_effort: low` |
| `advise` | Turn-loop advisor, 4k budget | `kimi-k3` | `reasoning_effort: low` |
| `narrate` | §11.5, one per quarter — the volume leader | `kimi-k3` | `reasoning_effort: low` |
| `adjudicate` | Rules on a player's challenge | `kimi-k3` | `reasoning_effort: low` |
| `draft` | Schema-constrained synthesis, the hardest call | `kimi-k3` | `reasoning_effort: high` |

K2.6 stays one variable away — `BIZSIM_TURN_MODEL=kimi-k2.6` — and everything its failures taught remains
in the transport: the per-model dialect, the double-encoding tolerance, the malformed-turn retry. The next
attempt should measure thinking *disabled* (`BIZSIM_TURN_EFFORT=low`), the configuration the failures never
tested. What the gate has now caught, in order: a fabricated range would have been caught by the money
guard; a schema refusal by the latch; and loose enforcement by Zod — each one a stub could not find.

**The two dialects.** K3 takes `reasoning_effort` (`low | high | max`, default `max` — never omitted) and
always thinks. K2.6/K2.5 take `thinking: {type: enabled | disabled}` and nothing else: their docs fix
`temperature`, `top_p`, `n` and both penalties, and **error on any other value** — which is why the
transport sends no sampling parameter to anyone. The dial is resolved per *model*, not per vendor, because
Moonshot ships both spellings at once.

**The effort collapse on K2.6 is binary and lands on `low`.** Our `low` tier is the answers-a-sentence tier
(advice, narration); thinking there is latency billed at the output rate, and the money guard catches the
failure that matters. `medium` and up think — the interview turn's judgement is the product.

**Adjudication deliberately did not move.** This file's own risk register says the ruling is the call most
likely to regress into sycophancy — "do not cheapen it first" — so it now rides the *draft* model on both
transports, and the turn default moving cheap cannot drag it down silently.

**The schema fallback moved into `complete()`.** It lived in `draft()` alone, survivable while K3 — the only
default — enforces schemas. K2.6's documented surface is JSON *mode*; if it refuses
`response_format.json_schema`, every call now degrades to the prompt-carried schema, and a latch stops the
session paying a doomed request per call to rediscover the refusal. Zod still validates everything
downstream: the guarantee weakens from "cannot be malformed" to "cannot pass unnoticed", never further.

**`BIZSIM_MODEL` still means everything.** The cheap-turn split is a default for the undecided; someone who
names a model gets it for every call.

Still unverified live, same as everything here: whether K2.6 honours `json_schema` or refuses it is exactly
what the latch exists to absorb, and the narration fabrication counter will say whether no-thinking K2.6 is
good enough — that is now a measured question, not an argued one.

### Rates

| Model | Input | Cached input | Output |
|---|---|---|---|
| `claude-opus-5` | $5.00 | $0.50 | $25.00 |
| `kimi-k3` | $3.00 | $0.30 | $15.00 |
| `kimi-k2.6` | $0.95 | $0.16 | $4.00 |
| `kimi-k2.5` | $0.60 | $0.15 | $3.00 |

K3 against Opus 5 is a flat 1.7× on rates, before effort. K2.6 against Opus 5 would be 5–6× and is the
remaining economy, gated on §3's two caveats.

Reasoning tokens bill as ordinary output on Kimi at the same rate, with no separate thinking price, so the
`thinkingTokens` split in the meter stays honest — it is a breakdown of `outputTokens`, exactly as it was on
the Anthropic side.

---

## 4. What actually breaks

### 4.1 Structured outputs — the headline risk

`AnthropicConceptTransport` passes `output_config.format` with a compiled JSON Schema, which constrains
decoding. That is not a strong hint. It is a grammar, and the comment on `zConceptDraft.stream` records why
it mattered: three consecutive live drafts came back with two revenue streams — the model apologising each
time — until the schema went from `z.array(zDraftStream)` to a single object. **A JSON array is a stronger
instruction than a paragraph, and a compiled grammar is stronger than either.**

Kimi K2.x offers **JSON mode** (`response_format: {type: 'json_object'}`): guaranteed-parseable JSON, no
schema enforcement. K3 documents schema-constrained structured output. So:

- `draft` and `adjudicate` go to K3, or stay on Anthropic.
- Wherever schema enforcement is absent, add a **validate-and-repair loop**: zod parse, and on failure
  re-ask once with the validation error quoted. `assertDraftShape` and `draftIssues` already exist and
  already do the second half of this.
- Do not assume the repair loop is free. It is a second full draft call at draft prices.

### 4.2 Thinking, and the `why` command

Anthropic: `thinking: {type: 'adaptive', display: 'summarized'}`, and the summary is what `why` prints.

Kimi: K2.x takes a `thinking` parameter through the SDK's `extra_body`; K3 always thinks and takes
`reasoning_effort` instead. Reasoning arrives as `reasoning_content` deltas on the stream rather than as
typed thinking blocks. `output_config.effort` maps to `reasoning_effort` on K3 and to thinking on/off on
K2.x. If reasoning text is not exposed on a given model, `why` degrades to "no reasoning available" — say
that rather than printing an invented rationale.

### 4.3 Refusals

`stop_reason === 'refusal'` has no OpenAI-shaped equivalent. `finish_reason` is `stop | length |
tool_calls | content_filter`. Map `content_filter` to the existing refusal path.

### 4.4 Usage and caching

| Anthropic | Kimi |
|---|---|
| `usage.cache_read_input_tokens` | `usage.prompt_tokens_details.cached_tokens` |
| `usage.output_tokens_details.thinking_tokens` | reasoning-token field, may be absent |
| explicit `cache_control` breakpoints | automatic prefix caching, nothing to set |

Caching being automatic is a simplification, not a loss — the ~5,100-token system prompt goes out on every
call and is exactly the prefix that gets cached.

### 4.5 Cancellation

The `undo`/Ctrl-C work from the last session hangs off `AbortController` and an `isCancellation()` that
recognises `AbortError` and `APIUserAbortError`. The `openai` SDK throws `APIUserAbortError` too. Verify
rather than assume, because a missed cancellation goes down the `TransientError` path and retries the call
the player just stopped.

---

## 5. `spend.ts` is quoting stale prices today

The defaults are `$15 / $1.50 / $75`. Those are Opus 4.x-era list rates; Opus 5 is `$5 / $0.50 / $25`. The
meter has been overstating by 3× for however long, on top of a comment that already warns these are "the
least trustworthy thing in this file". Fix the defaults and make the rates per-model, since after this
migration two models bill at different rates inside one session.

---

## 6. Order of work

**Built** (`packages/llm/src/kimi.ts`, `provider.ts`, `wire.ts`; 17 tests in `kimi.test.ts`):

- `KimiConceptTransport` on the `openai` SDK against `https://api.moonshot.ai/v1`, implementing all four
  calls plus `cancel()` and `usage`.
- `wire.ts` — the four compiled schemas, the prose fallback, the fence stripper and the unusable-turn check,
  shared by both transports so the shapes cannot drift between providers.
- `BIZSIM_LLM_PROVIDER` with resolution in one place (`provider.ts`). `conceptPathAvailable` used to name
  `ANTHROPIC_API_KEY` here and in two other files, which is how a provider switch becomes a bug hunt.
  Kimi wins when its key is present; Anthropic is the fallback; a forced provider is honoured even without
  its key, so a forced choice fails visibly rather than billing the other provider silently.
- `spend.ts` rates follow the resolved provider (§5).
- `isTransient` now reads the HTTP status structurally rather than by SDK class, so both providers retry
  alike without `client.ts` importing `openai`.

**Still to do:**

1. **Record a baseline.** The meter has never recorded a real session — every `spend` record in `.bizsim/`
   is a test fixture with zero tokens. One real `pnpm sim --new` per provider is the number that decides
   whether any of this was worth it.
2. **A live-call conformance test.** Every LLM path in this repo is verified against scripted or stubbed
   transports. Nothing has ever asserted that Moonshot accepts the request this transport builds — that
   `reasoning_effort` is spelled the way the docs say, that `response_format.json_schema` is honoured on K3
   rather than silently ignored, that `reasoning_content` arrives. Those are the four things a stub cannot
   check and the first real call will.
3. **The gate.** A provider does not become the default until it passes, on fixtures:
   - the single-object draft (§4.1) — no multi-stream drafts;
   - the §11.3 anti-sycophancy fixtures, where the *ruling* is the model's and only rules 1 and 6 are in code;
   - the `advice.ts` money guard — no figures the briefing does not contain;
   - the archetype-awareness cases: `volumeNoun` not silently becoming "covers", marketing correctly doing
     nothing for OCCUPANCY.

   Every one of these is a bug this project has already paid for once. A cheaper model that reintroduces any
   of them is not cheaper. Kimi is the default *ahead* of this gate, on the user's decision — which makes
   running it the next thing that happens, not an optional follow-up.
4. Verify K2.6's `thinking` parameter shape and measure it behind `BIZSIM_TURN_MODEL` (§3).

---

## 7. Routing and instrumentation

**Any OpenAI-compatible vendor is two environment variables.** `OpenAICompatibleTransport` reads a row out
of `VENDORS` — base URL, key variable, default model, whether `reasoning_effort` is understood — so trying a
new one is a row, not a transport:

```sh
export BIZSIM_LLM_PROVIDER=deepseek
export DEEPSEEK_API_KEY=sk-...
export BIZSIM_MODEL=deepseek-chat        # vendors with churning catalogues get no default
pnpm sim --new
```

Shipped rows: `kimi`, `deepseek`, `openrouter`, `groq`, `together`, `gemini`, `openai`, plus `anthropic` on
its own transport. `BIZSIM_BASE_URL` overrides any of them for a proxy or a region. With no
`BIZSIM_LLM_PROVIDER`, resolution walks a cheapest-first preference list and takes the first key it finds.

Routing is already per call type: `BIZSIM_TURN_MODEL` and `BIZSIM_DRAFT_MODEL` split the two jobs, which is
where the real economy is — `draft` is one call and `turn`/`advise` are twenty.

**Every call is recorded.** One `{"kind":"call"}` row per attempt in the session journal:

| Field | |
|---|---|
| `call` | `turn` / `draft` / `advise` / `adjudicate` |
| `provider`, `model`, `effort` | what answered, and at what reasoning tier |
| `ms` | wall clock — the half of a routing decision a price list cannot price |
| `inputTokens`, `cachedInputTokens`, `outputTokens`, `thinkingTokens` | |
| `costUsd`, `ratesKnown` | priced at the call against `MODEL_RATES`; `false` when the model is unpriced |
| `attempt`, `ok`, `failure` | so the failed attempts, which were billed, are counted |

Priced at the call, by model, because a session that drafts on one model and answers turns on another has
two prices in it. `pnpm sim --sessions` reports **cost per committed session by model** — not cost per
session, because a cheap model that gets abandoned half the time is not cheap, it just fails earlier.

Sessions recorded before this carry no call rows and report no cost, rather than being priced against
today's rates as if the model were known.

## 8. Running the A/B

Kimi against Anthropic, on the same concept. Both keys exported; one variable moves.

```sh
pnpm install                       # `openai` arrived with the Kimi transport
export MOONSHOT_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...

BIZSIM_LLM_PROVIDER=kimi      pnpm sim --new
BIZSIM_LLM_PROVIDER=anthropic pnpm sim --new

pnpm sim --sessions
```

Describe the **same business, in the same words**, both times, and take each run to the same place — either
both to a commit or both to the same abandonment. Session-to-session variance on one concept is larger than
the gap between two competent models, so a comparison across different ideas measures the ideas.

`--sessions` then prints:

```
HEAD TO HEAD, BY MODEL
  MODEL           RUNS  COMMIT  $/COMMIT  WAIT   RETRIED  FAILED  FABRICATED
  kimi-k3         3     100%    $0.43     85s    20%      20%     50% of 2 answers
  claude-opus-5   3     100%    $1.31     115s   0%       0%      0% of 6 answers
```

**Read the last three columns before the price one.** `$/COMMIT` is cost divided by runs that reached a
business, so a model pays for its own abandonments. `RETRIED` is attempts beyond the first — an empty turn,
a truncated draft, a refused schema — each of which was billed twice. `FABRICATED` is the §1.1 failure: the
advisor quoting money the ledger never produced, caught by the guard in `advice.ts` and re-asked. That is
the number that decides the comparison, because it is the one a player cannot catch themselves.

Three runs a side is the minimum worth looking at, and `--sessions` says so under the table when the corpus
is under ten.

## 9. Standing risk

`04-risks-and-decisions.md` already lists **adjudication sycophancy** as "model behavior, not code; can
regress on any provider/model change", with "pinned model version" as the mitigation. This migration is the
exact event that risk was written about. Pin the Kimi model IDs, and treat a version bump the same as a
provider change: it goes through §6's gate.
