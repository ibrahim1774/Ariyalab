import Head from 'next/head';
import { useRouter } from 'next/router';

import MakerLayout from '../../components/maker/MakerLayout';
import StepStart from '../../components/maker/StepStart';
import { stepsFor } from '../../components/maker/steps';
import SimpleMaker from '../../components/simple/SimpleMaker';
import { createProject } from '../../lib/story/client';

export default function NewVideoPage() {
  const router = useRouter();
  // The project is created when the customer submits, never on load, so a reload makes no stray projects.
  async function onCreate(input) {
    const project = await createProject(input);
    await router.replace(`/app/p/${project.id}`);
  }
  // Starting from a video: the project is made only after the video passed the browser's checks, then the upload
  // and the analysis use it, and only then the project opens.
  async function onCreateForVideo() {
    const project = await createProject({ title: 'Video from a reference' });
    return project.id;
  }
  async function onOpenProject(id) {
    await router.replace(`/app/p/${id}`);
  }
  // The simple view is the default; ?view=steps keeps the 12 step start screen.
  if (!router.isReady) return <Head><title>New video | Sonallo</title></Head>;
  if (router.query?.view !== 'steps') {
    return (
      <>
        <Head><title>New video | Sonallo</title></Head>
        <SimpleMaker id={null} returnTo="/app/new" />
      </>
    );
  }
  const steps = stepsFor(null).map((s) => ({ id: s.id, label: s.label, locked: s.id !== 'start' }));
  return (
    <>
      <Head><title>New video | Sonallo</title></Head>
      <MakerLayout title="New video" steps={steps} currentId="start">
        <StepStart onCreate={onCreate} onCreateForVideo={onCreateForVideo} onOpenProject={onOpenProject} returnTo="/app/new" />
      </MakerLayout>
    </>
  );
}
