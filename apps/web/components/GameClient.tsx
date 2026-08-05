'use client';

import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { AdvisorEntry, StagedMove } from '../server/store';
import type { AttributionView, GameView, Row } from '../server/view';
import { groupDigits, groupMoney, ungroup } from './format';

/**
 * The three-pane shell (architecture §7): turn log · statements · register,
 * with the structured action bar underneath. Every number on this screen is a
 * string the server formatted from engine output — this component lays things
 * out and posts decisions; it computes nothing financial.
 */

export function GameClient({ initial }: { initial: GameView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [tab, setTab] = useState<'is' | 'bs' | 'cf'>('is');
  // The advisor is the default left pane: the conversation is the game, and
  // the turn log is the paper trail behind it.
  const [leftTab, setLeftTab] = useState<'advisor' | 'log'>('advisor');
  const [msg, setMsg] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  // The milestone banner is a scoreboard, not a wall — "keep playing" is a
  // real choice and dismissing the banner is how it is made.
  const [playingOn, setPlayingOn] = useState(false);

  // Pending decisions. Empty string = leave unchanged this quarter.
  const [price, setPrice] = useState('');
  const [marketing, setMarketing] = useState('');
  /**
   * Every other staged move, as one list — the strip above the run button IS
   * this list, and this list becomes the TurnRequest. The old model kept the
   * turn scattered across five parallel records (price, marketing, hires,
   * eight form pairs, assumes), which meant the player could not see their
   * turn anywhere and the code could lose part of it (the stale-closure bug).
   */
  const [staged, setStaged] = useState<StagedMove[]>([]);
  // The command input: the game's own grammar, parsed server-side by the same
  // parser that validates advisor chips. Deterministic — no model call.
  const [cmd, setCmd] = useState('');
  const [cmdError, setCmdError] = useState<string | undefined>();
  const [cmdMenu, setCmdMenu] = useState(false);
  // Staged assumption revisions — the in-game `assume` lever, applied next tick.
  const [assumes, setAssumes] = useState<Record<string, { value: string; evidence: string }>>({});
  const [assumeOpen, setAssumeOpen] = useState<string | undefined>();
  // Which register tab is showing; unset falls back to the first tab that has
  // an out-of-benchmark row, so a fresh screen opens where the arguments are.
  const [regTab, setRegTab] = useState<string | undefined>();

  const runQuarter = async (skip: number): Promise<void> => {
    setBusy(true);
    try {
      const hire: { costId: string; blocks: number }[] = [];
      const fire: { costId: string; blocks: number }[] = [];
      const assume = Object.entries(assumes)
        .filter(([, a]) => a.value.trim() !== '')
        .map(([assumptionId, a]) => ({ assumptionId, value: a.value, evidence: a.evidence }));
      const body: Record<string, unknown> = { skip, hire, fire, assume };
      if (price.trim() !== '') body['price'] = ungroup(price);
      if (marketing.trim() !== '') body['marketingPerQuarter'] = ungroup(marketing);
      for (const s of staged) {
        if (s.type === 'staff') {
          (s.delta > 0 ? hire : fire).push({ costId: s.costId, blocks: Math.abs(s.delta) });
        } else if (s.type === 'expand') {
          body['expand'] = { units: s.units, costDollars: s.cost };
        } else if (s.type === 'upgrade') {
          body['upgrade'] = { upliftPct: s.pct, costDollars: s.cost };
        } else if (s.type === 'territory') {
          body['territory'] = { pct: s.pct, costDollars: s.cost };
        } else if (s.type === 'debt') {
          body['debt'] = { amountDollars: s.amount, termQuarters: s.quarters ?? 40 };
        } else if (s.type === 'draw' || s.type === 'repay' || s.type === 'inject' || s.type === 'distribute') {
          body[s.type] = s.amount;
        }
      }

      const res = await fetch(`/api/sessions/${view.id}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setView((await res.json()) as GameView);
        setPrice('');
        setMarketing('');
        setAssumes({});
        setAssumeOpen(undefined);
        setStaged([]);
      }
    } finally {
      setBusy(false);
    }
  };

  const askText = async (text: string): Promise<void> => {
    if (text.trim() === '' || asking) return;
    setAsking(true);
    setMsg('');
    try {
      const res = await fetch(`/api/sessions/${view.id}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      });
      if (res.ok) setView((await res.json()) as GameView);
      else setMsg(text);
    } catch {
      setMsg(text);
    } finally {
      setAsking(false);
    }
  };
  const ask = async (): Promise<void> => askText(msg);

  // One line of the game's grammar → one staged chip, parsed server-side by
  // the same validator that guards advisor chips. Deterministic and free; a
  // non-parse is offered to the advisor as conversation instead.
  const submitCommand = async (): Promise<void> => {
    const command = cmd.trim();
    if (command === '') return;
    setCmdError(undefined);
    const res = await fetch(`/api/sessions/${view.id}/parse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      move?: { stage: StagedMove };
      error?: string;
    };
    if (data.move) {
      applyStage(data.move.stage);
      setCmd('');
    } else {
      setCmdError(data.error ?? 'not a move this build can stage');
    }
  };

  // A suggestion chip stages the move in the action bar — it never runs the
  // quarter. The decision stays with the player; the chip just saves typing.
  // Functional updates throughout: "stage these" applies several moves in one
  // click, and spreading a stale closure would keep only the last of them.
  const applyStage = (stage: StagedMove): void => {
    if (stage.type === 'price') setPrice(groupMoney(String(stage.value)));
    else if (stage.type === 'marketing') setMarketing(groupDigits(String(stage.value)));
    else if (stage.type === 'assume') {
      setAssumes((a) => ({
        ...a,
        [stage.assumptionId]: { value: stage.value, evidence: a[stage.assumptionId]?.evidence ?? '' },
      }));
    } else if (stage.type === 'staff') {
      // Staff merges: two "hire" clicks on the same line stage two blocks.
      // Everything else replaces — the TurnRequest has one slot per verb.
      setStaged((list) => {
        const existing = list.find((s) => s.type === 'staff' && s.costId === stage.costId);
        const delta = Math.max(
          -5,
          Math.min(5, (existing?.type === 'staff' ? existing.delta : 0) + stage.delta),
        );
        const rest = list.filter((s) => !(s.type === 'staff' && s.costId === stage.costId));
        return delta === 0 ? rest : [...rest, { ...stage, delta }];
      });
    } else {
      setStaged((list) => [...list.filter((s) => s.type !== stage.type), stage]);
    }
  };

  const unstage = (index: number): void =>
    setStaged((list) => list.filter((_, i) => i !== index));

  /** A staged move, phrased for its chip. */
  const chipLabel = (s: StagedMove): string => {
    const n = (v: number): string => v.toLocaleString('en-US');
    if (s.type === 'staff') {
      const label = view.staffing.find((x) => x.costId === s.costId)?.label ?? s.costId;
      return `${s.delta > 0 ? 'hire' : 'cut'} ${label} ×${Math.abs(s.delta)}`;
    }
    if (s.type === 'expand') return `expand +${n(s.units)} ${view.moves.expandNoun} · $${n(s.cost)}`;
    if (s.type === 'upgrade') return `upgrade +${s.pct}% · $${n(s.cost)}`;
    if (s.type === 'territory') return `territory +${s.pct}% · $${n(s.cost)}`;
    if (s.type === 'debt') return `loan $${n(s.amount)}${s.quarters ? ` · ${s.quarters}q` : ''}`;
    if (s.type === 'draw' || s.type === 'repay' || s.type === 'inject' || s.type === 'distribute') {
      return `${s.type} $${n(s.amount)}`;
    }
    return s.type;
  };

  // Assumption labels for the strip, from the register the view already carries.
  const assumptionLabel = (id: string): string => {
    for (const t of view.register.tabs) {
      for (const g of t.groups) {
        const row = g.rows.find((r) => r.id === id || r.escalatorId === id);
        if (row) return row.id === id ? row.label : `${row.label} escalator`;
      }
    }
    return id;
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="name">{view.businessName}</span>
        <span className="period">
          Period {view.period} · Year {view.year} Q{view.quarter}
        </span>
        <span className={`status-chip${view.status === 'CLOSED' ? ' closed' : ''}`}>
          {view.status}
        </span>
        <span className="household">
          Household {view.household.cash} · net worth {view.household.netWorth}
        </span>
      </header>

      <div className="panes">
        <section className="pane advisor-pane" aria-label="Advisor">
          <div className="tabs" role="tablist">
            {(
              [
                ['advisor', 'Advisor'],
                ['log', 'Turn log'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={leftTab === key}
                className={leftTab === key ? 'active' : ''}
                onClick={() => setLeftTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {leftTab === 'advisor' ? (
            <AdvisorFeed
              entries={view.advisor}
              available={view.advisorAvailable}
              asking={asking}
              msg={msg}
              setMsg={setMsg}
              onAsk={ask}
              onStage={applyStage}
            />
          ) : (
            <div className="turnlog">
              {view.log.map((turn) => (
                <div className="turn" key={turn.period}>
                  <div className="when">
                    P{turn.period} · Y{turn.year} Q{turn.quarter}
                  </div>
                  {turn.events.map((event, i) => (
                    <div className="event" key={i}>
                      {event}
                    </div>
                  ))}
                  {turn.attributions.map((a) => (
                    <Attribution key={a.lineLabel} a={a} />
                  ))}
                  {turn.events.length === 0 && turn.attributions.length === 0 && (
                    <div className="quiet">A quiet quarter.</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="pane" aria-label="Statements">
          <div className="tiles">
            {view.tiles.map((tile) => (
              <div className={`tile${tile.tone ? ` ${tile.tone}` : ''}`} key={tile.label}>
                <div className="label">{tile.label}</div>
                <div className="value">{tile.value}</div>
                {tile.hint && <div className="hint">{tile.hint}</div>}
              </div>
            ))}
          </div>

          <div className="tabs" role="tablist">
            {(
              [
                ['is', 'Income'],
                ['bs', 'Balance sheet'],
                ['cf', 'Cash flow'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                className={tab === key ? 'active' : ''}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <Statement rows={view.statements[tab]} />

          <div className="streams">
            {view.streams.map((s) => (
              <div className="stream-line" key={s.label}>
                <span className="vol">{s.volume}</span>{' '}
                <span className={`detail${s.warning ? ' warning' : ''}`}>{s.detail}</span>
              </div>
            ))}
            {view.staffing.map((s) => (
              <div className="staff-row" key={s.costId}>
                <span>{s.label}</span>
                <span className="blocks">
                  {s.blocks} blocks
                  {s.pending > 0 ? ` (+${s.pending} arriving)` : ''}
                </span>
                {s.needed !== undefined && s.needed > s.blocks && (
                  <span className="needs">needs {s.needed}</span>
                )}
                <span>{s.blockCost}/block</span>
                {/* Control beside evidence: the row already shows blocks,
                    pending and the capacity warning — the decision is made
                    here, so the lever lives here. Clicks accumulate. */}
                {!view.over && (
                  <span className="staff-actions">
                    <button
                      className="share-link"
                      onClick={() => applyStage({ type: 'staff', costId: s.costId, delta: 1 })}
                    >
                      hire
                    </button>
                    <button
                      className="share-link"
                      onClick={() => applyStage({ type: 'staff', costId: s.costId, delta: -1 })}
                    >
                      cut
                    </button>
                  </span>
                )}
              </div>
            ))}
            {view.debts.map((d) => (
              <div className="staff-row" key={d.label}>
                <span>{d.label}</span>
                <span>{d.detail}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="pane" aria-label="Assumption register">
          <h2>Assumption register</h2>
          <div className="register-head">
            <span>{view.register.count} assumptions</span>
            <span>model confidence {view.register.confidence}</span>
          </div>
          {(() => {
            const tabs = view.register.tabs;
            const active =
              tabs.find((t) => t.key === regTab) ?? tabs.find((t) => t.deviations > 0) ?? tabs[0];
            if (!active) return null;
            return (
              <>
                <div className="reg-tabs" role="tablist">
                  {tabs.map((t) => (
                    <button
                      key={t.key}
                      role="tab"
                      aria-selected={t.key === active.key}
                      className={t.key === active.key ? 'active' : ''}
                      onClick={() => setRegTab(t.key)}
                    >
                      {t.label}
                      <span className="reg-meta">
                        {' '}
                        {t.count}
                        {t.deviations > 0 ? ` · ${t.deviations}⚠` : ''}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="reg-hint">{active.hint}</div>
                {active.groups.map((g) => (
                  <details className="reg-group" key={g.label} open={g.deviations > 0}>
                    <summary>
                      <span>{g.label}</span>
                      <span className="reg-meta">
                        {g.count}
                        {g.deviations > 0 ? ` · ${g.deviations} outside benchmark` : ''}
                      </span>
                    </summary>
                    <table className="reg-table">
                      <tbody>
                        {g.rows.map((a) => (
                          <Fragment key={a.id}>
                            <tr className="assumption" title={a.sourceNote}>
                              <td className="rt-label">
                                {a.label}
                                {a.deviation && <span className="deviation">{a.deviation}</span>}
                              </td>
                              <td className="rt-val">{a.value}</td>
                              <td className="rt-esc">
                                {a.escalator && a.escalatorId ? (
                                  <button
                                    className="share-link"
                                    title="Annual escalator — click to revise it"
                                    onClick={() =>
                                      setAssumeOpen(
                                        assumeOpen === a.escalatorId ? undefined : a.escalatorId,
                                      )
                                    }
                                  >
                                    {a.escalator}/yr
                                  </button>
                                ) : (
                                  <span className="quiet">—</span>
                                )}
                              </td>
                              <td className="rt-prov">
                                <span className={`prov ${a.provenance.toLowerCase().replace(/_/g, '-')}`}>
                                  {a.provenance.toLowerCase().replace(/_/g, ' ')}
                                </span>
                              </td>
                              <td className="rt-act">
                                <button
                                  className="share-link"
                                  onClick={() => setAssumeOpen(assumeOpen === a.id ? undefined : a.id)}
                                >
                                  {assumes[a.id]?.value ? 'staged' : 'revise'}
                                </button>
                              </td>
                            </tr>
                            {(assumeOpen === a.id ||
                              (a.escalatorId !== undefined && assumeOpen === a.escalatorId)) &&
                              (() => {
                                const fid = assumeOpen!;
                                return (
                                  <tr>
                                    <td colSpan={5}>
                                      <div className="challenge-form">
                                        <div className="say-row">
                                          <input
                                            placeholder={
                                              fid === a.escalatorId ? 'new escalator (e.g. 3%)' : 'new value'
                                            }
                                            value={assumes[fid]?.value ?? ''}
                                            onChange={(e) =>
                                              setAssumes({
                                                ...assumes,
                                                [fid]: {
                                                  value: e.target.value,
                                                  evidence: assumes[fid]?.evidence ?? '',
                                                },
                                              })
                                            }
                                          />
                                          <input
                                            placeholder="evidence (optional)"
                                            value={assumes[fid]?.evidence ?? ''}
                                            onChange={(e) =>
                                              setAssumes({
                                                ...assumes,
                                                [fid]: {
                                                  value: assumes[fid]?.value ?? '',
                                                  evidence: e.target.value,
                                                },
                                              })
                                            }
                                            style={{ flex: 2 }}
                                          />
                                        </div>
                                        <div className="assume-note">
                                          Applies when the quarter runs. Without evidence it is recorded as
                                          your assertion, ranked below the model&apos;s own estimate.
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })()}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </details>
                ))}
              </>
            );
          })()}
        </section>
      </div>

      {view.over && !playingOn ? (
        <div className="gameover">
          <span>
            {view.status === 'CLOSED'
              ? 'The business is insolvent and closed.'
              : 'Ten-year milestone reached.'}
          </span>
          {view.status !== 'CLOSED' && (
            <button className="share-link" onClick={() => setPlayingOn(true)}>
              Keep playing
            </button>
          )}
          <button className="share-link" onClick={() => router.push('/')}>
            Start another run
          </button>
          {view.share && !view.share.sharedAs && (
            <button className="share-link" onClick={() => setSharing(true)}>
              Share this run with QA
            </button>
          )}
        </div>
      ) : null}

      {view.share && (sharing || view.share.sharedAs) && (
        <SharePanel
          view={view}
          onClose={() => setSharing(false)}
          onShared={(reference) =>
            setView({ ...view, share: { ...view.share!, sharedAs: reference } })
          }
        />
      )}

      {(staged.length > 0 ||
        price.trim() !== '' ||
        marketing.trim() !== '' ||
        Object.values(assumes).some((a) => a.value.trim() !== '')) && (
        <div className="staged-strip">
          <span className="staged-cap">This quarter:</span>
          {price.trim() !== '' && (
            <span className="staged-chip">
              price ${price}
              <button onClick={() => setPrice('')} aria-label="unstage price">×</button>
            </span>
          )}
          {marketing.trim() !== '' && (
            <span className="staged-chip">
              marketing ${marketing}/qtr
              <button onClick={() => setMarketing('')} aria-label="unstage marketing">×</button>
            </span>
          )}
          {staged.map((s, i) => (
            <span className="staged-chip" key={`${s.type}-${i}`}>
              {chipLabel(s)}
              <button onClick={() => unstage(i)} aria-label={`unstage ${s.type}`}>×</button>
            </span>
          ))}
          {Object.entries(assumes)
            .filter(([, a]) => a.value.trim() !== '')
            .map(([id, a]) => (
              <span className="staged-chip" key={id}>
                assume {assumptionLabel(id)} → {a.value}
                <button
                  onClick={() =>
                    setAssumes((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== id)))
                  }
                  aria-label="unstage assumption"
                >
                  ×
                </button>
              </span>
            ))}
        </div>
      )}
      <footer className="actionbar">
        <div className="control">
          <label htmlFor="price">Price ({view.price.per})</label>
          <input
            id="price"
            inputMode="decimal"
            placeholder={view.price.value.toLocaleString('en-US')}
            value={price}
            onChange={(e) => setPrice(groupMoney(e.target.value))}
          />
        </div>
        <div className="control">
          <label htmlFor="marketing">Marketing $/quarter</label>
          <input
            id="marketing"
            inputMode="numeric"
            placeholder={view.marketingPerQuarter.toLocaleString('en-US')}
            value={marketing}
            onChange={(e) => setMarketing(groupDigits(e.target.value))}
          />
        </div>
        {!view.over && (
          <div className="control cmd">
            <label htmlFor="cmd">Move</label>
            <div className="cmd-row">
              <input
                id="cmd"
                value={cmd}
                placeholder="type a move — hire crew 1, debt 50000…"
                onChange={(e) => {
                  setCmd(e.target.value);
                  setCmdError(undefined);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitCommand();
                }}
              />
              <button
                className="cmd-help"
                aria-label="all moves"
                onClick={() => setCmdMenu(!cmdMenu)}
              >
                ?
              </button>
            </div>
            {cmdError && (
              <div className="cmd-error">
                {cmdError} —{' '}
                <button
                  className="share-link"
                  onClick={() => {
                    void askText(cmd);
                    setCmd('');
                    setCmdError(undefined);
                    setLeftTab('advisor');
                  }}
                >
                  ask the advisor
                </button>
              </div>
            )}
            {cmdMenu && (
              <div className="cmd-pop">
                {view.commands.map((line) => {
                  const [template, ...rest] = line.split(' — ');
                  return (
                    <button
                      key={line}
                      className="cmd-pop-row"
                      onClick={() => {
                        setCmd(`${template!.trim()} `);
                        setCmdMenu(false);
                        document.getElementById('cmd')?.focus();
                      }}
                    >
                      <span className="cmd-template">{template}</span>
                      <span className="cmd-desc">{rest.join(' — ')}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <div className="run">
          {view.share && !view.share.sharedAs && !view.over && (
            <button className="share-link" onClick={() => setSharing(true)}>
              Share with QA
            </button>
          )}
          <button onClick={() => runQuarter(3)} disabled={busy || view.status === 'CLOSED'}>
            Skip year
          </button>
          <button
            className="primary"
            onClick={() => runQuarter(0)}
            disabled={busy || view.status === 'CLOSED'}
          >
            {view.status === 'CLOSED' ? 'Closed' : busy ? 'Running…' : 'Run quarter'}
          </button>
        </div>
      </footer>
    </div>
  );
}

/**
 * The consent moment. The notice states exactly what leaves the machine; the
 * confirmation is the consent, scoped to this run alone; the reference shown
 * afterwards is the player's deletion handle. A player who has already shared
 * sees the reference, not a second ask.
 */
function SharePanel({
  view,
  onClose,
  onShared,
}: {
  view: GameView;
  onClose: () => void;
  onShared: (reference: string) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (view.share?.sharedAs) {
    return (
      <div className="share-panel">
        <div>
          Shared as <code>{view.share.sharedAs}</code>. Keep that reference — quote it to have the
          run deleted.
        </div>
        <div className="share-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  const share = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/sessions/${view.id}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      const data = (await res.json()) as { reference?: string; error?: string };
      if (res.ok && data.reference) onShared(data.reference);
      else setError(data.error ?? 'Sharing failed — nothing was sent.');
    } catch {
      setError('Could not reach the QA endpoint — nothing was sent.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="share-panel">
      <div className="share-notice">{view.share?.notice}</div>
      <textarea
        placeholder="Anything you'd like the QA team to know? (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
      />
      {error && <div className="share-error">{error}</div>}
      <div className="share-actions">
        <button onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={share} disabled={busy}>
          {busy ? 'Sharing…' : 'Approve & share this run'}
        </button>
      </div>
    </div>
  );
}

/**
 * The turn loop, on screen: each quarter an update (what happened), then ONE
 * question (the eigen axis), then whatever conversation the player wants to
 * have about it. The question renders whether or not a model is reachable —
 * it is deterministic — and the input quietly explains itself when chat is
 * unavailable.
 */
function AdvisorFeed({
  entries,
  available,
  asking,
  msg,
  setMsg,
  onAsk,
  onStage,
}: {
  entries: AdvisorEntry[];
  available: boolean;
  asking: boolean;
  msg: string;
  setMsg: (v: string) => void;
  onAsk: () => void;
  onStage: (stage: StagedMove) => void;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, asking]);

  return (
    <div className="advisor">
      <div className="advisor-feed" ref={feedRef}>
        {entries.map((e, i) => {
          if (e.kind === 'question') {
            return (
              <div className="a-question" key={i}>
                {e.fact && <div className="a-fact">{e.fact}</div>}
                <div className="a-ask">{e.text}</div>
              </div>
            );
          }
          if (e.kind === 'update') {
            return (
              <div className="a-update" key={i}>
                {e.headline && <div className="a-headline">{e.headline}</div>}
                <div>{e.text}</div>
              </div>
            );
          }
          return (
            <div className={`a-chat ${e.who}`} key={i}>
              <div>{e.text}</div>
              {e.ordered && e.ordered.length > 0 && (
                <div className="a-confirm">
                  {e.orderedSummary && <div className="a-confirm-summary">{e.orderedSummary}</div>}
                  <div className="a-chips">
                    {e.ordered.map((s) => (
                      <button
                        key={s.command}
                        className="chip"
                        title="Stage this in the action bar — nothing runs until you run the quarter"
                        onClick={() => onStage(s.stage)}
                      >
                        {s.command}
                      </button>
                    ))}
                    <button
                      className="chip confirm"
                      title="Stage everything above — nothing runs until you run the quarter"
                      onClick={() => e.ordered!.forEach((s) => onStage(s.stage))}
                    >
                      {e.ordered.length > 1 ? 'stage all of it' : 'stage it'}
                    </button>
                  </div>
                </div>
              )}
              {e.unresolvable && e.unresolvable.length > 0 && (
                <div className="a-unresolved">
                  {e.unresolvable.map((u, j) => (
                    <div key={j}>· {u}</div>
                  ))}
                </div>
              )}
              {e.suggested && e.suggested.length > 0 && (
                <div className="a-chips">
                  {e.suggested.map((s) => (
                    <button
                      key={s.command}
                      className="chip"
                      title="Stage this in the action bar — nothing runs until you run the quarter"
                      onClick={() => onStage(s.stage)}
                    >
                      {s.command}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {asking && <div className="a-chat advisor thinking">Thinking…</div>}
      </div>
      <div className="say-row">
        <textarea
          placeholder={
            available
              ? 'Answer, argue, or ask anything about the business…'
              : 'Chat needs a model key on the server — the questions above still play.'
          }
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onAsk();
            }
          }}
          rows={2}
          disabled={!available || asking}
        />
        <button className="primary" onClick={onAsk} disabled={!available || asking || msg.trim() === ''}>
          {asking ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function Statement({ rows }: { rows: Row[] }) {
  return (
    <table className="statement">
      <tbody>
        {rows.map((row, i) => (
          <tr key={`${row.label}-${i}`} className={row.strong ? 'strong' : ''}>
            <td className={row.indent ? 'indent' : ''}>{row.label}</td>
            <td className={`num${row.negative ? ' negative' : ''}`}>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Attribution({ a }: { a: AttributionView }) {
  return (
    <div className="attr">
      <div className="head">
        {a.lineLabel} <span className={`delta ${a.negative ? 'neg' : 'pos'}`}>{a.delta}</span>
      </div>
      {a.drivers.map((d) => (
        <div className="driver" key={d.label} title={d.explanation}>
          <span>{d.label}</span>
          <span className="amount">{d.amount}</span>
          {d.provenance && <span className={`prov ${d.provenance}`}>{d.provenance}</span>}
        </div>
      ))}
    </div>
  );
}
