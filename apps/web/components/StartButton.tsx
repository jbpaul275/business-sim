'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function StartButton({
  scenario,
  name,
  blurb,
  facts,
}: {
  scenario: string;
  name: string;
  /** The binding constraint in plain words — never the archetype enum. */
  blurb: string;
  /** Short computed facts: cost to open, the calibrated earning band. */
  facts: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario }),
      });
      if (!res.ok) throw new Error(await res.text());
      const view = (await res.json()) as { id: string };
      router.push(`/play/${view.id}`);
    } catch {
      setBusy(false);
    }
  };

  return (
    <button className="scenario-card" onClick={start} disabled={busy}>
      <div className="name">{busy ? 'Opening…' : name}</div>
      <div className="blurb">{blurb}</div>
      <div className="facts">{facts.join(' · ')}</div>
    </button>
  );
}
