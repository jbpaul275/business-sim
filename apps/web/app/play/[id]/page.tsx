import { notFound } from 'next/navigation';
import { getSession } from '../../../server/store';
import { toView } from '../../../server/view';
import { GameClient } from '../../../components/GameClient';

export default async function PlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) notFound();
  return <GameClient initial={toView(session)} />;
}
