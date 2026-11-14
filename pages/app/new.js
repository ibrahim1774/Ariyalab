import Head from 'next/head';
import { useRouter } from 'next/router';

import MakerLayout from '../../components/maker/MakerLayout';
import StepStart from '../../components/maker/StepStart';
import { stepsFor } from '../../components/maker/steps';
import { createProject } from '../../lib/story/client';

export default function NewVideoPage() {
  const router = useRouter();
  // The project is created when the customer submits, never on load, so a reload makes no stray projects.
  async function onCreate(input) {
    const project = await createProject(input);
    await router.replace(`/app/p/${project.id}`);
  }
  const steps = stepsFor(null).map((s) => ({ id: s.id, label: s.label, locked: s.id !== 'start' }));
  return (
    <>
      <Head><title>New video | Ariya Lab</title></Head>
      <MakerLayout title="New video" steps={steps} currentId="start">
        <StepStart onCreate={onCreate} returnTo="/app/new" />
      </MakerLayout>
    </>
  );
}
