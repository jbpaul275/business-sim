'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { SetupView } from '../server/setupView';
import type { RegisterRowView } from '../server/view';
import { groupDigits, ungroup } from './format';

/**
 * §9.1 Phases 0–4 in the browser: capital, the concept conversation, the
 * funding decision, the register review with the §11.3 challenge, commit.
 * All state and every model call live server-side; this lays panels out and
 * posts what the player said.
 */

type ChallengeReply = {
  ruling: string;
  reasoning: string;
  clarifyingQuestion?: string;
  secondOrderEffect?: string;
  applied: boolean;
  clamped: boolean;
  resultingValue: string;
  provenance: string;
};

export function SetupClient() {
  const router = useRouter();
  // The template this conversation starts from, when the player chose one on
  // the picker. It seeds the interview; it never skips it.
  const seed = useSearchParams().get('seed') ?? undefined;
  const [view, setView] = useState<SetupView | undefined>();
  const [capital, setCapital] = useState('500,000');
  const [error, setError] = useState<string | undefined>();
  const [keyMissing, setKeyMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('thinking');
  const [message, setMessage] = useState('');
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [view?.chat.length, view?.phase]);

  const post = async (path: string, body: unknown): Promise<Response> =>
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await post('/api/setup', { capital: ungroup(capital), ...(seed ? { seed } : {}) });
      const data = (await res.json()) as SetupView & { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Could not start.');
        setKeyMissing(res.status === 503);
      } else setView(data);
    } finally {
      setBusy(false);
    }
  };

  /**
   * No model, but the player still gets a game: the calibrated reference
   * build for the chosen template, named as what it is — a pre-built
   * demonstration, not their business.
   */
  const openReference = async (): Promise<void> => {
    if (!seed) return;
    setBusy(true);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario: seed }),
      });
      if (res.ok) {
        const data = (await res.json()) as { id: string };
        router.push(`/play/${data.id}`);
        return;
      }
    } finally {
      setBusy(false);
    }
  };

  const send = async (objection = false): Promise<void> => {
    if (!view || message.trim() === '') return;
    const text = message.trim();
    setMessage('');
    setBusy(true);
    setBusyLabel('thinking — a full draft can take a minute or two');
    // Optimistic echo so the message appears while the model works.
    setView({ ...view, chat: [...view.chat, { who: 'you', text }] });
    try {
      const res = await post(`/api/setup/${view.id}/say`, { text, objection });
      const data = (await res.json()) as SetupView & { error?: string };
      if (res.ok) setView(data);
      else setError(data.error ?? 'That message failed — try again.');
    } catch {
      setError('The connection dropped mid-call. Reload to pick the conversation back up.');
    } finally {
      setBusy(false);
    }
  };

  const undo = async (): Promise<void> => {
    if (!view) return;
    const res = await post(`/api/setup/${view.id}/undo`, {});
    if (res.ok) setView((await res.json()) as SetupView);
  };

  if (!view) {
    return (
      <main className="picker">
        <h1>{seed ? 'Make it yours' : 'Describe your own'}</h1>
        <p className="sub">
          {seed
            ? 'The template supplies a realistic cost structure; the business itself is yours ' +
              'to invent. You can challenge any number before committing.'
            : 'A sentence or two is enough to start. The model will ask follow-up questions, ' +
              'estimate the rest, and let you challenge any number before committing.'}
        </p>
        <div className="control" style={{ maxWidth: 240 }}>
          <label htmlFor="capital">Starting capital ($)</label>
          <input
            id="capital"
            inputMode="numeric"
            value={capital}
            onChange={(e) => setCapital(groupDigits(e.target.value))}
          />
        </div>
        {error && <p className="share-error">{error}</p>}
        {keyMissing && seed && (
          <p className="quiet" style={{ maxWidth: '62ch' }}>
            Without a model key the conversation cannot run, but you can open the calibrated
            reference build for this template instead — a pre-built demonstration business, not one
            you designed. Decisions still work; the concept was chosen for you.
          </p>
        )}
        <div className="share-actions" style={{ marginTop: 12 }}>
          <button onClick={() => router.push('/')}>Back</button>
          {keyMissing && seed && (
            <button onClick={() => void openReference()} disabled={busy}>
              Open the reference build
            </button>
          )}
          <button className="primary" onClick={start} disabled={busy}>
            {busy ? 'Opening…' : 'Start the conversation'}
          </button>
        </div>
      </main>
    );
  }

  return (
    <div className="setup-shell">
      <header className="topbar">
        <span className="name">{view.draft?.businessName ?? 'New business'}</span>
        <span className="period">
          {view.phase === 'INTERVIEW' && 'Describing it'}
          {view.phase === 'FUNDING' && 'Funding'}
          {view.phase === 'REVIEW' && 'The numbers, before you commit'}
          {view.phase === 'DEAD' && (view.deadReason === 'committed' ? 'Committed' : 'Ended')}
        </span>
        {view.spend && <span className="household">{view.spend}</span>}
      </header>

      <div className="setup-body">
        <section className="setup-chat" aria-label="Conversation">
          {view.chat.map((entry, i) => (
            <div key={i} className={`bubble ${entry.who}`}>
              {entry.text && <div className="text">{entry.text}</div>}
              {entry.cta && <div className="cta">{entry.cta}</div>}
              {entry.effort && <div className="effort">{entry.effort}</div>}
            </div>
          ))}
          {busy && <div className="bubble system"><div className="text">{busyLabel}…</div></div>}
          {error && <div className="share-error">{error}</div>}
          <div ref={chatEnd} />

          {view.phase === 'INTERVIEW' && !busy && (
            <div className="say-row">
              <textarea
                rows={2}
                placeholder="Describe the business, or answer the question…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="say-buttons">
                <button onClick={() => void send()} className="primary" disabled={message.trim() === ''}>
                  Send
                </button>
                <button onClick={() => void undo()} title="Take back your last message">
                  Undo
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="setup-panel" aria-label="Decisions">
          {view.draft && <DraftCard view={view} />}
          {view.phase === 'FUNDING' && view.funding && (
            <FundingPanel view={view} setView={setView} setError={setError} />
          )}
          {view.phase === 'REVIEW' && view.review && (
            <ReviewPanel
              view={view}
              setView={setView}
              onObjection={(text) => {
                setMessage(text);
                void (async () => {
                  setMessage('');
                  setBusy(true);
                  setBusyLabel('redrafting from your objection');
                  try {
                    const res = await post(`/api/setup/${view.id}/say`, { text, objection: true });
                    if (res.ok) setView((await res.json()) as SetupView);
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
              onCommitted={(playId) => router.push(`/play/${playId}`)}
            />
          )}
          {view.phase === 'DEAD' && view.deadReason !== 'committed' && (
            <div className="setup-card">
              <div>{view.deadReason}</div>
              <button className="primary" style={{ marginTop: 10 }} onClick={() => router.push('/new')}>
                Start again
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function DraftCard({ view }: { view: SetupView }) {
  const d = view.draft!;
  return (
    <div className="setup-card">
      <div className="card-title">{d.businessName}</div>
      <p className="card-sub">{d.summary}</p>
      <div className="card-line">
        <span className="prov benchmark">{d.archetype}</span> {d.archetypeRationale}
      </div>
      {d.synthetic && (
        <div className="card-line quiet">
          No template fits, so cost lines were estimated directly and carry no benchmark bands.
        </div>
      )}
      {d.openNotes.length > 0 && (
        <div className="card-notes">
          <div className="card-notes-title">Worth arguing with first</div>
          {d.openNotes.map((n, i) => (
            <div key={i} className="card-line">
              – {n}
            </div>
          ))}
          {d.hiddenNotes > 0 && (
            <div className="card-line quiet">…and {d.hiddenNotes} more, all in the register.</div>
          )}
        </div>
      )}
    </div>
  );
}

function FundingPanel({
  view,
  setView,
  setError,
}: {
  view: SetupView;
  setView: (v: SetupView) => void;
  setError: (e: string | undefined) => void;
}) {
  const f = view.funding!;
  const [custom, setCustom] = useState(false);
  const [equity, setEquity] = useState(groupDigits(String(f.proposedEquityDollars)));
  const [quote, setQuote] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const fund = async (body: unknown): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await fetch(`/api/setup/${view.id}/fund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        view: SetupView;
        outcome: {
          ok: boolean;
          declined?: { kind: string; reason: string }[];
          shortfall?: string;
          belowFloor?: string;
          attemptsLeft?: number;
        };
      };
      setView(data.view);
      const o = data.outcome;
      if (!o.ok) {
        if (o.declined) {
          setNotice(
            `The lender declined: ${o.declined.map((d) => `${d.kind} — ${d.reason}`).join('; ')} ` +
              `(${o.attemptsLeft} attempts left)`,
          );
        } else if (o.shortfall) {
          setNotice(`Not funded yet — short by ${o.shortfall}. (${o.attemptsLeft} attempts left)`);
        } else if (o.belowFloor) {
          setNotice(`Below ${o.belowFloor} no lender covers the rest.`);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const getQuote = async (): Promise<void> => {
    const res = await fetch(`/api/setup/${view.id}/fund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteOnly: true, equity: ungroup(equity) }),
    });
    const data = (await res.json()) as {
      quote?: {
        belowFloor?: boolean;
        floor?: string;
        loan?: string;
        fullyFunded?: boolean;
        ratePct?: string;
        sharePct?: string;
        cheaperHint?: string;
      };
    };
    const q = data.quote;
    if (!q) return;
    if (q.belowFloor) setQuote(`Below ${q.floor} no lender covers the rest.`);
    else if (q.fullyFunded) setQuote('Fully funded — no debt needed at that figure.');
    else
      setQuote(
        `That takes a ${q.loan} loan at ${q.ratePct}% — debt is ${q.sharePct}% of the deal.` +
          (q.cheaperHint ? ` ${q.cheaperHint}` : ''),
      );
  };

  return (
    <div className="setup-card">
      <div className="card-title">Funding</div>
      <div className="card-line">
        Opening costs {f.needed} — buildout, deposits and the first quarter of fixed costs before
        any revenue lands. You have {f.investable}.
      </div>
      {!custom ? (
        <>
          <div className="card-line plan">
            {f.planLine}
            {f.shortBy && <span className="share-error"> — still {f.shortBy} short</span>}
          </div>
          <div className="share-actions" style={{ marginTop: 10 }}>
            <button onClick={() => setCustom(true)}>Set the numbers myself</button>
            <button className="primary" disabled={busy} onClick={() => void fund({ proposed: true })}>
              {busy ? 'Asking the lender…' : 'Take this plan'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="card-line quiet">
            One number — how much of your own money goes in. The loan, its rate and the revolver
            follow, and more equity prices the loan lower. Anything above {f.investable} counts as
            outside money — a grant, a tax credit, a partner. Minimum {f.equityFloor}.
          </div>
          <div className="say-row" style={{ marginTop: 8 }}>
            <input
              inputMode="numeric"
              value={equity}
              onChange={(e) => setEquity(groupDigits(e.target.value))}
              onBlur={() => void getQuote()}
            />
            <div className="say-buttons">
              <button onClick={() => void getQuote()}>Quote</button>
              <button className="primary" disabled={busy} onClick={() => void fund({ equity: ungroup(equity) })}>
                {busy ? 'Asking the lender…' : 'Fund it'}
              </button>
            </div>
          </div>
          {quote && <div className="card-line">{quote}</div>}
          <button className="share-link" style={{ marginTop: 6 }} onClick={() => setCustom(false)}>
            back to the proposed plan
          </button>
        </>
      )}
      {notice && <div className="card-line warning-line">{notice}</div>}
    </div>
  );
}

function ReviewPanel({
  view,
  setView,
  onObjection,
  onCommitted,
}: {
  view: SetupView;
  setView: (v: SetupView) => void;
  onObjection: (text: string) => void;
  onCommitted: (playId: string) => void;
}) {
  const r = view.review!;
  const [open, setOpen] = useState<string | undefined>();
  const [value, setValue] = useState('');
  const [basis, setBasis] = useState('');
  const [ruling, setRuling] = useState<ChallengeReply | undefined>();
  const [objection, setObjection] = useState('');
  const [busy, setBusy] = useState(false);

  const challenge = async (row: RegisterRowView): Promise<void> => {
    setBusy(true);
    setRuling(undefined);
    try {
      const res = await fetch(`/api/setup/${view.id}/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assumptionId: row.id, value, basis }),
      });
      const data = (await res.json()) as { result?: ChallengeReply; view?: SetupView; error?: string };
      if (data.result) setRuling(data.result);
      if (data.view) setView(data.view);
    } finally {
      setBusy(false);
    }
  };

  const commit = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch(`/api/setup/${view.id}/commit`, { method: 'POST' });
      const data = (await res.json()) as { playId?: string };
      if (data.playId) onCommitted(data.playId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup-card review">
      <div className="card-title">Before you commit</div>
      <div className="card-line">
        Month zero {r.monthZero} · opening cash {r.openingCash} · {r.equity} equity
        {r.outside ? ` + ${r.outside} outside` : ''}
        {r.debtLine ? ` · ${r.debtLine}` : ''}
      </div>
      {r.notes.map((n, i) => (
        <div key={i} className="card-line warning-line">
          ⚠ {n}
        </div>
      ))}
      <div className="register-head" style={{ marginTop: 10 }}>
        <span>{r.register.length} assumptions</span>
        <span>model confidence {r.confidence}</span>
      </div>
      <div className="review-register">
        {r.register.map((a) => (
          <div key={a.id} className={`assumption${r.arguable.includes(a.id) ? ' arguable' : ''}`}>
            <div className="row1">
              <span>{a.label}</span>
              <span className="val">{a.value}</span>
            </div>
            <div className="row2">
              <span className={`prov ${a.provenance.toLowerCase().replace(/_/g, '-')}`}>
                {a.provenance.toLowerCase().replace(/_/g, ' ')}
              </span>
              {a.deviation && <span className="deviation">{a.deviation}</span>}
              <button
                className="share-link"
                onClick={() => {
                  setOpen(open === a.id ? undefined : a.id);
                  setValue('');
                  setBasis('');
                  setRuling(undefined);
                }}
              >
                challenge
              </button>
            </div>
            {open === a.id && (
              <div className="challenge-form">
                <div className="quiet" title={a.sourceNote}>
                  {a.sourceNote}
                </div>
                <div className="say-row">
                  <input
                    placeholder="your number"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                  <input
                    placeholder="the basis — a quote, a listing, a model number (optional)"
                    value={basis}
                    onChange={(e) => setBasis(e.target.value)}
                    style={{ flex: 2 }}
                  />
                  <button
                    className="primary"
                    disabled={busy || value.trim() === ''}
                    onClick={() => void challenge(a)}
                  >
                    {busy ? 'Arguing…' : 'Argue it'}
                  </button>
                </div>
                <div className="quiet">
                  A bare number moves it at most to the edge of its range; a real basis moves it
                  properly.
                </div>
                {ruling && (
                  <div className={`ruling ${ruling.ruling.toLowerCase()}`}>
                    <strong>{ruling.ruling}</strong> {ruling.reasoning}
                    {ruling.clarifyingQuestion && <div>? {ruling.clarifyingQuestion}</div>}
                    {ruling.secondOrderEffect && <div>↳ {ruling.secondOrderEffect}</div>}
                    {ruling.applied && (
                      <div>
                        → {ruling.resultingValue} · {ruling.provenance.toLowerCase().replace(/_/g, ' ')}
                        {ruling.clamped ? ' (held at the edge of its range)' : ''}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="card-notes" style={{ marginTop: 12 }}>
        <div className="card-notes-title">Something structural to change?</div>
        <div className="say-row">
          <input
            placeholder='e.g. "I want to buy the trucks used, not lease them"'
            value={objection}
            onChange={(e) => setObjection(e.target.value)}
          />
          <button
            disabled={busy || objection.trim() === ''}
            onClick={() => {
              onObjection(objection.trim());
              setObjection('');
            }}
          >
            Redraft it
          </button>
        </div>
      </div>

      <div className="share-actions" style={{ marginTop: 14 }}>
        <button className="primary" disabled={busy} onClick={() => void commit()}>
          Commit and open — the model freezes after this
        </button>
      </div>
    </div>
  );
}
