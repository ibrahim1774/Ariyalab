import { useState } from 'react';

import Stepper from '../ui/Stepper';
import { ChatPanelSlot } from './slots';
import styles from './MakerLayout.module.css';

/**
 * The page frame (AppShell is added by _app.js): stepper on top, the step in the main column, and a
 * side slot for the chat panel that becomes a bottom sheet under 900 px.
 * `steps` = [{ id, label, stale?, locked? }]
 */
export default function MakerLayout({ title, steps, currentId, onSelect, quote, children, notice }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  return (
    <div className={styles.layout}>
      <header className={styles.top}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{title || 'New video'}</h1>
          <button
            type="button"
            className={styles.chatToggle}
            aria-expanded={sheetOpen}
            aria-controls="maker-chat"
            onClick={() => setSheetOpen((v) => !v)}
          >
            Chat helper
          </button>
        </div>
        <nav className={styles.steps} aria-label="Steps">
          <Stepper steps={steps} currentId={currentId} onSelect={onSelect} />
        </nav>
      </header>
      <div className={styles.body}>
        <section className={styles.main} aria-label="Current step">
          {notice}
          {children}
          {quote}
        </section>
        <aside
          id="maker-chat"
          className={`${styles.aside} ${sheetOpen ? styles.asideOpen : ''}`}
          aria-label="Chat helper"
          data-open={sheetOpen}
        >
          <button type="button" className={styles.sheetClose} onClick={() => setSheetOpen(false)}>
            Close
          </button>
          <ChatPanelSlot />
        </aside>
        {sheetOpen && <button type="button" className={styles.scrim} aria-label="Close chat helper" onClick={() => setSheetOpen(false)} />}
      </div>
    </div>
  );
}
