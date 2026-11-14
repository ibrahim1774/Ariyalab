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
  const [stepsOpen, setStepsOpen] = useState(false);
  const position = Math.max(0, steps.findIndex((st) => st.id === currentId));
  const currentLabel = steps[position]?.label || '';
  return (
    <div className={styles.layout}>
      <header className={styles.top}>
        <div className={styles.titleRow}>
          <h1 className={styles.title} title={title || 'New video'}>{title || 'New video'}</h1>
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
          <Stepper steps={steps} currentId={currentId} onSelect={onSelect} fit />
        </nav>
        <button type="button" className={styles.stepSummary} aria-label="Show all steps" aria-expanded={stepsOpen} onClick={() => setStepsOpen((v) => !v)}>
          <span>Step {position + 1} of {steps.length}, {currentLabel}</span>
          <span aria-hidden="true" className={styles.chevron}>{stepsOpen ? '▴' : '▾'}</span>
        </button>
        {stepsOpen && (
          <>
            <button type="button" className={styles.scrim} aria-label="Close step list" onClick={() => setStepsOpen(false)} />
            <ol className={styles.stepSheet} aria-label="All steps">
              {steps.map((st, i) => (
                <li key={st.id}>
                  <button
                    type="button"
                    disabled={st.locked}
                    aria-current={st.id === currentId ? 'step' : undefined}
                    onClick={() => {
                      setStepsOpen(false);
                      onSelect?.(st.id);
                    }}
                  >
                    <span className={styles.sheetNumber}>{i + 1}</span>
                    <span>{st.label}</span>
                    {st.stale && <span className={styles.sheetBadge}>Needs update</span>}
                  </button>
                </li>
              ))}
            </ol>
          </>
        )}
      </header>
      <div className={styles.body}>
        <section className={`${styles.main} ${quote ? styles.withDock : ''}`} aria-label="Current step">
          {notice}
          {children}
        </section>
        <div className={styles.side}>
          {quote && <div className={styles.dock}>{quote}</div>}
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
        </div>
        {sheetOpen && <button type="button" className={styles.scrim} aria-label="Close chat helper" onClick={() => setSheetOpen(false)} />}
      </div>
    </div>
  );
}
