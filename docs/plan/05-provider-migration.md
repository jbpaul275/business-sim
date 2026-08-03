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

**Decided: `kimi-k3` for all four calls.** The economy comes from `reasoning_effort` rather than from a
second, cheaper model — see below.

| Call | What it does | Anthropic before | Kimi | Effort |
|---|---|---|---|---|
| `draft` | One shot, several thousand tokens of schema-constrained JSON, minutes of thinking | `claude-opus-5` | `kimi-k3` | `high` |
| `adjudicate` | Rules on a player's challenge to an assumption | `claude-opus-5` | `kimi-k3` | `low` |
| `turn` | Interview reply: ~50 words and a CTA | `claude-opus-5` | `kimi-k3` | `low` |
| `advise` | Turn-loop advisor, 4k budget | `claude-opus-5` | `kimi-k3` | `low` |

**Why not K2.6 for the turns.** It is three to four times cheaper on output and it is the obvious next
economy. Two things stop it being the default today. It offers JSON *mode* rather than schema-constrained
decoding (§4.1), and its thinking toggle is a Kimi-specific parameter passed through the SDK's `extra_body`
whose exact shape this repo has not verified against live documentation — and guessing a request shape is
how you ship a transport that silently reasons at the wrong tier on every call. `BIZSIM_TURN_MODEL=kimi-k2.6`
is one variable away once someone checks it, and the transport already degrades to the prompt-carried schema
if the model refuses `response_format.json_schema`.

**`reasoning_effort` is the dial that matters.** K3 always thinks and its default is `max` — the most
expensive setting on the most expensive dial. The transport never omits it, and there is a test asserting
that, because omitting it would have quietly undone the whole migration.

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

## 8. Standing risk

`04-risks-and-decisions.md` already lists **adjudication sycophancy** as "model behavior, not code; can
regress on any provider/model change", with "pinned model version" as the mitigation. This migration is the
exact event that risk was written about. Pin the Kimi model IDs, and treat a version bump the same as a
provider change: it goes through §6's gate.
