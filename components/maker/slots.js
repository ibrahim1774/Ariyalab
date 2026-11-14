// Marked places that later tasks fill. Each one is a small, self-contained card so a later task
// replaces the body of one function and nothing else. Search for "SLOT" to find them.
import Card from '../ui/Card';
import styles from './Steps.module.css';

function Slot({ slot, title, children }) {
  return (
    <Card className={styles.slot} data-slot={slot}>
      <h3>{title}</h3>
      <p>{children}</p>
    </Card>
  );
}

// SLOT: reference breakdown (step 5). Filled by the reference analysis task. Props: { project }.
export function ReferenceBreakdownSlot() {
  return <Slot slot="reference-breakdown" title="Breakdown of your video">The shot by shot breakdown of your reference video shows up here when it is ready.</Slot>;
}

// SLOT: voice and sound (step 9). Filled by the audio task. Props: { project, status, refresh }.
export function VoiceSoundSlot() {
  return <Slot slot="voice-sound" title="Voice and sound">Narrator voice, music and captions are chosen here. They are coming in the next update, so you can carry on for now.</Slot>;
}

// SLOT: finish (step 12). Filled by the render task. Props: { project, status, refresh }.
export function FinishSlot() {
  return <Slot slot="finish" title="Your finished video">Preview and download of the finished video appear here.</Slot>;
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
    <Card className={styles.slot} data-slot="start-from-video">
      <h3>Start from a video</h3>
      <p>Upload a video or paste a link and we will build your story from how it is told. Coming soon.</p>
    </Card>
  );
}
