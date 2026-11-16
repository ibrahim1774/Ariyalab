import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';

import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';
import ErrorNotice from '../../components/maker/ErrorNotice';
import { EmptyState, Icon, Skeleton, Tile } from '../../components/maker/Tiles';
import VoicePreview from '../../components/maker/VoicePreview';
import { cloneVoice, deleteVoiceClone, getVoices, retryVoiceClone, uploadAudio } from '../../lib/story/client';
import styles from '../../styles/Voices.module.css';

const POLL_MS = 3000;
const credits = (n) => `${n} ${n === 1 ? 'credit' : 'credits'}`;
const seconds = (n) => `${Math.round(n)} ${Math.round(n) === 1 ? 'second' : 'seconds'}`;

/** One of the customer's clones: waiting, failed or ready, each a designed state. */
function VoiceItem({ voice, price, busy, confirming, onRetry, onAskDelete, onDelete, onKeep }) {
  return (
    <li className={styles.item} data-status={voice.status}>
      <div className={styles.itemHead}>
        <strong>{voice.name}</strong>
        <span className={`${styles.badge} ${styles[voice.status]}`}>{voice.status === 'ready' ? 'Ready' : voice.status === 'pending' ? 'Cloning' : 'Failed'}</span>
      </div>
      {voice.status === 'pending' && (
        <div className={styles.wait}><Skeleton status="Cloning your voice" line="This takes about a minute. You can leave this page, it carries on." /></div>
      )}
      {voice.status === 'failed' && (
        <>
          <Tile icon="alert" tone="error" title="The voice could not be cloned" text={voice.error || 'Nothing was charged for this try.'} className={styles.state} />
          <div className={styles.actions}>
            {voice.retry_credits !== null && voice.retry_credits !== undefined && (
              <Button arrow={false} onClick={onRetry} disabled={busy}>{`Try again (${credits(voice.retry_credits ?? price)})`}</Button>
            )}
          </div>
        </>
      )}
      {voice.status === 'ready' && (
        <>
          <VoicePreview sampleUrl={voice.sampleUrl} name={voice.name} label={`${voice.name} sample`} />
          <p className={styles.hint}>Ready to pick on the Voice and sound step</p>
        </>
      )}
      {voice.status !== 'pending' && (
        confirming ? (
          <div className={styles.confirm} role="group" aria-label={`Delete ${voice.name}`}>
            <span>Delete this voice? It is removed from your account, and any video that uses it needs another voice.</span>
            <div className={styles.actions}>
              <Button variant="ghost" arrow={false} onClick={onDelete} disabled={busy}>Yes, delete it</Button>
              <Button variant="ghost" arrow={false} onClick={onKeep}>Keep it</Button>
            </div>
          </div>
        ) : (
          <button type="button" className={styles.link} onClick={onAskDelete} aria-label={`Delete ${voice.name}`} disabled={busy}>Delete</button>
        )
      )}
    </li>
  );
}

export default function VoicesPage() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [sample, setSample] = useState(null);
  const [progress, setProgress] = useState(null); // null, or 0 to 100 while a sample uploads
  const [consent, setConsent] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const alive = useRef(true);
  const fileInput = useRef(null);

  const load = useCallback(async () => {
    try {
      const next = await getVoices();
      if (!alive.current) return;
      setData(next);
      setLoadError(null);
    } catch (err) {
      if (alive.current) setLoadError(err);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  // A clone that is still being made (from this page or an earlier visit): look again every few seconds.
  const waiting = Boolean(data?.voices.some((v) => v.status === 'pending'));
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, load]);

  async function attempt(fn, { id = '' } = {}) {
    setError(null);
    setBusyId(id);
    try {
      return await fn();
    } catch (err) {
      setError(err);
      return null;
    } finally {
      if (alive.current) setBusyId('');
      // Whatever happened, the list is the truth: a failed clone is a row to try again, a changed price is a new price.
      await load();
    }
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const made = await uploadAudio(file, 'voice_sample', { onProgress: (p) => alive.current && setProgress(p) });
      if (alive.current) setSample(made);
    } catch (err) {
      if (alive.current) { setSample(null); setError(err); }
    } finally {
      if (alive.current) setProgress(null);
    }
  }

  async function onClone(e) {
    e.preventDefault();
    if (!canClone) return;
    setCloning(true);
    const done = await attempt(() => cloneVoice({ name: name.trim(), consent: true, sampleAssetId: sample.id, expectedCredits: data.price }));
    if (alive.current) {
      setCloning(false);
      if (done) { setName(''); setSample(null); setConsent(false); }
    }
  }

  const price = data?.price;
  const canClone = Boolean(data && name.trim() && sample && consent && !cloning && progress === null);

  return (
    <>
      <Head><title>Voices | Ariya Lab</title></Head>
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Your <span className="accent-word">voices</span></h1>
            <p className={styles.sub}>Clone your own voice from a short recording, then pick it to read your story on the Voice and sound step. A clone is private to you.</p>
          </div>
        </div>

        <ErrorNotice error={loadError || error} returnTo="/app/voices" onRefresh={load} />
        {loadError && <div className={styles.actions}><Button variant="ghost" arrow={false} onClick={load}>Refresh</Button></div>}

        {!data && !loadError && <div className={styles.wait}><Skeleton status="Loading your voices" ratio="16 / 5" /></div>}

        {data && (
          <>
            <div className={styles.layout}>
              <Card className={styles.card} data-card="">
                <h2 className={styles.h2}><span className={styles.icon}><Icon name="mic" size={18} /></span>Clone your voice</h2>
                <form className={styles.form} onSubmit={onClone}>
                  <p className={styles.hint}>
                    Upload one clear recording of the voice, {data.limits.sampleMinSeconds} to {data.limits.sampleMaxSeconds} seconds long, with no music or other voices behind it. MP3, WAV or M4A, up to 20 MB.
                  </p>
                  <label className={styles.field}>
                    Name this voice
                    <input type="text" value={name} maxLength={60} placeholder="My voice" onChange={(e) => setName(e.target.value)} disabled={cloning} />
                  </label>
                  <div className={styles.sample}>
                    <input ref={fileInput} type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4" className={styles.file} onChange={onFile} tabIndex={-1} aria-hidden="true" />
                    {sample ? (
                      <>
                        <p className={styles.sampleName}><strong>{sample.name || 'Your sample'}</strong><span>{seconds(sample.seconds)}</span></p>
                        <audio className={styles.player} controls preload="metadata" src={sample.url} aria-label="Your sample" />
                      </>
                    ) : (
                      <Tile icon="upload" title={progress === null ? 'No sample yet' : `Uploading ${progress}%`} text={progress === null ? 'Upload a recording of the voice to clone.' : 'Keep this page open until it finishes.'} className={styles.state} />
                    )}
                    <Button variant="ghost" arrow={false} onClick={() => fileInput.current?.click()} disabled={progress !== null || cloning}>
                      {progress !== null ? 'Uploading…' : sample ? 'Use a different sample' : 'Upload a sample'}
                    </Button>
                  </div>
                  <label className={styles.consent}>
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={cloning} />
                    <span>{data.statement}</span>
                  </label>
                  <div className={styles.actions}>
                    <Button type="submit" arrow={false} disabled={!canClone}>{cloning ? 'Cloning…' : `Clone this voice (${credits(price)})`}</Button>
                  </div>
                  <p className={styles.hint}>You are charged only once the voice has been made. If it fails, nothing is charged.</p>
                </form>
              </Card>

              <section aria-label="Your voices" className={styles.section}>
                <h2 className={styles.h2}>Your voices</h2>
                {data.voices.length === 0 && !cloning ? (
                  <EmptyState icon="mic" title="No cloned voices yet" text="Your first clone will show up here, ready to pick for any video.">
                    <Button variant="ghost" arrow={false} onClick={() => fileInput.current?.click()} disabled={progress !== null}>Upload a sample</Button>
                  </EmptyState>
                ) : (
                  <ul className={styles.list}>
                    {cloning && !waiting && (
                      <li className={styles.item} data-status="pending">
                        <div className={styles.itemHead}><strong>{name.trim() || 'New voice'}</strong><span className={`${styles.badge} ${styles.pending}`}>Cloning</span></div>
                        <div className={styles.wait}><Skeleton status="Cloning your voice" line="This takes about a minute. You can leave this page, it carries on." /></div>
                      </li>
                    )}
                    {data.voices.map((v) => (
                      <VoiceItem
                        key={v.id}
                        voice={v}
                        price={price}
                        busy={busyId === v.id}
                        confirming={confirmId === v.id}
                        onRetry={() => attempt(() => retryVoiceClone(v.id, v.retry_credits ?? price), { id: v.id })}
                        onAskDelete={() => setConfirmId(v.id)}
                        onKeep={() => setConfirmId('')}
                        onDelete={async () => { await attempt(() => deleteVoiceClone(v.id), { id: v.id }); setConfirmId(''); }}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section aria-label="Included voices" className={styles.section}>
              <h2 className={styles.h2}>Included voices</h2>
              <ul className={styles.presets}>
                {data.presets.map((p) => (
                  <li key={p.id} className={styles.preset}>
                    <div className={styles.itemHead}><strong>{p.name}</strong>{p.gender && <small>{p.gender}</small>}</div>
                    <VoicePreview sampleUrl={p.sampleUrl} name={p.name} label={`${p.name} sample`} compact />
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </>
  );
}
