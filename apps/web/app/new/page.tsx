import { Suspense } from 'react';
import { SetupClient } from '../../components/SetupClient';

export default function NewGamePage() {
  return (
    <Suspense>
      <SetupClient />
    </Suspense>
  );
}
