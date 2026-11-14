import Head from 'next/head';
import { useRouter } from 'next/router';

import MakerLayout from '../../../components/maker/MakerLayout';
import MakerPage from '../../../components/maker/MakerPage';
import { stepsFor } from '../../../components/maker/steps';

export default function ProjectMakerPage() {
  const router = useRouter();
  // The id is not there on the first render of a pages-router dynamic route.
  const id = router.isReady ? String(router.query.id || '') : '';
  return (
    <>
      <Head><title>Make your video | Ariya Lab</title></Head>
      {id ? (
        <MakerPage id={id} returnTo={router.asPath} />
      ) : (
        <MakerLayout title="Your video" steps={stepsFor(null).map((s) => ({ id: s.id, label: s.label, locked: true }))} currentId="start">
          <p role="status">Loading your video…</p>
        </MakerLayout>
      )}
    </>
  );
}
