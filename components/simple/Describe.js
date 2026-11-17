import { useEffect, useRef, useState } from 'react';

import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { getBilling, getReference, reviseScript, writeScript } from '../../lib/story/client';
import { SIMPLE_LENGTHS } from '../../lib/pricingConstants';
import { QUALITY_INFO, QUALITY_ORDER, outputLine, qualityPatch } from '../../lib/qualityInfo';
import { STYLES } from '../../lib/story/prompts/styles';
import ErrorNotice from '../maker/ErrorNotice';
import { usePricing } from '../maker/PricingContext';
import StepReference from '../maker/StepReference';
import { StyleImage, Skeleton } from '../maker/Tiles';
import { titleFromIdea } from '../maker/StepStart';
import { DEFAULT_QUALITY, DEFAULT_SECONDS, DEFAULT_STYLE, hasScript, lengthCredits, lengthLabel } from './derive';
import { Announce, BillingLink, Dock, ScreenHead, count, priceText } from './parts';
import styles from './Simple.module.css';

const POLL_MS = 3000;

/** The reference video's breakdown while it is made: polls until it is ready or failed. -> { reference, error, reload }. */
function useReference(projectId, referenceId) {
  const [reference, setReference] = useState(undefined);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  const load = async () => {
    try {
      const next = await getReference(projectId);
      if (alive.current) {
        setReference(next);
        setError(null);
      }
    } catch (err) {
      if (alive.current) setError(err);
    }
  };
  useEffect(() => {
    alive.current = true;
    if (projectId && referenceId) load();
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, referenceId]);
  const pending = reference?.status === 'pending';
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, projectId]);
  return { reference: referenceId ? reference : null, error, reload: load };
}

function StyleDialog({ open, style, custom, onClose, onUse }) {
  const [pick, setPick] = useState(style);
  const [text, setText] = useState(custom);
  useEffect(() => {
    if (open) {
      setPick(style);
      setText(custom);
    }
  }, [open, style, custom]);
  const ready = pick && (pick !== 'custom' || text.trim());
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pick the look"
      footer={(
        <>
          <Button variant="ghost" arrow={false} onClick={onClose}>Cancel</Button>
          <Button arrow={false} disabled={!ready} onClick={() => onUse(pick, text.trim())}>Use this style</Button>
        </>
      )}
    >
      <p className={styles.hint}>Every picture in your video follows this style.</p>
      <div className={styles.styleGrid} role="radiogroup" aria-label="Style">
        {Object.entries(STYLES).map(([key, s]) => (
          <label key={key} className={`${styles.styleTile} ${pick === key ? styles.optionOn : ''}`}>
            <input type="radio" name="simple-style" value={key} aria-label={s.label} checked={pick === key} onChange={() => setPick(key)} />
            <StyleImage styleKey={key} label={s.label} />
            <span className={styles.styleName} aria-hidden="true">{s.label}</span>
          </label>
        ))}
      </div>
      {pick === 'custom' && (
        <label className={styles.field}>
          <span>Describe your style</span>
          <textarea rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} placeholder="Soft paper shapes in warm colours." />
        </label>
      )}
    </Modal>
  );
}

/**
 * Screen 1, Describe it: the idea (or a video to follow), three prefilled choices, and "Write my script".
 *   project   the project, or null on /app/new (nothing exists until the button is pressed)
 *   onCreate  (input) -> { id }   creates the project (new only)
 *   onOpen    (id) -> void        opens a project once it exists (new only)
 *   save      (patch) -> project  PATCH the brief (existing project)
 *   refresh   reload status
 *   onDone    called when an existing project's script is in place, to go on to screen 2
 */
export default function Describe({ project, onCreate, onOpen, save, refresh, onDone, returnTo, backLabel = 'Back to the script' }) {
  const pricing = usePricing();
  const scripted = hasScript(project);
  const [idea, setIdea] = useState(project?.offer || '');
  const [seconds, setSeconds] = useState(project?.seconds || DEFAULT_SECONDS);
  const [quality, setQuality] = useState(project?.quality || DEFAULT_QUALITY);
  const [style, setStyle] = useState(project?.style || DEFAULT_STYLE);
  const [custom, setCustom] = useState(project?.style_custom || '');
  const [qualityOpen, setQualityOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [skipVideo, setSkipVideo] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const [available, setAvailable] = useState(null);
  const created = useRef(null); // the project made by a first press that then failed to write: the retry reuses it
  const { reference, error: referenceError, reload } = useReference(project?.id, project?.reference_id);

  // The balance for the length chips. A failed read just means no chip warns.
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => getBilling())
      .then((b) => { if (alive && b?.v2 === true && typeof b?.balance?.available === 'number') setAvailable(b.balance.available); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const fromVideo = Boolean(project?.reference_id);
  const waiting = fromVideo && (reference === undefined || reference?.status === 'pending');
  const referenceReady = fromVideo && reference?.status === 'ready';
  const referenceFailed = fromVideo && reference?.status === 'failed';
  const hasIdea = Boolean(idea.trim());
  // While the video is still being broken down the script waits for it; the only way past is to say the video will not be used.
  const mustWait = waiting && !skipVideo;
  const canWrite = !busy && !mustWait && (scripted || hasIdea || referenceReady);

  const costs = SIMPLE_LENGTHS.map((n) => ({ n, credits: lengthCredits(pricing, project, n, quality) }));
  const anyShort = available !== null && costs.some((c) => c.credits > available);
  const info = QUALITY_INFO[quality];

  const briefFields = () => ({
    ...(hasIdea ? { offer: idea.trim().slice(0, 1000) } : {}),
    style,
    ...(style === 'custom' ? { style_custom: custom } : {}),
    seconds,
    ...qualityPatch(quality),
  });

  async function submit(e) {
    e?.preventDefault();
    if (!canWrite) return;
    setError(null);
    try {
      let id = project?.id || created.current;
      if (!id) {
        setBusy('Starting your video…');
        const made = await onCreate({ title: titleFromIdea(idea), ...briefFields(), aspect: '9:16' });
        id = made.id;
        created.current = id;
      } else if (project) {
        setBusy(scripted ? 'Saving…' : 'Starting your video…');
        await save(briefFields());
      }
      if (scripted) {
        // The length changed the words the script needs: it is rewritten once, counted as a revise. The quality does not
        // change the words (who speaks is the script's own choice), so changing it never rewrites the script.
        if (seconds !== project.seconds) {
          setBusy('Fitting your script…');
          await reviseScript(id, `Fit the script to ${seconds} seconds.`);
        }
        await refresh?.();
        onDone?.();
      } else {
        setBusy('Writing your script…');
        await writeScript(id);
        if (project) {
          await refresh?.();
          onDone?.();
        } else {
          await onOpen(id);
        }
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy('');
    }
  }

  const label = busy || (mustWait ? 'Reading your video…' : scripted ? backLabel : 'Write my script');

  return (
    <form className={styles.screen} onSubmit={submit} data-screen="describe">
      <ScreenHead title="Describe your video" sub="One line is enough. You can change everything later." />

      {fromVideo ? (
        <div className={styles.refCard} data-testid="reference-card">
          {waiting && (
            <>
              <Skeleton status="Watching your video shot by shot" line="This takes about a minute. The page updates by itself." ratio="16 / 5" />
              <Announce>Watching your video shot by shot</Announce>
              {skipVideo ? (
                <p className={styles.hint} data-testid="skip-note">Your script will be written from your idea only. The video will not be used.</p>
              ) : (
                <button type="button" className={styles.linkButton} onClick={() => setSkipVideo(true)}>Write it without the video</button>
              )}
            </>
          )}
          {referenceReady && (
            <p className={styles.refReady}>
              <strong>Your video is broken down.</strong>
              {' '}{reference.beats?.length || 0} {(reference.beats?.length || 0) === 1 ? 'beat' : 'beats'}
              {reference.duration ? `, ${Math.round(reference.duration)} seconds` : ''}. Your script keeps its shape with new lines, characters and setting.
            </p>
          )}
          {referenceFailed && (
            <div role="alert" className={styles.refFailed}>
              <strong>We could not break this video down.</strong>
              <span>{reference.error || 'Try another video, or describe your idea below.'}</span>
              <Button variant="ghost" arrow={false} size="sm" onClick={() => setVideoOpen(true)}>Try another video</Button>
            </div>
          )}
          {referenceError && <ErrorNotice error={referenceError} returnTo={returnTo} onRefresh={reload} />}
        </div>
      ) : null}

      <label className={styles.ideaWrap}>
        <span className={styles.srOnly}>Describe your idea</span>
        <textarea
          className={styles.idea}
          aria-label="Describe your idea"
          rows={3}
          maxLength={1000}
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder={fromVideo ? 'Anything to add? (optional)' : 'A coffee cart that remembers every order'}
        />
      </label>

      {!fromVideo || referenceFailed || videoOpen ? (
        <div className={styles.videoDoor}>
          {!videoOpen ? (
            <button type="button" className={styles.linkButton} onClick={() => setVideoOpen(true)}>Start from a video</button>
          ) : (
            <StepReference
              ensureProject={async () => {
                if (project?.id) return project.id;
                if (created.current) return created.current;
                const made = await onCreate({ title: 'Video from a reference', style, seconds, ...qualityPatch(quality), aspect: '9:16' });
                created.current = made.id;
                return made.id;
              }}
              onStarted={async (id) => {
                setVideoOpen(false);
                if (project) await refresh?.();
                else await onOpen(id);
              }}
              returnTo={returnTo}
            />
          )}
        </div>
      ) : null}

      <div className={styles.settings}>
        <div className={styles.setting}>
          <span className={styles.settingLabel}>Style</span>
          <span className={styles.settingBody}>
            <span className={styles.stylePill} data-testid="style-chosen">
              <span className={styles.styleThumb}><StyleImage styleKey={style} label={STYLES[style]?.label} /></span>
              {STYLES[style]?.label || 'Your own style'}
            </span>
            <button type="button" className={styles.linkButton} onClick={() => setStyleOpen(true)} aria-label="Change style">change</button>
          </span>
        </div>

        <div className={styles.setting} role="group" aria-label="Length">
          <span className={styles.settingLabel} aria-hidden="true">Length</span>
          <span className={styles.chips}>
            {costs.map(({ n, credits }) => {
              const short = available !== null && credits > available;
              return (
                <label key={n} className={`${styles.chip} ${seconds === n ? styles.optionOn : ''}`}>
                  <input type="radio" name="simple-length" value={n} checked={seconds === n} onChange={() => setSeconds(n)} />
                  <strong>{lengthLabel(n)}</strong>
                  <small>{count(credits)} credits</small>
                  {short && <small className={styles.needs}>needs more credits</small>}
                </label>
              );
            })}
          </span>
        </div>
        {available !== null && (
          <p className={styles.balanceNote} data-testid="balance-note">
            You have {count(available)} credits.
            {anyShort && <> Lengths marked &quot;needs more credits&quot; can still be picked, and you can top up before you make the video. <BillingLink /></>}
          </p>
        )}

        <div className={styles.setting}>
          <span className={styles.settingLabel}>Quality</span>
          <div className={styles.qualityBody}>
            {qualityOpen ? (
              <div className={styles.qualityGrid} role="radiogroup" aria-label="Quality">
                {QUALITY_ORDER.map((id) => {
                  const q = QUALITY_INFO[id];
                  return (
                    <label key={id} className={`${styles.qualityCard} ${quality === id ? styles.optionOn : ''}`} data-quality={id}>
                      <input type="radio" name="simple-quality" aria-label={q.name} checked={quality === id} onChange={() => { setQuality(id); setQualityOpen(false); }} />
                      <QualityText id={id} seconds={seconds} credits={lengthCredits(pricing, project, seconds, id)} />
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className={styles.qualityChosen}>
                <div className={`${styles.qualityCard} ${styles.optionOn}`} data-testid="quality-chosen" data-quality={quality}>
                  <QualityText id={quality} seconds={seconds} credits={lengthCredits(pricing, project, seconds, quality)} />
                </div>
                <button type="button" className={styles.linkButton} onClick={() => setQualityOpen(true)} aria-label="Change quality">change</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <ErrorNotice error={error} returnTo={returnTo} onRetry={() => submit()} />
      <Announce>{busy}</Announce>

      <Dock
        label="Estimated cost"
        total={lengthCredits(pricing, project, seconds, quality)}
        meta={`${info?.name || 'Standard'}, ${seconds === 120 ? '2 minutes' : `${seconds} seconds`}`}
        hint={!canWrite && !busy ? (mustWait ? 'Your video is being broken down first.' : waiting ? 'Describe your video to write it without the video.' : 'Describe your video to start.') : null}
      >
        <Button type="submit" disabled={!canWrite}>{label}</Button>
      </Dock>

      <StyleDialog
        open={styleOpen}
        style={style}
        custom={custom}
        onClose={() => setStyleOpen(false)}
        onUse={(pick, text) => { setStyle(pick); setCustom(text); setStyleOpen(false); }}
      />
    </form>
  );
}

/** What one quality card says: name, voice, picture, what is included, the file, the credits, and the model in small print. */
function QualityText({ id, seconds, credits }) {
  const q = QUALITY_INFO[id];
  return (
    <>
      <span className={styles.qualityHead}>
        <strong>{q.name}</strong>
        {q.recommended && <span className={styles.recommended}>Recommended</span>}
      </span>
      <span className={styles.qualityVoice}>{q.voice}</span>
      <span className={styles.qualityLine}>{q.picture}. {q.included}.</span>
      <span className={styles.qualityLine}>{outputLine('9:16', seconds)}</span>
      <strong className={styles.qualityCredits}>{priceText(credits)}</strong>
      <small className={styles.qualityModel}>{q.model}</small>
    </>
  );
}
