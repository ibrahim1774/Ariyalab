import { useEffect, useState } from 'react';
import Head from 'next/head';

import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';
import ProjectCard from '../../components/app/ProjectCard';
import styles from '../../styles/AppPages.module.css';

export default function AppHome() {
  // null = still loading. Any non-200 (including a route that is not built yet) shows the empty state.
  const [projects, setProjects] = useState(null);

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
      <Head><title>Projects | Ariya Lab</title></Head>
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Your <span className="accent-word">stories</span></h1>
            <p className={styles.sub}>Every animated video you have started, in one place.</p>
          </div>
          <Button href="/app/new">New video</Button>
        </div>

        {projects === null ? (
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
