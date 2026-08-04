'use client';

import { useState } from 'react';
import type { AttributionView, GameView, Row } from '../server/view';

/**
 * The three-pane shell (architecture §7): turn log · statements · register,
 * with the structured action bar underneath. Every number on this screen is a
 * string the server formatted from engine output — this component lays things
 * out and posts decisions; it computes nothing financial.
 */

export function GameClient({ initial }: { initial: GameView }) {
  const [view, setView] = useState(initial);
  const [tab, setTab] = useState<'is' | 'bs' | 'cf'>('is');
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);

  // Pending decisions. Empty string = leave unchanged this quarter.
  const [price, setPrice] = useState('');
  const [marketing, setMarketing] = useState('');
  const [hires, setHires] = useState<Record<string, number>>({});

  const runQuarter = async (skip: number): Promise<void> => {
    setBusy(true);
    try {
      const hire = Object.entries(hires)
        .filter(([, n]) => n > 0)
        .map(([costId, blocks]) => ({ costId, blocks }));
      const fire = Object.entries(hires)
        .filter(([, n]) => n < 0)
        .map(([costId, blocks]) => ({ costId, blocks: -blocks }));
      const body: Record<string, unknown> = { skip, hire, fire };
      if (price.trim() !== '') body['price'] = Number(price);
      if (marketing.trim() !== '') body['marketingPerQuarter'] = Number(marketing);

      const res = await fetch(`/api/sessions/${view.id}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setView((await res.json()) as GameView);
        setPrice('');
        setMarketing('');
        setHires({});
      }
    } finally {
      setBusy(false);
    }
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
        <section className="pane" aria-label="Turn log">
          <h2>Turn log</h2>
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
            <span>{view.register.rows.length} assumptions</span>
            <span>model confidence {view.register.confidence}</span>
          </div>
          {view.register.rows.map((a) => (
            <div className="assumption" key={a.id} title={a.sourceNote}>
              <div className="row1">
                <span>{a.label}</span>
                <span className="val">{a.value}</span>
              </div>
              <div className="row2">
                <span className={`prov ${a.provenance.toLowerCase().replace(/_/g, '-')}`}>
                  {a.provenance.toLowerCase().replace(/_/g, ' ')}
                </span>
                {a.deviation && <span className="deviation">{a.deviation}</span>}
              </div>
            </div>
          ))}
        </section>
      </div>

      {view.over ? (
        <div className="gameover">
          {view.status === 'CLOSED'
            ? 'The business is insolvent and closed. Start another run from the picker.'
            : 'Ten-year milestone reached — keep playing, or start another run.'}
          {view.share && !view.share.sharedAs && (
            <>
              {' '}
              <button className="share-link" onClick={() => setSharing(true)}>
                Share this run with QA
              </button>
            </>
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

      <footer className="actionbar">
        <div className="control">
          <label htmlFor="price">Price ({view.price.per})</label>
          <input
            id="price"
            inputMode="decimal"
            placeholder={String(view.price.value)}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
        <div className="control">
          <label htmlFor="marketing">Marketing $/quarter</label>
          <input
            id="marketing"
            inputMode="numeric"
            placeholder={String(view.marketingPerQuarter)}
            value={marketing}
            onChange={(e) => setMarketing(e.target.value)}
          />
        </div>
        {view.staffing.map((s) => (
          <div className="control" key={s.costId}>
            <label htmlFor={`staff-${s.costId}`}>{s.label}</label>
            <select
              id={`staff-${s.costId}`}
              value={hires[s.costId] ?? 0}
              onChange={(e) => setHires({ ...hires, [s.costId]: Number(e.target.value) })}
            >
              {[-2, -1, 0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'hold' : n > 0 ? `hire +${n}` : `cut ${n}`}
                </option>
              ))}
            </select>
          </div>
        ))}
        <div className="run">
          {view.share && !view.share.sharedAs && !view.over && (
            <button className="share-link" onClick={() => setSharing(true)}>
              Share with QA
            </button>
          )}
          <button onClick={() => runQuarter(3)} disabled={busy}>
            Skip year
          </button>
          <button className="primary" onClick={() => runQuarter(0)} disabled={busy}>
            {busy ? 'Running…' : 'Run quarter'}
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
