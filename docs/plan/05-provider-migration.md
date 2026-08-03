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
export MOONSHOT_API_KEY=sk-...        # your shell, not the repo, not a config file
export BIZSIM_LLM_PROVIDER=kimi       # added by this migration; defaults to anthropic
pnpm sim --new
```

Both keys can be present at once — that is what makes the hybrid in §3 and the A/B in §6 possible.

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

| Call | What it does | Anthropic today | Kimi | Why |
|---|---|---|---|---|
| `draft` | One shot, several thousand tokens of schema-constrained JSON, minutes of thinking | `claude-opus-5` | `kimi-k3` | The only Kimi tier documented with **json_schema** structured output, not just JSON mode. See §4.1 — this is the whole risk. |
| `adjudicate` | Rules on a player's challenge to an assumption | `claude-opus-5` | `kimi-k3` | Rules 1 and 6 are in code; the *ruling* is the model, and it is the thing most likely to regress into sycophancy. Do not cheapen it first. |
| `turn` | Interview reply: ~50 words and a CTA | `claude-opus-5` | `kimi-k2.6` | Short output, conversational judgement, thinking mode on. This is most of the call volume. |
| `advise` | Turn-loop advisor, already `effort: low`, 4k budget | `claude-opus-5` | `kimi-k2.6`, thinking off | The money guard in `advice.ts` catches the failure mode that matters, so a cheaper model is cheap here in both senses. |

### Rates

| Model | Input | Cached input | Output |
|---|---|---|---|
| `claude-opus-5` | $5.00 | $0.50 | $25.00 |
| `kimi-k3` | $3.00 | $0.30 | $15.00 |
| `kimi-k2.6` | $0.95 | $0.16 | $4.00 |
| `kimi-k2.5` | $0.60 | $0.15 | $3.00 |

K3 against Opus 5 is a 1.7× saving. K2.6 against Opus 5 is 5–6×. **The saving is in moving `turn` and
`advise`, not in moving `draft`** — which is convenient, because those are also the two calls where a schema
regression cannot hurt anything. Reasoning tokens bill as ordinary output on Kimi at the same rate, with no
separate thinking price, so the `thinkingTokens` split in the meter stays honest.

A hybrid is a legitimate destination, not a waypoint: `draft` and `adjudicate` on Anthropic, `turn` and
`advise` on Kimi, is most of the saving with none of the §4.1 risk. Ship that first and measure before
moving the other two.

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

1. **Record a baseline.** The meter exists and has never recorded a real session — every `spend` record in
   `.bizsim/` is a test fixture with zero tokens. One real `pnpm sim --new` on Anthropic, with the corrected
   rates, is the number everything else is measured against. Do this before writing any transport.
2. Fix `spend.ts` (§5): correct defaults, per-model rates.
3. **Extract a transport conformance suite.** The scripted-transport tests assert on behaviour above the
   interface; what does not exist is a suite that runs the same assertions against a *live* transport. This
   is also the missing live-call test noted in STATUS.md, and the migration is the reason to finally write it.
4. Build `KimiConceptTransport` on the `openai` SDK against `https://api.moonshot.ai/v1`.
5. Add `BIZSIM_LLM_PROVIDER`, per-call model resolution, and keep `BIZSIM_TURN_MODEL` / `BIZSIM_DRAFT_MODEL`
   working as overrides.
6. **The gate.** A provider does not become the default until it passes, on fixtures:
   - the single-object draft (§4.1) — no multi-stream drafts;
   - the §11.3 anti-sycophancy fixtures, where the *ruling* is the model's and only rules 1 and 6 are in code;
   - the `advice.ts` money guard — no figures the briefing does not contain;
   - the archetype-awareness cases: `volumeNoun` not silently becoming "covers", marketing correctly doing
     nothing for OCCUPANCY.

   Every one of these is a bug this project has already paid for once. A cheaper model that reintroduces any
   of them is not cheaper.
7. A/B on ~10 concepts. Compare cost, draft-validity rate, and adjudication behaviour — then decide between
   full migration and the hybrid in §3.

---

## 7. Standing risk

`04-risks-and-decisions.md` already lists **adjudication sycophancy** as "model behavior, not code; can
regress on any provider/model change", with "pinned model version" as the mitigation. This migration is the
exact event that risk was written about. Pin the Kimi model IDs, and treat a version bump the same as a
provider change: it goes through §6's gate.
