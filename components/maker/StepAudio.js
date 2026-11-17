import { useCallback, useEffect, useRef, useState } from 'react';

import Link from 'next/link';

import Button from '../ui/Button';
import Card from '../ui/Card';
import { getAudio, makeMusic, makeNarration, saveAudioPlan, uploadAudio } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import FilesNote from './FilesNote';
import { useMakerNav } from './MakerNav';
import { usePricing } from './PricingContext';
import StepFooter from './StepFooter';
import { Icon, Skeleton, Tile } from './Tiles';
import VoicePreview from './VoicePreview';
import steps from './Steps.module.css';
import styles from './StepAudio.module.css';

const POLL_MS = 3000;
const MOODS = ['Warm and hopeful', 'Upbeat and playful', 'Calm and cinematic'];
const CAPTION_STYLES = [
  { id: 'serif_accent', name: 'Serif with an accent word', sample: <>Every story starts <em>small</em></> },
  { id: 'bold_pop', name: 'Bold pop', sample: <>EVERY STORY STARTS <mark>SMALL</mark></> },
  { id: 'clean', name: 'Clean', sample: <>Every story starts small</> },
];

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const credits = (n) => `${n} ${n === 1 ? 'credit' : 'credits'}`;
/** "Make it again (5 credits)": the price is on the button whenever it costs something. */
const priced = (label, n) => (n > 0 ? `${label} (${credits(n)})` : label);

/** What the free allowance says: "2 tries included, then 5 credits". */
function allowance(track, regen) {
  if (track.free_left > 0) return `${track.free_left} ${track.free_left === 1 ? 'try' : 'tries'} included, then ${credits(regen)}`;
  return `${credits(regen)} each time`;
}

/** One track (narration or music): a designed state for none, waiting, ready, failed and blocked. */
function TrackBody({ track, kind, regen, ready, none, failedTitle, busy, onMake, onRetry, onChange, wait }) {
  const { status } = track;
  const again = priced('Make it again', track.credits);
  const player = track.url ? <audio className={styles.player} controls preload="metadata" src={track.url} aria-label={`${kind} preview`} /> : null;
  if (status === 'pending') {
    return <div className={styles.wait}><Skeleton status={wait.title} line={wait.line} /></div>;
  }
  if (status === 'failed' || status === 'blocked') {
    const blocked = status === 'blocked';
    const title = blocked ? 'Stopped by our content rules' : failedTitle;
    const fallback = blocked ? 'Change your words and try again.' : 'Nothing was charged for this try.';
    // The server's message goes in the body unless it only repeats the title.
    const text = track.error && track.error.replace(/[.\s]+$/, '') !== title ? track.error : fallback;
    const canRetry = !blocked && track.retry_credits !== null && track.retry_credits !== undefined;
    return (
      <>
        <Tile icon={blocked ? 'block' : 'alert'} tone="error" title={title} text={text} className={styles.state} />
        {player && <p className={styles.earlier}>Your earlier version is still here.</p>}
        {player}
        <div className={styles.actions}>
          {blocked && <Button variant="ghost" arrow={false} onClick={onChange}>{kind === 'narration' ? 'Back to the script' : 'Change the description'}</Button>}
          {canRetry ? (
            <Button arrow={false} onClick={onRetry} disabled={busy}>{priced('Try again', track.retry_credits)}</Button>
          ) : (
            <Button variant={blocked ? 'ghost' : 'primary'} arrow={false} onClick={onMake} disabled={busy}>{again}</Button>
          )}
        </div>
      </>
    );
  }
  if (status === 'ready') {
    return (
      <>
        {player}
        {ready}
        {track.outdated && <p className={styles.notice} role="status">Your script or voice changed since this was made. Make it again to match.</p>}
        {track.source !== 'upload' && (
          <div className={styles.actions}>
            <Button variant="ghost" arrow={false} onClick={onMake} disabled={busy}>{again}</Button>
            <span className={steps.hint}>{allowance(track, regen)}</span>
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <Tile icon={none.icon} title={none.title} text={none.text} className={styles.state} />
      <div className={styles.actions}>
        <Button arrow={false} onClick={onMake} disabled={busy}>{priced(none.button, track.credits)}</Button>
        <span className={steps.hint}>{allowance(track, regen)}</span>
      </div>
    </>
  );
}

/** "Use my own recording" / "Use my own track": a button that opens the file picker. Free, so it says so. */
function UploadRow({ label, uploading, disabled, onFile }) {
  const input = useRef(null);
  return (
    <div className={styles.own}>
      <input ref={input} type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4" className={styles.file} tabIndex={-1} aria-hidden="true"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
      <Button variant="ghost" arrow={false} onClick={() => input.current?.click()} disabled={disabled || Boolean(uploading)}>
        {uploading ? `Uploading ${uploading.percent}%…` : label}
      </Button>
      <span className={steps.hint}>Free. MP3, WAV or M4A, up to 20 MB.</span>
    </div>
  );
}

function Section({ icon, title, children, ...rest }) {
  return (
    <Card className={styles.card} {...rest}>
      <h3 className={styles.title}><span className={styles.titleIcon}><Icon name={icon} size={18} /></span>{title}</h3>
      {children}
    </Card>
  );
}

export default function StepAudio({ project, refresh, onNext, returnTo, doneLabel = 'Continue to generate' }) {
  const pricing = usePricing();
  const { goTo } = useMakerNav();
  const [audio, setAudio] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [uploading, setUploading] = useState(null); // { kind, percent } while the customer's own file goes up
  const [prompt, setPrompt] = useState('');
  const promptTouched = useRef(false);
  const promptBox = useRef(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await getAudio(project.id);
      if (!alive.current) return;
      setAudio(next);
      saved.current = { prompt: next.plan.music.prompt || '', audio: next };
      setLoadError(null);
      if (!promptTouched.current) setPrompt(next.plan.music.prompt || '');
    } catch (err) {
      if (alive.current) setLoadError(err);
    }
  }, [project.id]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  // While something is being made, look again every few seconds (not in a hidden tab).
  const waiting = audio && (audio.narration.status === 'pending' || audio.music.status === 'pending');
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, load]);

  async function run(kind, fn) {
    setBusy(kind);
    setError(null);
    try {
      const out = await fn();
      if (out && alive.current) {
        const next = out.audio || out;
        setAudio(next);
        saved.current = { prompt: next.plan.music.prompt || '', audio: next };
      }
      await refresh?.();
    } catch (err) {
      setError(err);
      // A price that changed or work already under way: show the truth.
      if (err?.status === 409) await load();
    } finally {
      if (alive.current) setBusy('');
    }
  }

  const savePlan = (patch, kind = 'plan') => run(kind, () => saveAudioPlan(project.id, patch));
  // The customer's own file: uploaded and checked by the server, then put in the plan. Nothing is charged.
  const uploadOwnFile = (file, kind, planFor) => run('upload', async () => {
    setUploading({ kind, percent: 0 });
    try {
      const asset = await uploadAudio(file, kind, { onProgress: (percent) => { if (alive.current) setUploading({ kind, percent }); } });
      return await saveAudioPlan(project.id, planFor(asset));
    } finally {
      if (alive.current) setUploading(null);
    }
  });
  const typed = () => prompt.replace(/\s+/g, ' ').trim();
  const saving = useRef(null);
  const saved = useRef({ prompt: null, audio: null }); // the last view the server gave and the description it holds
  // Saves the description when it changed; a save already under way is shared, never repeated. Throws when the
  // save fails, and then the customer's text stays as it is.
  async function persistPrompt() {
    while (saving.current) await saving.current.catch(() => {});
    if (!audio || typed() === (saved.current.prompt ?? (audio.plan.music.prompt || ''))) return null;
    const pending = saveAudioPlan(project.id, { music: { prompt: typed() } });
    saving.current = pending;
    try {
      const next = await pending;
      promptTouched.current = false;
      saved.current = { prompt: next.plan.music.prompt || '', audio: next };
      return next;
    } finally {
      saving.current = null;
    }
  }
  // The blur save has its own error handling and does not touch the busy state of a make.
  const commitPrompt = async () => {
    try {
      const next = await persistPrompt();
      if (next && alive.current) setAudio(next);
    } catch (err) {
      setError(err);
    }
  };
  const makeTrack = (kind, retry) => run(kind, async () => {
    // A description that cannot be saved stops the make: it would be charged for the old words.
    if (kind === 'music') {
      const next = await persistPrompt();
      if (next) setAudio(next);
    }
    // The newest view: this save's, or the blur save's that this make waited for.
    const current = (kind === 'music' && saved.current.audio) || audio;
    const track = current[kind];
    const price = retry ? track.retry_credits : track.credits;
    return (kind === 'music' ? makeMusic : makeNarration)(project.id, { retry, expectedCredits: Number.isInteger(price) ? price : undefined });
  });

  if (!audio) {
    return (
      <div className={steps.step}>
        <div className={steps.stepHead}><h2>Voice and <span className="accent-word">sound</span></h2></div>
        {loadError ? (
          <ErrorNotice error={loadError} returnTo={returnTo} onRefresh={load} />
        ) : (
          <Skeleton status="Loading your voice and sound" ratio="16 / 5" />
        )}
      </div>
    );
  }

  const { plan, voices, narration, music, applicable } = audio;
  const uploads = audio.uploads || { voiceTrack: null, music: null };
  const picked = voices.find((v) => v.id === plan.voiceId);
  const ownVoices = voices.some((v) => v.own);
  const own = Boolean(plan.voiceTrackAssetId);
  const noNarrator = applicable.narration && applicable.narrationLines === 0;
  const musicType = plan.music.type;
  const narrationMissing = applicable.narration && !noNarrator && !narration.url;

  return (
    <div className={steps.step}>
      <div className={steps.stepHead}>
        <h2>Voice and <span className="accent-word">sound</span></h2>
        <p>Choose who reads your story, add music, and pick how captions look. Making a voice or a song uses a few of your included tries first.</p>
      </div>
      <ErrorNotice error={error} returnTo={returnTo} onRefresh={load} />
      <p className={steps.srOnly} role="status" aria-live="polite">{waiting ? 'Your audio is being made' : ''}</p>

      <div className={styles.grid}>
        <Section icon="mic" title="Narration" data-section="narration">
          {!applicable.narration ? (
            <Tile icon="user" title="This video uses its own voices" text="Talking videos speak with the video model's voices, so there is no narrator to choose." className={styles.state} />
          ) : noNarrator ? (
            <>
              <Tile icon="text" title="No narrator lines yet" text="Your script has no lines for a narrator to read. Add some, then come back here." className={styles.state} />
              <div className={styles.actions}><Button variant="ghost" arrow={false} onClick={() => goTo?.('script')}>Back to the script</Button></div>
            </>
          ) : (
            <>
              <fieldset className={styles.voices} disabled={own || busy === 'plan'}>
                <legend>Voice</legend>
                {voices.map((v) => (
                  <label key={v.id} className={`${styles.voice} ${plan.voiceId === v.id && !own ? styles.voiceOn : ''}`}>
                    <input type="radio" name="voice" value={v.id} checked={plan.voiceId === v.id} onChange={() => savePlan({ voiceId: v.id })} />
                    <strong>{v.name}</strong>
                    {v.own ? <small>Your voice</small> : v.gender && <small>{v.gender}</small>}
                  </label>
                ))}
              </fieldset>
              {picked && !own && <VoicePreview sampleUrl={picked.sampleUrl} name={picked.name} label="Voice sample" />}
              {!own && (
                <Link href="/app/voices" className={styles.cloneLink}>{ownVoices ? 'Manage my voices' : 'Clone my voice'}</Link>
              )}
              {own ? (
                <div className={styles.ownFile}>
                  <p className={styles.ownName}><strong>{uploads.voiceTrack?.name || 'Your recording'}</strong>{uploads.voiceTrack?.seconds ? <span>{clock(uploads.voiceTrack.seconds)}</span> : null}</p>
                  <p className={steps.hint}>Using your own recording. It costs nothing.</p>
                  <div className={styles.actions}>
                    <Button variant="ghost" arrow={false} onClick={() => savePlan({ voiceTrackAssetId: null })} disabled={busy === 'plan'} aria-label="Remove my recording">Remove</Button>
                  </div>
                </div>
              ) : (
                <UploadRow label="Use my own recording" uploading={uploading?.kind === 'voice_track' ? uploading : null} disabled={busy !== '' && busy !== 'upload'}
                  onFile={(f) => uploadOwnFile(f, 'voice_track', (a) => ({ voiceTrackAssetId: a.id }))} />
              )}
              <TrackBody
                track={narration}
                kind="narration"
                regen={pricing.narrationRegen}
                busy={busy === 'narration'}
                onChange={() => goTo?.('script')}
                wait={{ title: own ? 'Cutting your recording into lines' : 'Recording the narration', line: 'This takes about a minute. The page updates by itself.' }}
                failedTitle="The voice could not be made"
                none={{ icon: 'mic', title: 'Not recorded yet', text: `Your narrator reads ${applicable.narrationLines} ${applicable.narrationLines === 1 ? 'line' : 'lines'}. Record it once the script is how you want it.`, button: own ? 'Use my recording' : 'Make the narration' }}
                onMake={() => makeTrack('narration', false)}
                onRetry={() => makeTrack('narration', true)}
                ready={narration.segments ? (
                  <details className={styles.lines}>
                    <summary>{narration.seconds ? `${clock(narration.seconds)} long, ` : ''}{narration.segments.length} {narration.segments.length === 1 ? 'line' : 'lines'}</summary>
                    <ol>
                      {narration.segments.map((s) => (
                        <li key={`${s.sceneId}-${s.lineIndex}`}><time>{clock(s.start)}</time><span>{s.text}</span></li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              />
            </>
          )}
        </Section>

        <Section icon="music" title="Music" data-section="music">
          <div className={styles.segmented} role="radiogroup" aria-label="Music">
            {[['generated', 'Make music for me'], ['none', 'No music']].map(([id, label]) => (
              <label key={id} className={musicType === id ? styles.segOn : ''}>
                <input type="radio" name="music" value={id} checked={musicType === id} disabled={busy === 'plan'} onChange={() => savePlan({ music: { type: id } })} />
                {label}
              </label>
            ))}
            {musicType === 'upload' && <label className={styles.segOn}><input type="radio" name="music" value="upload" checked readOnly />My own track</label>}
          </div>
          {musicType === 'none' && (
            <>
              <Tile icon="music" title="No music" text="Your video will have the narration only. Switch back any time." className={styles.state} />
              <UploadRow label="Use my own track" uploading={uploading?.kind === 'music' ? uploading : null} disabled={busy !== '' && busy !== 'upload'}
                onFile={(f) => uploadOwnFile(f, 'music', (a) => ({ music: { type: 'upload', assetId: a.id } }))} />
            </>
          )}
          {musicType === 'upload' && (
            <div className={styles.ownFile}>
              <p className={styles.ownName}><strong>{uploads.music?.name || 'Your track'}</strong>{uploads.music?.seconds ? <span>{clock(uploads.music.seconds)}</span> : null}</p>
              <p className={steps.hint}>Using your own track. It costs nothing.</p>
              {music.url && <audio className={styles.player} controls preload="metadata" src={music.url} aria-label="Your track" />}
              <div className={styles.actions}>
                <Button variant="ghost" arrow={false} onClick={() => savePlan({ music: { type: 'generated' } })} disabled={busy === 'plan'}>Make music for me instead</Button>
              </div>
            </div>
          )}
          {musicType === 'generated' && (
            <>
              <label className={steps.field}>
                What should it sound like?
                <textarea ref={promptBox} rows={2} maxLength={300} value={prompt} placeholder="Warm, hopeful piano with a soft beat" onChange={(e) => { promptTouched.current = true; setPrompt(e.target.value); }} onBlur={commitPrompt} />
              </label>
              <div className={styles.moods} aria-label="Ideas">
                {MOODS.map((m) => <button key={m} type="button" onClick={() => { promptTouched.current = true; setPrompt(m); }}>{m}</button>)}
              </div>
              <p className={steps.hint}>It always starts full from the first second, with no soft intro.</p>
              <TrackBody
                track={music}
                kind="music"
                regen={pricing.musicRegen}
                busy={busy === 'music'}
                onChange={() => promptBox.current?.focus()}
                wait={{ title: 'Composing your music', line: 'This takes about a minute. The page updates by itself.' }}
                failedTitle="The music could not be made"
                none={{ icon: 'music', title: 'No music yet', text: 'Describe the mood above, or just make it and we will pick something gentle.', button: 'Make the music' }}
                onMake={() => makeTrack('music', false)}
                onRetry={() => makeTrack('music', true)}
              />
              <UploadRow label="Use my own track" uploading={uploading?.kind === 'music' ? uploading : null} disabled={busy !== '' && busy !== 'upload'}
                onFile={(f) => uploadOwnFile(f, 'music', (a) => ({ music: { type: 'upload', assetId: a.id } }))} />
            </>
          )}
        </Section>

        <Section icon="captions" title="Captions" data-section="captions">
          <label className={styles.switch}>
            <input type="checkbox" checked={plan.captions.on} disabled={busy === 'plan'} onChange={(e) => savePlan({ captions: { on: e.target.checked } })} />
            Show captions on the video
          </label>
          <div className={styles.captionStyles} role="radiogroup" aria-label="Caption style">
            {CAPTION_STYLES.map((c) => (
              <label key={c.id} className={`${styles.captionStyle} ${plan.captions.style === c.id ? styles.captionOn : ''}`} data-caption={c.id}>
                <input type="radio" name="captions" value={c.id} checked={plan.captions.style === c.id} disabled={!plan.captions.on || busy === 'plan'} onChange={() => savePlan({ captions: { style: c.id } })} />
                <span className={styles.sample}>{c.sample}</span>
                <small>{c.name}</small>
              </label>
            ))}
          </div>
          <p className={steps.hint}>Captions are added when your video is finished.</p>
        </Section>
      </div>

      <FilesNote project={project} />
      <StepFooter>
        <Button onClick={onNext}>{doneLabel}</Button>
        {narrationMissing && (
          <span className={steps.hint}>{narration.status === 'pending' ? 'The narration is still being made.' : 'There is no narration yet, so the video would have no voice.'}</span>
        )}
      </StepFooter>
    </div>
  );
}
