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
import Describe from './Describe';
import { SCREENS, deriveScreen, screenIndex } from './derive';
import styles from './Simple.module.css';

const CHAT_NOTES = {
  describe: null,
  script: 'Here is your script. Want to change anything?',
  plan: 'Here is the plan. Want to change anything?',
  watch: 'Want to change anything?',
};

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
        returnTo={returnTo}
      />
    );
  } else {
    body = <p className={styles.muted}>This screen is coming.</p>;
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
          note={CHAT_NOTES[screen]}
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
