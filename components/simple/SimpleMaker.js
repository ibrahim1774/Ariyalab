import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { createProject } from '../../lib/story/client';
import ChatPanel from '../maker/ChatPanel';
import ErrorNotice from '../maker/ErrorNotice';
import { signInHref } from '../maker/errors';
import MakerLayout from '../maker/MakerLayout';
import { PricingProvider } from '../maker/PricingContext';
import useProject from '../maker/useProject';
import CheckPlan from './CheckPlan';
import CheckScript from './CheckScript';
import Describe from './Describe';
import Watch from './Watch';
import { SCREENS, deriveScreen, screenIndex } from './derive';
import usePlanPipeline from './usePlanPipeline';
import styles from './Simple.module.css';

const CHAT_NOTES = {
  describe: null,
  script: 'Here is your script. Want to change anything?',
  plan: 'Here is the plan. Want to change anything?',
  watch: 'Want to change anything?',
};

/** The chat's short prompt for the screen, only once that stage has finished (nothing while it is still being made). */
function chatNote(screen, data, plan) {
  if (screen === 'plan') return plan.action.type === 'done' ? CHAT_NOTES.plan : null;
  if (screen === 'watch') return data.render?.status === 'done' ? 'Your video is ready. Want to change anything?' : null;
  return CHAT_NOTES[screen];
}

const BACK_LABELS = { describe: 'Back to the script', script: 'Back to the script', plan: 'Back to the plan', watch: 'Back to your video' };

function Aside({ text }) {
  return (
    <div className={styles.asideCard} data-slot="chat-panel">
      <h3>Chat helper</h3>
      <p>{text}</p>
    </div>
  );
}

/** The simple maker for one project (or, with no id, the first screen of a new one): four screens derived from server state. */
function SimpleMakerInner({ id, returnTo }) {
  const router = useRouter();
  const data = useProject(id);
  const { project, loading, error, refresh, save } = data;
  const derived = id ? deriveScreen(data) : 'describe';
  const [manual, setManual] = useState(null);
  const lastDerived = useRef(derived);
  const [scriptRev, setScriptRev] = useState(0);
  const [prefill, setPrefill] = useState(null);
  const [openChat, setOpenChat] = useState(0);

  // The server moved the project forward: follow it. Going back is only a view, and ends the moment the server moves on.
  useEffect(() => {
    if (lastDerived.current !== derived) {
      lastDerived.current = derived;
      setManual(null);
    }
  }, [derived]);

  useEffect(() => {
    if (error?.status === 401 && typeof window !== 'undefined') window.location.assign(signInHref(returnTo));
  }, [error, returnTo]);

  const screen = manual || derived;
  // The plan pipeline lives here, not in a screen: it carries on while the customer moves between screens.
  const plan = usePlanPipeline({
    status: data,
    screen: derived,
    refresh,
    quoteKey: `${project?.seconds}|${project?.quality}|${project?.fee_charged}|${project?.consistent_cast}|${scriptRev}`,
  });
  const goTo = useCallback((target) => setManual(target === derived ? null : target), [derived]);
  const askChat = useCallback((text) => {
    setPrefill({ text, nonce: Date.now() });
    setOpenChat((n) => n + 1);
  }, []);

  const steps = SCREENS.map((s, i) => ({ id: s.id, label: s.label, locked: i > screenIndex(derived) }));
  const editorHref = id ? `/app/p/${encodeURIComponent(id)}?view=steps` : '/app/new?view=steps';

  async function onCreate(input) {
    return createProject(input);
  }
  const onOpen = async (newId) => { await router.replace(`/app/p/${newId}`); };

  let body;
  if (id && !project) {
    body = loading ? (
      <p className={styles.muted} role="status">Loading your video…</p>
    ) : (
      <>
        <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
        <Link href="/app">Back to your videos</Link>
      </>
    );
  } else if (screen === 'describe') {
    body = (
      <Describe
        key={project ? `${project.id}:${project.reference_id || ''}` : 'new'}
        project={project}
        onCreate={onCreate}
        onOpen={onOpen}
        save={save}
        refresh={refresh}
        onDone={() => setManual(null)}
        backLabel={BACK_LABELS[derived]}
        returnTo={returnTo}
      />
    );
  } else if (screen === 'script') {
    body = (
      <CheckScript
        key={scriptRev}
        project={project}
        plan={plan}
        refresh={refresh}
        returnTo={returnTo}
        revisit={derived !== 'script' ? { label: BACK_LABELS[derived], onBack: () => setManual(null) } : null}
      />
    );
  } else if (screen === 'plan') {
    body = <CheckPlan project={project} shots={data.shots} cast={data.cast} audio={data.audio} plan={plan} refresh={refresh} returnTo={returnTo} />;
  } else {
    body = <Watch status={data} project={project} refresh={refresh} returnTo={returnTo} onAskChat={askChat} />;
  }

  return (
    <MakerLayout
      title={project?.title || 'New video'}
      steps={steps}
      currentId={screen}
      onSelect={goTo}
      stepsLabel="Screens"
      extra={<Link href={editorHref}>Detailed editor</Link>}
      openChat={openChat}
      notice={error && project ? <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} /> : null}
      chat={project ? (
        <ChatPanel
          project={project}
          returnTo={returnTo}
          prefill={prefill}
          note={chatNote(screen, data, plan)}
          onChanged={(changed) => {
            refresh();
            if (Array.isArray(changed) && changed.includes('script')) setScriptRev((n) => n + 1);
          }}
        />
      ) : <Aside text="Tell me your idea in one line. I pick a style, a length and a quality to start, and you can change them." />}
    >
      <div data-script-rev={scriptRev}>{body}</div>
    </MakerLayout>
  );
}

export default function SimpleMaker(props) {
  return (
    <PricingProvider>
      <SimpleMakerInner {...props} />
    </PricingProvider>
  );
}
