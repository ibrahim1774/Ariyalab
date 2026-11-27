import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';

import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';
import ProjectCard from '../../components/app/ProjectCard';
import styles from '../../styles/AppPages.module.css';
import { markInApp, wasInApp } from '../../lib/appVisit';
import useLegacyPlan from '../../lib/useLegacyPlan';

export default function AppHome() {
  // null = still loading. Any non-200 (including a route that is not built yet) shows the empty state.
  const [projects, setProjects] = useState(null);
  const router = useRouter();

  // Customers on an old plan land on the classic Image to Video page instead, unless they asked for the story maker
  // (?maker=1) or already chose it in this tab. Only this home page ever redirects; /legacy-home never sends anyone back.
  // Nothing but the loading line shows until the plan is known (at most 1.5 s, then the story maker shows).
  const { loaded, legacyPlan, classicUrl } = useLegacyPlan();
  const [gate, setGate] = useState('check'); // 'check' | 'open'
  const gateRef = useRef('check');
  const open = () => { gateRef.current = 'open'; setGate('open'); };
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('maker') === '1') markInApp();
    if (wasInApp()) { open(); return undefined; }
    const timer = setTimeout(() => { if (gateRef.current === 'check') open(); }, 1500);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!loaded || gateRef.current !== 'check') return;
    if (legacyPlan && classicUrl) { gateRef.current = 'classic'; setGate('classic'); } // billing v2: the plan lives on the classic site
    else if (legacyPlan) router.replace('/legacy-home');
    else open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, legacyPlan]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/story/projects');
        if (!r.ok) throw new Error('unavailable');
        const data = await r.json();
        const list = Array.isArray(data) ? data : data?.projects;
        if (alive) setProjects(Array.isArray(list) ? list : []);
      } catch {
        if (alive) setProjects([]);
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <>
      <Head><title>Projects | Sonallo</title></Head>
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Your <span className="accent-word">stories</span></h1>
            <p className={styles.sub}>Every animated video you have started, in one place.</p>
          </div>
          <Button href="/app/new">New video</Button>
        </div>

        {gate === 'classic' && (
          <Card className={styles.empty} data-testid="classic-notice">
            <h2>Your Ariya Lab plan lives on ariyalab.online</h2>
            <p>Your plan and credits are on the Ariya Lab site. Sonallo has its own plans.</p>
            <Button href={classicUrl}>Go to ariyalab.online</Button>
          </Card>
        )}

        {gate === 'check' ? (
          <p className={styles.note}>Loading your projects…</p>
        ) : projects === null ? (
          <p className={styles.note}>Loading your projects…</p>
        ) : projects.length === 0 ? (
          <Card className={styles.empty}>
            <h2>No videos yet</h2>
            <p>Start with an idea or a reference video and build it into an animated story.</p>
            <Button href="/app/new">New video</Button>
          </Card>
        ) : (
          <div className={styles.grid}>
            {projects.map((p) => <ProjectCard key={p.id} project={p} onDeleted={(id) => setProjects((list) => (list || []).filter((x) => x.id !== id))} />)}
          </div>
        )}
      </div>
    </>
  );
}
