// Marked places that later tasks fill. Each one is a small, self-contained card so a later task
// replaces the body of one function and nothing else. Search for "SLOT" to find them.
import { useState } from 'react';
import Button from '../ui/Button';
import Card from '../ui/Card';
import { startRender } from '../../lib/story/client';
import { describeError } from './errors';
import { Icon } from './Tiles';
import styles from './Steps.module.css';

function Slot({ slot, title, icon = 'spark', children }) {
  return (
    <Card className={styles.slot} data-slot={slot} data-media-card="">
      <span className={styles.slotIcon} data-tile="slot"><Icon name={icon} /></span>
      <h3>{title}</h3>
      <p>{children}</p>
    </Card>
  );
}

// SLOT: reference breakdown (step 5). Filled by the reference analysis task. Props: { project }.
export function ReferenceBreakdownSlot() {
  return <Slot slot="reference-breakdown" title="Breakdown of your video" icon="film">The shot by shot breakdown of your reference video shows up here when it is ready.</Slot>;
}

// SLOT: voice and sound (step 9). Filled by the audio task. Props: { project, status, refresh }.
export function VoiceSoundSlot() {
  return <Slot slot="voice-sound" title="Voice and sound" icon="spark">Narrator voice, music and captions are chosen here. They are coming in the next update, so you can carry on for now.</Slot>;
}

// SLOT: finish (step 12). The full Finish screen is Task 21; until then a minimal "Make my video" trigger
// (Task 20). Props: { project, status, refresh }. With no project it renders the plain placeholder.
export function FinishSlot({ project, status, refresh }) {
  if (!project) {
    return <Slot slot="finish" title="Your finished video" icon="film">Preview and download of the finished video appear here.</Slot>;
  }
  return <MakeVideo project={project} render={status?.render || null} refresh={refresh} />;
}

const RENDER_TEXT = {
  queued: 'Your video is being made. This takes a minute or two.',
  running: 'Your video is being made. This takes a minute or two.',
  failed: 'The video could not be made this time.',
};

function MakeVideo({ project, render, refresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const working = render && (render.status === 'queued' || render.status === 'running');
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await startRender(project.id);
      refresh?.();
    } catch (err) {
      // A refusal the server explains (audio_not_ready, shots_not_ready, render_busy) is shown in its own words.
      setError({ ...describeError(err), server: err?.serverMessage || '' });
      if (err?.status === 409) refresh?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className={styles.slot} data-slot="finish" data-media-card="">
      <span className={styles.slotIcon} data-tile="slot"><Icon name="film" /></span>
      <h3>Your finished video</h3>
      {render?.status === 'done' && render.url ? (
        <p>
          Version {render.version} is ready. <a href={render.url} target="_blank" rel="noreferrer">Watch your video</a>
        </p>
      ) : (
        <p>{render ? RENDER_TEXT[render.status] || '' : 'Put your clips, voice, music and captions together into one video.'}</p>
      )}
      {render?.status === 'failed' && render.error ? <p>{render.error}</p> : null}
      {error ? <p role="alert">{error.server || error.message || error.title}</p> : null}
      <Button onClick={start} disabled={busy || Boolean(working)}>
        {render?.status === 'done' ? 'Make it again' : render?.status === 'failed' ? 'Try again' : 'Make my video'}
      </Button>
    </Card>
  );
}

// SLOT: chat panel. Filled by the chat task. Props: { project }.
export function ChatPanelSlot() {
  return (
    <div className={styles.chatSlot} data-slot="chat-panel">
      <h3>Chat helper</h3>
      <p>Ask for changes in plain words. This panel is coming soon. You can still edit every step by hand.</p>
    </div>
  );
}

// SLOT: asset picker. Filled by the brand kit task. Lets the customer pick their own image or clip.
// Props: { label, kind: 'image' | 'footage' }. Renders disabled until the brand kit exists.
export function AssetPickerSlot({ label = 'Use my own image' }) {
  return (
    <button type="button" className={styles.slotButton} disabled data-slot="asset-picker" aria-label={`${label} (coming with brand kit)`}>
      {label}
      <small>coming with brand kit</small>
    </button>
  );
}

// SLOT: "Start from a video" door on the first screen. Filled by the reference analysis task.
// Props: { onStart(source) } where source is { type: 'upload', assetId } or { type: 'link', url }.
export function StartFromVideoSlot() {
  return (
    <Card className={styles.slot} data-slot="start-from-video" data-media-card="">
      <span className={styles.slotIcon} data-tile="slot"><Icon name="film" /></span>
      <h3>Start from a video</h3>
      <p>Upload a video or paste a link and we will build your story from how it is told. Coming soon.</p>
    </Card>
  );
}
