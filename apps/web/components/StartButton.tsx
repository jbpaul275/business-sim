'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function StartButton({
  scenario,
  name,
  kind,
}: {
  scenario: string;
  name: string;
  kind: string;
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
      <div className="kind">{kind}</div>
    </button>
  );
}
