import { useCallback, useEffect, useRef, useState } from 'react';

import * as client from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import styles from './ChatPanel.module.css';

const SUGGESTIONS = ['Make the opening funnier', 'Make it 45 seconds', 'What will the video cost?'];

/**
 * One confirm card: a priced action the chat did not do. The button sends the card's id; the server runs the card it
 * stored, once. A used card shows "Started"; an out of date one (the price moved, or a newer card replaced it) cannot
 * be pressed.
 */
function ConfirmCard({ projectId, item, returnTo, onDone, onStale }) {
  const [message, setMessage] = useState('');
  const [state, setState] = useState(item.state || 'open'); // open | busy | used | outdated
  // The server's state wins whenever the panel reloads (another tab may have pressed it).
  useEffect(() => {
    setState((current) => (current === 'busy' ? current : item.state || 'open'));
  }, [item.state]);
  const [error, setError] = useState(null);
  const { quote, confirm } = item;
  const note = confirm?.body?.note;
  const press = async () => {
    setState('busy');
    setError(null);
    try {
      const out = await client.confirmChatAction(projectId, item.id);
      setMessage(typeof out?.message === 'string' ? out.message : '');
      // A card for something already done answers with the server's words ("It was already set that way."), not "Out of date".
      setState(out?.queued === false && !out?.message ? 'outdated' : 'used');
      onDone?.();
    } catch (err) {
      if (err?.code === 'confirm_used') setState('used');
      else if (err?.code === 'confirm_outdated') setState('outdated');
      else setState('open');
      setError(err?.code === 'confirm_used' ? null : err);
      // Lost to another press or a price change: read every card again, and what the winner changed.
      if (err?.code === 'confirm_used' || err?.code === 'confirm_outdated' || err?.code === 'quote_changed') onStale?.();
    }
  };
  return (
    <div className={styles.confirm} data-testid="chat-confirm" data-state={state}>
      <span className={styles.confirmText}>
        <span className={styles.confirmLabel}>{quote.label}</span>
        {note && <span className={styles.confirmNote}>{note}</span>}
      </span>
      {state === 'used' && <span className={styles.confirmDone} role="status">{message || 'Started'}</span>}
      {state === 'outdated' && <span className={styles.confirmOld}>Out of date</span>}
      {(state === 'open' || state === 'busy') && (
        <button type="button" className={styles.confirmButton} onClick={press} disabled={state === 'busy'}>
          {state === 'busy' ? 'Starting…' : quote.credits > 0 ? `Start for ${quote.credits} credits` : 'Start (included)'}
        </button>
      )}
      {error && <ErrorNotice error={error} returnTo={returnTo} onRefresh={onDone} />}
    </div>
  );
}

/**
 * The chat helper in the maker's side column (a bottom sheet on phones). The customer asks for changes in plain words;
 * the server's model makes them with the project tools (lib/story/chatTools.js). Anything priced comes back as a
 * confirm card. `onChanged` reloads the project after a change.
 * prefill ({ text, nonce }, optional): puts text in the message box (a new nonce each time, so "Change scene 2: " can be sent
 * from a button). note (optional): a short line from the screen shown above the box ("Want to change anything?"), client only.
 */
export default function ChatPanel({ project, onChanged, returnTo, prefill = null, note = null, reloadKey = 0 }) {
  const projectId = project?.id;
  const [messages, setMessages] = useState([]);
  const [usage, setUsage] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [sendError, setSendError] = useState(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(null); // the text being sent
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!prefill?.text) return;
    setDraft(prefill.text);
    inputRef.current?.focus?.();
  }, [prefill?.nonce, prefill?.text]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoadError(null);
    try {
      const out = await client.getChat(projectId);
      setMessages(out?.messages || []);
      setUsage(out?.usage || null);
    } catch (err) {
      setLoadError(err);
    }
  }, [projectId]);

  // reloadKey: the screen saw something finish (a script rewrite) that put a line in the chat.
  useEffect(() => {
    load();
  }, [load, reloadKey]);

  // Coming back to the tab reads the chat again, so cards pressed elsewhere show their state.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  // Scroll to the newest message once it has laid out (a confirm card is taller than its first paint), so it is never clipped.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    const toEnd = () => {
      el.scrollTop = el.scrollHeight;
    };
    toEnd();
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(toEnd) : null;
    let observer = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(toEnd);
      for (const child of el.children) observer.observe(child);
    }
    const stop = setTimeout(() => observer?.disconnect(), 1000);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      clearTimeout(stop);
    };
  }, [messages.length, pending]);

  const send = async (text) => {
    const message = String(text ?? draft).trim();
    if (!message || pending) return;
    setPending(message);
    setSendError(null);
    setDraft('');
    try {
      const out = await client.sendChat(projectId, message);
      setMessages((list) => [...list, ...(out?.messages || [])]);
      if (out?.usage) setUsage(out.usage);
      if (out?.changed?.length) onChanged?.(out.changed);
    } catch (err) {
      setSendError(err);
      setDraft(message);
    } finally {
      setPending(null);
    }
  };

  const used = usage ? usage.used >= usage.limit : false;
  const empty = !messages.length && !pending;

  return (
    <div className={styles.panel} data-slot="chat-panel" data-testid="chat-panel">
      <div className={styles.head}>
        <h3>Chat helper</h3>
        {usage && (
          <span className={styles.usage} title="Chat messages used for this video">
            {usage.used} of {usage.limit}
          </span>
        )}
      </div>

      {loadError ? (
        <div className={styles.loadError} role="alert">
          <span>The chat could not load.</span>
          <button type="button" className={styles.link} onClick={load}>Try again</button>
        </div>
      ) : empty ? (
        <div className={styles.empty}>
          <p>Ask for a change in plain words. I can edit the script, shots, style and length.</p>
          <div className={styles.chips}>
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className={styles.chip} onClick={() => send(s)} disabled={used}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ol className={styles.list} ref={listRef} aria-label="Chat messages">
          {messages.map((m) => (
            <li key={m.id} className={m.role === 'user' ? styles.mine : styles.theirs} data-role={m.role}>
              <p className={styles.bubble}>{m.text}</p>
              {(m.confirms || []).map((c, i) => (
                <ConfirmCard key={`${m.id}-${i}`} projectId={projectId} item={c} returnTo={returnTo} onDone={() => onChanged?.([c.confirm?.action === 'cast-regen' ? 'cast' : c.confirm?.action === 'mode' ? 'script' : 'shots'])} onStale={() => { load(); onChanged?.(); }} />
              ))}
            </li>
          ))}
          {pending && (
            <>
              <li className={styles.mine} data-role="user"><p className={styles.bubble}>{pending}</p></li>
              <li className={styles.theirs} data-testid="chat-waiting">
                <p className={`${styles.bubble} ${styles.waiting}`} role="status">
                  Working on it<span className={styles.dots} aria-hidden="true"><i /><i /><i /></span>
                </p>
              </li>
            </>
          )}
        </ol>
      )}

      {note && <p className={styles.screenNote} data-testid="chat-note">{note}</p>}

      {sendError && <ErrorNotice error={sendError} returnTo={returnTo} onRefresh={() => onChanged?.()} />}

      {used ? (
        <p className={styles.note}>This video has used its chat messages. You can keep editing every step by hand.</p>
      ) : (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={2}
            maxLength={1000}
            value={draft}
            placeholder="Ask for a change"
            aria-label="Message to the chat helper"
            disabled={Boolean(pending) || !projectId}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button type="submit" className={styles.send} disabled={Boolean(pending) || !draft.trim()}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}
