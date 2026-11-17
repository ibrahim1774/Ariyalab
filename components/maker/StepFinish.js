import { useEffect, useMemo, useState } from 'react';
import Router from 'next/router';

import Button from '../ui/Button';
import Card from '../ui/Card';
import buttonStyles from '../ui/Button.module.css';
import VideoPlayer from '../app/VideoPlayer';
import FilesNote from './FilesNote';
import StepFooter from './StepFooter';
import { NeedCredits } from './NeedCredits';
import { EmptyState, Icon } from './Tiles';
import { describeError } from './errors';
import { clock, downloadFilename, downloadHref, filesExpired, renderActive } from './finish';
import { formatDate } from './steps';
import { duplicateProject, startRender } from '../../lib/story/client';
import styles from './Finish.module.css';
import steps from './Steps.module.css';

/** Seconds since an ISO time, ticking once a second while `on`. */
function useElapsed(since, on) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  const start = since ? new Date(since).getTime() : NaN;
  return Number.isFinite(start) ? Math.max(0, (now - start) / 1000) : null;
}

function Working({ render }) {
  const elapsed = useElapsed(render.created_at, true);
  const queued = render.status === 'queued';
  return (
    <Card className={styles.working} data-render-state={render.status}>
      <div className={styles.progress} role="progressbar" aria-label="Making your video" aria-busy="true"><span /></div>
      <p className={styles.workingText} role="status" aria-live="polite" data-testid="render-progress">
        <strong>{queued ? 'Waiting for a turn…' : 'Putting your video together…'}</strong>
        <span>
          {queued ? 'It starts in a moment.' : 'Clips, voice, music and captions are being joined.'}
          {elapsed != null ? ` ${clock(elapsed)} so far.` : ''} This usually takes a minute or two, and you can leave this page.
        </span>
      </p>
    </Card>
  );
}

function Warnings({ render }) {
  const [gone, setGone] = useState(() => new Set());
  const key = (w) => `${render.id}:${w.code}:${w.message}`;
  const list = (render.warnings || []).filter((w) => w?.message && !gone.has(key(w)));
  if (list.length === 0) return null;
  return (
    <section className={styles.warnings}>
      <h3>Worth a look</h3>
      <ul aria-label="Worth a look">
        {list.map((w) => (
          <li key={key(w)} data-code={w.code}>
            <span>{w.message}</span>
            <button type="button" className={styles.dismiss} aria-label={`Dismiss: ${w.message}`} onClick={() => setGone((s) => new Set(s).add(key(w)))}>
              Dismiss
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** " (free)" / " (5 credits)" after the make-video button, from /status renderPrice; nothing while it is unknown. */
export function renderPriceLabel(price) {
  const credits = Number(price?.credits);
  if (!Number.isInteger(credits) || credits < 0) return '';
  return credits === 0 ? ' (free)' : ` (${credits} ${credits === 1 ? 'credit' : 'credits'})`;
}

/**
 * Step 12: make the video, watch it, download it. Props: { project, status, refresh }. `status` is the /status
 * payload ({ render, renders, renderPrice }); the screen holds no render state of its own beyond which version is on
 * screen. The button shows the next render's price and sends it as expected_credits; a 409 (quote_changed among
 * them) refreshes, so the new price shows.
 */
export default function StepFinish({ project, status, refresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(null);
  const renders = useMemo(() => {
    const list = Array.isArray(status?.renders) && status.renders.length ? status.renders : status?.render ? [status.render] : [];
    return list;
  }, [status]);
  const latest = status?.render || renders[0] || null;
  const active = renderActive(latest);
  const doneRenders = renders.filter((r) => r.status === 'done' && r.url);
  const shown = doneRenders.find((r) => r.id === picked) || doneRenders[0] || null;
  const expired = filesExpired(project);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      // Never start without the price on the button: a start that costs something must carry the number the customer saw.
      const credits = status?.renderPrice?.credits;
      if (!Number.isInteger(credits)) return;
      await startRender(project.id, credits);
      setPicked(null);
      // Stay busy until the new render shows up in /status, so the button never flashes back to "Make it again".
      await refresh?.();
    } catch (err) {
      // A refusal the server explains (audio_not_ready, shots_not_ready, render_busy) is shown in its own words.
      setError({ ...describeError(err), server: err?.serverMessage || '' });
      if (err?.status === 409) await refresh?.();
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await duplicateProject(project.id);
      Router.push(`/app/p/${made.id}`);
    } catch (err) {
      setError({ ...describeError(err), server: err?.serverMessage || '' });
    } finally {
      setBusy(false);
    }
  };

  const price = renderPriceLabel(status?.renderPrice);
  const priceKnown = Number.isInteger(status?.renderPrice?.credits);
  const renderCost = priceKnown ? status.renderPrice.credits : 0;
  const priceLines = Array.isArray(status?.renderPrice?.lines) && status.renderPrice.fee > 0 ? status.renderPrice.lines : null;
  // The price did not come with the status (a read failed): ask again until it does.
  const needsPrice = !priceKnown && !expired && !active;
  useEffect(() => {
    if (!needsPrice || !refresh) return undefined;
    const t = setTimeout(() => refresh(), 1500);
    return () => clearTimeout(t);
  }, [needsPrice, refresh, status]);
  const errorLine = error ? <p className={styles.error} role="alert">{error.server || error.message || error.title}</p> : null;

  if (expired) {
    const date = formatDate(project?.files_expire_at);
    return (
      <div className={steps.step} data-testid="finish" data-state="expired">
        <div className={steps.stepHead}><h2>Your finished <span className="accent-word">video</span></h2></div>
        <EmptyState icon="film" title="This video’s files have been removed" text={`${date ? `They were removed on ${date}. ` : ''}Videos and clips are kept for a limited time. Your script and cast are still here, so you can make a copy and generate it again.`}>
          <Button onClick={copy} disabled={busy}>Make a copy</Button>
          {errorLine}
        </EmptyState>
      </div>
    );
  }

  // A finished video keeps its "make it again" beside the download; every other state has its one action pinned below.
  const inSide = Boolean(shown) && !active && !busy && latest?.status !== 'failed';
  const primary = (() => {
    if (active || busy) return <Button disabled>{busy && !active ? 'Starting…' : 'Making your video…'}</Button>;
    if (!priceKnown) return <Button disabled>Checking the price…</Button>;
    if (latest?.status === 'failed') return <Button onClick={start}>{`Try again${price}`}</Button>;
    if (shown) return <Button variant="ghost" onClick={start}>{`Make it again${price}`}</Button>;
    return <Button onClick={start}>{`Make my video${price}`}</Button>;
  })();

  return (
    <div className={steps.step} data-testid="finish" data-state={active ? latest.status : latest?.status === 'failed' ? 'failed' : shown ? 'done' : 'none'}>
      <div className={steps.stepHead}>
        <h2>Your finished <span className="accent-word">video</span></h2>
        <p>{shown ? 'Watch it, then download it. Making it again keeps the earlier versions.' : 'Put your clips, voice, music and captions together into one video.'}</p>
      </div>

      {priceLines && !active && (
        <ul className={styles.meta} data-testid="render-price-lines" aria-label="What this costs">
          {priceLines.map((l) => (
            <li key={l.label}>{l.label === 'Render' ? 'Video render' : l.label}: {l.credits === 0 ? 'included' : `${l.credits} ${l.credits === 1 ? 'credit' : 'credits'}`}</li>
          ))}
        </ul>
      )}

      {active && <Working render={latest} />}

      {!active && latest?.status === 'failed' && (
        <Card className={styles.failedCard} data-render-state="failed">
          <span className={styles.failedIcon} data-tile="failed"><Icon name="film" /></span>
          <div>
            <h3>The video could not be made</h3>
            <p role="alert">{latest.error || 'Something went wrong while making your video. Try again.'}</p>
          </div>
        </Card>
      )}

      {shown && (
        <Card className={styles.watch} data-render-state="done" data-portrait={project?.aspect === '9:16' ? '' : undefined}>
          <VideoPlayer src={shown.url} aspect={project?.aspect || '16:9'} title={project?.title ? `${project.title}, version ${shown.version}` : 'Your video'} />
          <div className={styles.side}>
            <p className={styles.meta}>
              Version {shown.version}
              {shown.duration_seconds ? ` · ${clock(shown.duration_seconds)}` : ''}
              {shown.finished_at && formatDate(shown.finished_at) ? ` · made ${formatDate(shown.finished_at)}` : ''}
            </p>
            <div className={steps.actions}>
              <a className={`${buttonStyles.btn} ${buttonStyles.primary}`} data-variant="primary" href={downloadHref(shown.url)} download={downloadFilename(project?.title)}>
                <span>Download video</span>
              </a>
              {inSide && <Button variant="ghost" arrow={false} onClick={start} disabled={!priceKnown}>{`Make it again${price}`}</Button>}
              {inSide && renderCost > 0 && <NeedCredits items={[{ price: renderCost }]} />}
            </div>
            {doneRenders.length > 1 && (
              <div className={styles.versions} role="group" aria-label="Versions">
                {doneRenders.map((r) => (
                  <button key={r.id} type="button" className={styles.version} aria-pressed={r.id === shown.id} onClick={() => setPicked(r.id)}>
                    Version {r.version}
                  </button>
                ))}
              </div>
            )}
            <Warnings key={shown.id} render={shown} />
            <FilesNote project={project} />
          </div>
        </Card>
      )}

      {!shown && !active && latest?.status !== 'failed' && (
        <Card className={styles.intro} data-render-state="none">
          <span className={styles.failedIcon} data-tile="finish"><Icon name="film" /></span>
          <div>
            <h3>Ready when you are</h3>
            <p>We join your clips, narration, music and captions into one video. It takes a minute or two, your first finished video is included, and you can leave the page while it works.</p>
          </div>
        </Card>
      )}

      {!shown && <FilesNote project={project} />}
      {errorLine}
      {!inSide && <StepFooter>{primary}{!active && !busy && renderCost > 0 && <NeedCredits items={[{ price: renderCost }]} />}</StepFooter>}
    </div>
  );
}
