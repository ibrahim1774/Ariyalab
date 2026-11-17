import Head from 'next/head';
import { useRouter } from 'next/router';

import MakerLayout from '../../../components/maker/MakerLayout';
import MakerPage from '../../../components/maker/MakerPage';
import { stepsFor } from '../../../components/maker/steps';
import SimpleMaker from '../../../components/simple/SimpleMaker';

export default function ProjectMakerPage() {
  const router = useRouter();
  // The id is not there on the first render of a pages-router dynamic route.
  const id = router.isReady ? String(router.query.id || '') : '';
  // The simple view is the default; ?view=steps opens the 12 step editor on the same project.
  const detailed = router.query?.view === 'steps';
  return (
    <>
      <Head><title>Make your video | Ariya Lab</title></Head>
      {id ? (
        detailed ? <MakerPage id={id} returnTo={router.asPath} /> : <SimpleMaker id={id} returnTo={router.asPath} />
      ) : (
        <MakerLayout title="Your video" steps={stepsFor(null).map((s) => ({ id: s.id, label: s.label, locked: true }))} currentId="start">
          <p role="status">Loading your video…</p>
        </MakerLayout>
      )}
    </>
  );
}
