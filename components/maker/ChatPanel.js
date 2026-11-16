import { useCallback, useEffect, useRef, useState } from 'react';

import * as client from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import styles from './ChatPanel.module.css';

const SUGGESTIONS = ['Make the opening funnier', 'Make it 45 seconds', 'What will the video cost?'];

/** One confirm card: a priced action the chat did not do. The button calls the normal route with the shown price. */
function ConfirmCard({ projectId, item, returnTo, onDone }) {
  const [state, setState] = useState('idle'); // idle | busy | done
  const [error, setError] = useState(null);
  const { quote, confirm } = item;
  const press = async () => {
    setState('busy');
    setError(null);
    try {
      await client.confirmChatAction(projectId, confirm);
      setState('done');
      onDone?.();
    } catch (err) {
      setError(err);
      setState('idle');
    }
  };
  return (
    <div className={styles.confirm} data-testid="chat-confirm">
      <span className={styles.confirmLabel}>{quote.label}</span>
      {state === 'done' ? (
        <span className={styles.confirmDone} role="status">Started</span>
      ) : (
        <button type="button" className={styles.confirmButton} onClick={press} disabled={state === 'busy'}>
          {state === 'busy' ? 'Starting…' : `Start for ${quote.credits} credits`}
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
 */
export default function ChatPanel({ project, onChanged, returnTo }) {
  const projectId = project?.id;
  const [messages, setMessages] = useState([]);
  const [usage, setUsage] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [sendError, setSendError] = useState(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(null); // the text being sent
  const listRef = useRef(null);

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

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
                <ConfirmCard key={`${m.id}-${i}`} projectId={projectId} item={c} returnTo={returnTo} onDone={() => onChanged?.(['cast'])} />
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
