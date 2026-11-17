import { useEffect, useMemo, useRef, useState } from 'react';

import Button from '../ui/Button';
import buttonStyles from '../ui/Button.module.css';
import VideoPlayer from '../app/VideoPlayer';
import { rerollShot, startGeneration, startRender } from '../../lib/story/client';
import ErrorNotice from '../maker/ErrorNotice';
import { clock, downloadFilename, downloadHref, renderActive } from '../maker/finish';
import { usePricing } from '../maker/PricingContext';
import { isGenerated, rerollInfo } from '../maker/steps';
import { Skeleton } from '../maker/Tiles';
import { lastClipAt, nextScenes, renderOutdated, scenesOf, shouldAutoRender } from './derive';
import { Announce, Check, Dock, ScreenHead, withPrice } from './parts';
import useStartQuote from './useStartQuote';
import styles from './Simple.module.css';

const STATE_TEXT = { ready: 'Ready', making: 'Making', waiting: 'Waiting', failed: 'Did not work' };

/** Plays one scene: its clips one after the other. */
function ScenePlayer({ scene, aspect }) {
  const [index, setIndex] = useState(0);
  const clips = scene.readyShots;
  useEffect(() => { setIndex(0); }, [scene.id]);
  const clip = clips[Math.min(index, clips.length - 1)];
  if (!clip) return null;
  return (
    <div className={styles.clipBox} data-aspect={aspect}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        className={styles.clip}
        controls
        playsInline
        autoPlay
        muted
        preload="metadata"
        poster={clip.still_url || undefined}
        src={clip.clip_url}
        aria-label={`Scene ${scene.n} clip`}
        onEnded={() => setIndex((i) => (i + 1 < clips.length ? i + 1 : i))}
      />
    </div>
  );
}

function Warnings({ render }) {
  const list = (render?.warnings || []).filter((w) => w?.message);
  if (!list.length) return null;
  return (
    <section className={styles.warnings} aria-label="Worth a look">
      <h3>Worth a look</h3>
      <ul>{list.map((w, i) => <li key={`${w.code}-${i}`}>{w.message}</li>)}</ul>
    </section>
  );
}

/** The panel under the strip for "Change this scene": make each of its shots again, with the price and the tries included. */
function ChangePanel({ scene, status, project, refresh, returnTo }) {
  const pricing = usePricing();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  async function again(shot) {
    setBusy(shot.id);
    setError(null);
    try {
      // The price on the button: a different price is a 409, never a charge.
      await rerollShot(project.id, shot.id, shot.reroll_credits);
      await refresh?.();
    } catch (err) {
      setError(err);
      if (err?.status === 409) await refresh?.();
    } finally {
      setBusy('');
    }
  }
  return (
    <div className={styles.changePanel} data-testid="scene-change">
      <p className={styles.hint}>Tell the chat helper what to change, or make a shot again as it is.</p>
      {scene.readyShots.map((shot) => {
        const k = shot.ord + 1;
        const price = Number.isInteger(shot.reroll_credits) ? shot.reroll_credits : null;
        return (
          <div key={shot.id} className={styles.changeRow}>
            <Button variant="ghost" size="sm" arrow={false} disabled={price === null || Boolean(busy)} onClick={() => again(shot)}>
              {busy === shot.id ? 'Making it again…' : price === null ? `Shot ${k} cannot be made again now` : withPrice(`Make shot ${k} again`, price)}
            </Button>
            <span className={styles.hint}>{rerollInfo(status, shot, pricing).text}</span>
          </div>
        );
      })}
      <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
    </div>
  );
}

/**
 * Screen 4, Watch and fix: a strip of scenes (waiting, making, ready, did not work), clips that play per scene, the next
 * scene or the rest with their prices, "Change this scene", and the final video: made by itself once when every clip is ready
 * (the included render), downloadable, with the render's warnings shown as they are. A later render shows its price.
 */
export default function Watch({ status, project, refresh, returnTo, onAskChat }) {
  const { shots, jobs, render, renders, renderPrice } = status;
  const [selected, setSelected] = useState(null); // scene id whose clip plays in the stage
  const [changing, setChanging] = useState(null); // scene id whose change panel is open
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const autoFor = useRef('');

  const scenes = useMemo(() => scenesOf(shots), [shots]);
  const generated = shots.filter(isGenerated);
  const allReady = generated.length > 0 && generated.every((s) => s.status === 'ready');
  const { next, waitingCount } = nextScenes(scenes);
  const anyReady = scenes.some((s) => s.state === 'ready');
  const waitingIds = scenes.filter((s) => s.state === 'waiting').flatMap((s) => s.startIds);
  const failedScene = scenes.find((s) => s.state === 'failed' && s.startIds.length > 0) || null;
  const sig = shots.map((s) => `${s.id}:${s.status}`).join('|');
  const showNext = anyReady && Boolean(next);
  const nextQ = useStartQuote(project.id, showNext ? next.startIds : [], { key: sig });
  const restQ = useStartQuote(project.id, showNext && waitingCount > 1 ? waitingIds : [], { key: sig });
  const failQ = useStartQuote(project.id, failedScene ? failedScene.startIds : [], { key: sig });

  const active = renderActive(render);
  const latestDone = (render?.status === 'done' && render.url ? render : null) || (renders || []).find((r) => r.status === 'done' && r.url) || null;
  const outdated = renderOutdated({ render: latestDone || render, jobs });
  const price = Number.isInteger(renderPrice?.credits) ? renderPrice.credits : null;
  const failedRender = !active && render?.status === 'failed';

  // The final video: when every clip is ready it is made by itself, once, if it is the included render and none covers these clips.
  useEffect(() => {
    if (!shouldAutoRender(status)) return;
    const key = `${sig}|${lastClipAt(jobs)}`;
    if (autoFor.current === key) return;
    autoFor.current = key;
    startRender(project.id, 0)
      .then(() => refresh?.())
      .catch((err) => {
        // render_busy and other 409s mean it is already under way (another tab): look again. Anything else is shown.
        if (err?.status === 409) refresh?.();
        else setError(err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function startClips(quote, kind) {
    if (!quote || busy) return;
    setBusy(kind);
    setError(null);
    setNote('');
    try {
      await startGeneration(project.id, quote.shotIds || [], quote.total);
      await refresh?.();
    } catch (err) {
      if (err?.status === 409 && err?.code === 'quote_changed') {
        setNote('The price changed. Check the new price, then press the button again.');
        await Promise.all([nextQ.reload(), restQ.reload(), failQ.reload()]);
        await refresh?.();
      } else {
        setError(err);
        if (err?.status === 409) await refresh?.();
      }
    } finally {
      setBusy('');
    }
  }

  async function renderAgain() {
    if (busy) return;
    setBusy('render');
    setError(null);
    setNote('');
    try {
      await startRender(project.id, price ?? undefined);
      await refresh?.();
    } catch (err) {
      if (err?.status === 409 && err?.code === 'quote_changed') {
        setNote('The price changed. Check the new price, then press the button again.');
        await refresh?.();
      } else {
        setError(err);
        if (err?.status === 409) await refresh?.();
      }
    } finally {
      setBusy('');
    }
  }

  const playing = selected ? scenes.find((s) => s.id === selected) : null;
  const doneNow = Boolean(latestDone) && allReady && !active;
  let statusText = 'Making your video…';
  if (active) statusText = 'Putting it together…';
  else if (doneNow && !outdated) statusText = 'Ready';
  else if (allReady && failedRender) statusText = 'Needs a look';
  const makingNumber = (scenes.find((s) => s.state === 'making') || next || scenes[0])?.n;

  // The one main action of the bar.
  let primary = null;
  let secondary = null;
  let hint = null;
  if (!allReady) {
    if (showNext) {
      primary = (
        <Button disabled={!nextQ.quote || Boolean(busy)} onClick={() => startClips(nextQ.quote, 'next')}>
          {busy === 'next' ? 'Starting…' : nextQ.quote ? withPrice('Make the next scene', nextQ.quote.total) : 'Make the next scene'}
        </Button>
      );
      if (waitingCount > 1) {
        secondary = (
          <Button variant="ghost" arrow={false} disabled={!restQ.quote || Boolean(busy)} onClick={() => startClips(restQ.quote, 'rest')}>
            {busy === 'rest' ? 'Starting…' : restQ.quote ? withPrice('Make the rest', restQ.quote.total) : 'Make the rest'}
          </Button>
        );
      }
    } else if (failedScene) {
      primary = (
        <Button disabled={!failQ.quote || Boolean(busy)} onClick={() => startClips(failQ.quote, 'fail')}>
          {busy === 'fail' ? 'Starting…' : failQ.quote ? withPrice(`Try scene ${failedScene.n} again`, failQ.quote.total) : `Try scene ${failedScene.n} again`}
        </Button>
      );
    } else if (waitingCount > 0 || scenes.some((s) => s.state === 'making')) {
      hint = scenes.some((s) => s.state === 'making') && waitingCount > 0
        ? 'The next scene can start once this one is ready.'
        : 'Your scenes are being made. This page updates by itself, and you can leave it.';
    }
  } else if (active) {
    hint = 'Joining your clips, voice, music and captions.';
  } else if (failedRender || (latestDone && outdated) || (!latestDone && !render && price !== 0)) {
    const label = failedRender ? 'Try again' : latestDone ? 'Put the video together again' : 'Put the video together';
    primary = <Button disabled={Boolean(busy) || price === null} onClick={renderAgain}>{busy === 'render' ? 'Starting…' : price === null ? label : withPrice(label, price)}</Button>;
    if (latestDone) hint = 'Your clips changed since this video was made.';
  } else if (latestDone) {
    primary = (
      <a className={`${buttonStyles.btn} ${buttonStyles.primary}`} data-variant="primary" href={downloadHref(latestDone.url)} download={downloadFilename(project.title)}>
        <span>Download video</span>
      </a>
    );
  } else {
    hint = 'Putting your video together. It is included.';
  }

  return (
    <div className={styles.screen} data-screen="watch" data-state={doneNow && !outdated ? 'done' : active ? 'rendering' : 'making'}>
      <ScreenHead
        title="Watch and fix"
        sub={doneNow ? 'Watch your video, download it, or change any scene.' : 'Scenes appear here as they are made. You can play each one.'}
        status={statusText}
        done={doneNow && !outdated}
      />
      <Announce>{active ? 'Putting your video together' : !allReady ? `Making scene ${makingNumber}` : doneNow ? 'Your video is ready' : ''}</Announce>

      <div className={styles.stage}>
        {playing && playing.readyShots.length > 0 ? (
          <div className={styles.stageBox}>
            <ScenePlayer scene={playing} aspect={project.aspect} />
            <Button variant="ghost" size="sm" arrow={false} onClick={() => setSelected(null)}>{latestDone ? 'Back to the full video' : 'Close'}</Button>
          </div>
        ) : latestDone ? (
          <div className={styles.stageBox}>
            <VideoPlayer src={latestDone.url} aspect={project.aspect || '16:9'} title={project.title ? `${project.title}, version ${latestDone.version}` : 'Your video'} />
            <p className={styles.hint}>Version {latestDone.version}{latestDone.duration_seconds ? `, ${clock(latestDone.duration_seconds)}` : ''}{outdated ? '. A scene changed after this version.' : ''}</p>
            <Warnings render={latestDone} />
          </div>
        ) : active || allReady ? (
          <div className={styles.working} data-testid="render-progress">
            <div className={styles.workBar} role="progressbar" aria-label="Making your video" aria-busy="true"><span /></div>
            <strong>{active && render?.status === 'queued' ? 'Waiting for a turn…' : 'Putting your video together…'}</strong>
            <span className={styles.hint}>Clips, voice, music and captions are being joined. This usually takes a minute or two, and you can leave this page.</span>
          </div>
        ) : (
          <div className={styles.working}>
            <Skeleton status={`Making scene ${makingNumber}`} line="You can play each scene as soon as it is ready." ratio="16 / 7" />
          </div>
        )}
      </div>

      {failedRender && <p className={styles.planNote} role="alert">The video could not be put together. {render?.error || 'Try again.'}</p>}

      <ol className={styles.strip} aria-label="Scenes">
        {scenes.map((s) => {
          const thumb = s.shots.find((x) => x.still_url)?.still_url;
          return (
            <li key={s.id} className={`${styles.stripItem} ${selected === s.id ? styles.optionOn : ''}`} data-scene={s.id} data-state={s.state}>
              {s.readyShots.length > 0 ? (
                <button type="button" className={styles.stripImg} aria-label={`Play scene ${s.n}`} aria-pressed={selected === s.id} onClick={() => setSelected(selected === s.id ? null : s.id)}>
                  {thumb && <img src={thumb} alt="" loading="lazy" />}
                  <span className={styles.stripTick}><Check /></span>
                </button>
              ) : (
                <span className={styles.stripImg} data-making={s.state === 'making' ? '' : undefined}>
                  {thumb && <img src={thumb} alt="" loading="lazy" />}
                  {s.state === 'making' && <span className={styles.stripShimmer} aria-hidden="true" />}
                </span>
              )}
              <span className={styles.stripLabel}>Scene {s.n}</span>
              <span className={`${styles.stripState} ${s.state === 'failed' ? styles.stripFailed : ''}`}>{STATE_TEXT[s.state]}</span>
              {s.state === 'ready' && (
                <button
                  type="button"
                  className={styles.rowAction}
                  aria-label={`Change scene ${s.n}`}
                  aria-expanded={changing === s.id}
                  onClick={() => {
                    setChanging(changing === s.id ? null : s.id);
                    onAskChat?.(`Change scene ${s.n}: `);
                  }}
                >
                  Change this scene
                </button>
              )}
            </li>
          );
        })}
      </ol>

      {changing && scenes.find((s) => s.id === changing) && (
        <ChangePanel scene={scenes.find((s) => s.id === changing)} status={status} project={project} refresh={refresh} returnTo={returnTo} />
      )}

      {note && <p className={styles.planNote} data-testid="plan-note" role="status">{note}</p>}
      <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />

      <Dock
        label={doneNow && !outdated ? 'Your video' : 'Making your video'}
        meta={`${scenes.filter((s) => s.state === 'ready').length} of ${scenes.length} scenes ready`}
        hint={hint}
      >
        {secondary}
        {primary}
      </Dock>
    </div>
  );
}

