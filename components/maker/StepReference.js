import { useRef, useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import { startAnalysis, uploadReference } from '../../lib/story/client';
import { REFERENCE_LIMITS, REFERENCE_MESSAGES, RIGHTS_STATEMENT, VIDEO_EXTENSION, VIDEO_TYPES, isAllowedReferenceLink } from '../../lib/story/referenceRules';
import ErrorNotice from './ErrorNotice';
import { Icon } from './Tiles';
import styles from './Reference.module.css';

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** The length of a local video file in seconds, from its metadata; null when the browser cannot tell. */
export function readVideoDuration(file) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return resolve(null);
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (value) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    };
    const timer = setTimeout(() => done(null), 8000);
    video.preload = 'metadata';
    video.onloadedmetadata = () => done(video.duration);
    video.onerror = () => done(null);
    video.src = url;
  });
}

/**
 * The browser's own checks, the same rules the server applies: an MP4 or MOV, at most 100 MB and 3 minutes.
 * -> the message to show, or null when the file may be sent (the server checks again).
 */
export async function checkVideoFile(file, { readDuration = readVideoDuration } = {}) {
  if (!file) return REFERENCE_MESSAGES.source;
  const isVideo = file.type ? VIDEO_TYPES.includes(file.type) : VIDEO_EXTENSION.test(file.name || '');
  if (!isVideo) return REFERENCE_MESSAGES.notVideo;
  if (file.size > REFERENCE_LIMITS.maxBytes) return REFERENCE_MESSAGES.tooBig;
  const seconds = await readDuration(file);
  if (seconds && seconds > REFERENCE_LIMITS.maxSeconds) return REFERENCE_MESSAGES.tooLong;
  return null;
}

/**
 * "Start from a video": upload an MP4 or paste an Instagram, TikTok or Facebook link, tick the rights statement,
 * and the analysis starts. `ensureProject()` returns the project id to use (on the first screen it creates the
 * project, only once everything checks out); `onStarted(projectId, reference)` runs after the start.
 */
export default function StepReference({ ensureProject, onStarted, returnTo, readDuration = readVideoDuration, title = 'Start from a video' }) {
  const [mode, setMode] = useState('upload');
  const [file, setFile] = useState(null);
  const [fileInfo, setFileInfo] = useState(null); // { seconds } once read
  const [fileProblem, setFileProblem] = useState(null);
  const [link, setLink] = useState('');
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const projectId = useRef(null);

  const trimmed = link.trim();
  const linkProblem = mode === 'link' && trimmed && !isAllowedReferenceLink(trimmed) ? REFERENCE_MESSAGES.link : null;
  const sourceReady = mode === 'upload' ? Boolean(file) && !fileProblem : Boolean(trimmed) && !linkProblem;
  const canSubmit = sourceReady && rights && !busy;

  async function pickFile(e) {
    const next = e.target.files?.[0] || null;
    setError(null);
    setFile(next);
    setFileInfo(null);
    setFileProblem(null);
    if (!next) return;
    const seconds = await readDuration(next).catch(() => null);
    setFileInfo({ seconds });
    setFileProblem(await checkVideoFile(next, { readDuration: async () => seconds }));
  }

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    try {
      setBusy('starting');
      // The project is made (or reused) only now, so a refused video never uses one up.
      projectId.current = projectId.current || (await ensureProject());
      let source;
      if (mode === 'upload') {
        setBusy('uploading');
        setProgress(0);
        const url = await uploadReference(projectId.current, file, { onProgress: setProgress });
        source = { type: 'upload', url };
        setBusy('starting');
      } else {
        source = { type: 'link', url: trimmed };
      }
      const reference = await startAnalysis(projectId.current, { source, rights: true });
      await onStarted?.(projectId.current, reference);
    } catch (err) {
      setError(err);
    } finally {
      setBusy('');
    }
  }

  const label = busy === 'uploading' ? `Uploading ${progress}%` : busy ? 'Starting…' : 'Break down my video';

  return (
    <Card className={styles.card} data-step="reference">
      <form onSubmit={submit} className={styles.form}>
        <div className={styles.head}>
          <span className={styles.headIcon}><Icon name="film" size={18} /></span>
          <div>
            <h3>{title}</h3>
            <p>We study how it is told, shot by shot, and write you a new story with the same shape. Its footage, words and characters are never copied.</p>
          </div>
        </div>

        <div className={styles.segmented} role="radiogroup" aria-label="Where the video comes from">
          {[['upload', 'Upload a file', 'upload'], ['link', 'Paste a link', 'link']].map(([id, text, icon]) => (
            <label key={id} className={mode === id ? styles.segOn : ''}>
              <input type="radio" name="reference-source" value={id} checked={mode === id} disabled={Boolean(busy)} onChange={() => { setMode(id); setError(null); }} />
              <Icon name={icon} size={16} />
              {text}
            </label>
          ))}
        </div>

        {mode === 'upload' ? (
          <div className={styles.source}>
            <label className={`${styles.drop} ${file ? styles.dropFilled : ''}`}>
              <input className={styles.fileInput} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" aria-label="Choose a video file" disabled={Boolean(busy)} onChange={pickFile} />
              <span className={styles.dropIcon}><Icon name="upload" size={20} /></span>
              {file ? (
                <span className={styles.dropText}>
                  <strong>{file.name}</strong>
                  <small>{mb(file.size)}{fileInfo?.seconds ? `, ${clock(fileInfo.seconds)}` : ''} · Choose another</small>
                </span>
              ) : (
                <span className={styles.dropText}>
                  <strong>Choose a video</strong>
                  <small>MP4 or MOV, up to 100 MB and 3 minutes</small>
                </span>
              )}
            </label>
            {fileProblem && <p className={styles.problem} role="alert">{fileProblem}</p>}
          </div>
        ) : (
          <div className={styles.source}>
            <label className={styles.field}>
              <span>Link to the video</span>
              <input
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://www.instagram.com/reel/…"
                value={link}
                disabled={Boolean(busy)}
                onChange={(e) => { setLink(e.target.value); setError(null); }}
                aria-invalid={linkProblem ? 'true' : undefined}
              />
            </label>
            {linkProblem ? (
              <p className={styles.problem} role="alert">{linkProblem}</p>
            ) : (
              <p className={styles.hint}>Instagram, TikTok or Facebook, including the Meta Ad Library. The post must be public.</p>
            )}
          </div>
        )}

        <label className={styles.rights}>
          <input type="checkbox" checked={rights} disabled={Boolean(busy)} onChange={(e) => setRights(e.target.checked)} />
          <span>{RIGHTS_STATEMENT}</span>
        </label>

        <ErrorNotice error={error} returnTo={returnTo} onRetry={() => setError(null)} />

        {busy === 'uploading' && (
          <div className={styles.progress} role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <span style={{ width: `${progress}%` }} />
          </div>
        )}

        <div className={styles.actions}>
          <Button type="submit" disabled={!canSubmit}>{label}</Button>
          <span className={styles.hint}>Takes about a minute. You can carry on meanwhile.</span>
        </div>
      </form>
    </Card>
  );
}
