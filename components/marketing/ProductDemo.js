import { useEffect, useRef, useState } from 'react';

import { creditsForVideo } from '../../lib/pricingConstants';
import styles from './ProductDemo.module.css';

// A scripted, looping demo of the maker's four screens, drawn with the app's own look (step rail,
// option chips, shot pictures, quote bar, chat). Everything here is fake data: nothing talks to the server.
// The clock is one setInterval that adds TICK ms to `elapsed`; every picture is worked out from that
// number, so pausing is just "stop ticking" and the tests can drive it with fake timers.

export const IDEA = 'A barber turns a bad haircut into a comeback story';
export const ASK = 'Make the hook funnier';
const TICK = 50;
const TYPE_FROM = 400;
const TYPE_MS = 42;
const ASK_FROM = 2900;
const ASK_MS = 55;
const SEND_AT = 4400;
const REPLY_AT = 5500;
const BALANCE = 1500;

/** Length chips on the first screen, each with what a Standard video of that length costs. */
export const LENGTHS = [
  { seconds: 7, label: '7 s' },
  { seconds: 10, label: '10 s' },
  { seconds: 30, label: '30 s' },
  { seconds: 60, label: '60 s' },
  { seconds: 120, label: '2 min' },
].map((l) => ({ ...l, credits: creditsForVideo({ quality: 'standard', seconds: l.seconds }) }));
const PICK = { quality: 'standard', seconds: 30 };
export const COST = creditsForVideo(PICK);

// Making the video: each of the four scenes fills in turn, then the finished video plays.
const MAKE_FROM = 200;
const MAKE_EACH = 900;
const PLAY_AT = MAKE_FROM + 4 * MAKE_EACH + 300;

// The cursor goes to the screen's main button and clicks it near the end of the screen.
const go = (ms) => [[ms - 1100, 'cta'], [ms - 350, 'cta', true]];

/** The maker's four screens, in order. `ms` is how long each one stays on screen. */
export const SCENES = [
  { id: 'describe', label: 'Describe it', ms: 6500, cursor: [[2900, 'len-30'], ...go(6500)] },
  {
    id: 'script',
    label: 'Check the script',
    ms: 8000,
    cursor: [[2000, 'chat-input'], [2600, 'chat-input', true], [3700, 'chat-send'], [SEND_AT - 100, 'chat-send', true], ...go(8000)],
  },
  { id: 'plan', label: 'Check the plan', ms: 6500, cursor: [[3300, 'cta2'], ...go(6500)] },
  {
    id: 'watch',
    label: 'Watch and fix',
    ms: 11500,
    cursor: [[6000, 'strip-2'], [6800, 'strip-2', true], [8200, 'download'], [9000, 'download', true]],
  },
];

const TOTAL = SCENES.reduce((n, s) => n + s.ms, 0);
const STARTS = SCENES.reduce((list, s, i) => [...list, i === 0 ? 0 : list[i - 1] + SCENES[i - 1].ms], []);
const indexOf = (id) => SCENES.findIndex((s) => s.id === id);

/** The screen showing `elapsed` ms into the loop, with the time spent inside it (`lt`). */
export function sceneAt(elapsed) {
  const t = ((elapsed % TOTAL) + TOTAL) % TOTAL;
  let i = SCENES.length - 1;
  while (i > 0 && STARTS[i] > t) i -= 1;
  return { ...SCENES[i], index: i, lt: t - STARTS[i] };
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const ease = (n) => 1 - (1 - clamp01(n)) ** 3;
const fmt = (n) => Math.round(n).toLocaleString('en-US');

const STYLE = { label: '3D animated family film', src: '/styles/3d_family.jpg' };
const SCRIPT = [
  'Dre gives a client a crooked fade and the whole shop goes quiet.',
  'That night the clip goes viral for all the wrong reasons.',
  'Uncle Tony hands him the clippers. Practice, every night.',
  'A year later there is a line out the door of his own shop.',
];
const FUNNIER = 'Dre cuts a fade so crooked the barber pole starts spinning the other way.';
const CAST = [
  { name: 'Dre', role: 'The young barber', src: '/mock/cast-dre-0.jpg' },
  { name: 'Marcus', role: 'His first client', src: '/mock/cast-marcus-0.jpg' },
  { name: 'Tony', role: 'Shop owner', src: '/mock/cast-tony-0.jpg' },
];
const SHOTS = [
  { src: '/mock/still-4.jpg', line: 'A crooked fade' },
  { src: '/mock/still-3.jpg', line: 'The shop goes quiet' },
  { src: '/mock/still-7.jpg', line: 'The clip goes viral' },
  { src: '/mock/still-6.jpg', line: 'Practice every night' },
  { src: '/mock/still-2.jpg', line: 'Back in the chair' },
  { src: '/mock/still-1.jpg', line: 'A line out the door' },
];
const STRIP = [SHOTS[0], SHOTS[2], SHOTS[3], SHOTS[5]];
const POSTER = '/examples/skit-3d-barbers.jpg';
const VIDEO = '/examples/skit-3d-barbers.mp4';
// Fixed bar heights so the voice wave looks like speech and never changes between renders.
const WAVE = Array.from({ length: 18 }, (_, i) => 0.3 + 0.7 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.43)));

function Img({ src, className = '' }) {
  return <img src={src} alt="" loading="lazy" decoding="async" draggable="false" className={className} />;
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- screens. Each gets `lt` (ms into the screen) and `press` (the target being clicked right now).

function SceneDescribe({ lt, press }) {
  const chars = Math.max(0, Math.min(IDEA.length, Math.floor((lt - TYPE_FROM) / TYPE_MS)));
  const typing = chars < IDEA.length;
  return (
    <div className={styles.scene}>
      <h3 className={styles.h}>Describe your video</h3>
      <p className={styles.sub}>One line is enough. You can change everything later.</p>
      <div className={`${styles.textbox} ${lt > 200 ? styles.focused : ''}`}>
        <span data-testid="demo-idea">{IDEA.slice(0, chars)}</span>
        <span className={`${styles.caret} ${typing ? styles.caretSolid : ''}`} />
        {chars === 0 && <span className={styles.placeholder}>A coffee cart that remembers every order</span>}
      </div>
      <div className={styles.settings}>
        <div className={styles.setting}>
          <span className={styles.settingLabel}>Style</span>
          <span className={styles.stylePill}>
            <span className={styles.styleThumb}><Img src={STYLE.src} /></span>
            {STYLE.label}
          </span>
        </div>
        <div className={styles.setting}>
          <span className={styles.settingLabel}>Length</span>
          <span className={styles.chips}>
            {LENGTHS.map((l) => (
              <span
                key={l.seconds}
                data-target={`len-${l.seconds}`}
                className={`${styles.chip} ${l.seconds === PICK.seconds ? styles.optionOn : ''} ${press === `len-${l.seconds}` ? styles.pressed : ''}`}
              >
                <strong>{l.label}</strong>
                <small>{fmt(l.credits)} credits</small>
              </span>
            ))}
          </span>
        </div>
        <div className={styles.setting}>
          <span className={styles.settingLabel}>Quality</span>
          <span className={`${styles.chip} ${styles.optionOn}`}>
            <strong>Standard, recommended</strong>
          </span>
        </div>
      </div>
    </div>
  );
}

function SceneScript({ lt }) {
  const shown = SCRIPT.filter((_, i) => lt >= 300 + i * 500).length;
  const changed = lt >= REPLY_AT + 100;
  const done = shown === SCRIPT.length;
  return (
    <div className={styles.scene}>
      <div className={styles.headRow}>
        <h3 className={styles.h}>Check the script</h3>
        <span className={`${styles.status} ${done ? styles.statusDone : ''}`}>
          {done ? <><Check /> 4 scenes, 30 s</> : 'Writing…'}
        </span>
      </div>
      <ol className={styles.scriptList}>
        {SCRIPT.map((line, i) => (
          <li
            key={line}
            className={`${styles.scriptLine} ${i < shown ? styles.in : ''} ${i === 0 && changed ? styles.changed : ''}`}
          >
            <span className={styles.sceneTag}>
              Scene {i + 1}
              {i === 0 && changed && <span className={styles.updated}>Updated</span>}
            </span>
            <span className={styles.scriptText} data-testid={i === 0 ? 'demo-line-1' : undefined}>
              {i === 0 && changed ? FUNNIER : line}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ScenePlan({ lt }) {
  const shots = SHOTS.filter((_, i) => lt >= 900 + i * 250).length;
  return (
    <div className={styles.scene}>
      <div className={styles.headRow}>
        <h3 className={styles.h}>Check the plan</h3>
        <span className={`${styles.status} ${shots === SHOTS.length ? styles.statusDone : ''}`}>
          {shots === SHOTS.length ? <><Check /> Ready to make</> : 'Drawing…'}
        </span>
      </div>
      <div className={styles.planTop}>
        <div className={styles.castRow}>
          {CAST.map((c, i) => (
            <div key={c.name} className={styles.castCard}>
              <span className={`${styles.castImg} ${lt >= 200 + i * 250 ? styles.ready : ''}`}>
                <span className={styles.shimmer} />
                <Img src={c.src} />
              </span>
              <span className={styles.castName}>{c.name}</span>
              <span className={styles.castRole}>{c.role}</span>
            </div>
          ))}
        </div>
        <div className={styles.sound}>
          <span className={`${styles.voicePill} ${lt >= 2400 ? styles.in : ''}`}>
            <span className={styles.play}>
              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor" /></svg>
            </span>
            <span className={styles.pillText}><strong>Narrator</strong> Warm and steady</span>
            <span className={styles.wave}>
              {WAVE.map((h, i) => <span key={i} style={{ transform: `scaleY(${h.toFixed(2)})` }} />)}
            </span>
          </span>
          <span className={`${styles.musicPill} ${lt >= 2700 ? styles.in : ''}`}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path d="M6 12.5a2 2 0 1 1-1-1.73V3l7-1.5v8.5a2 2 0 1 1-1-1.73V4.2L6 5.3z" fill="currentColor" />
            </svg>
            <span className={styles.pillText}><strong>Music</strong> Soft hip hop beat</span>
          </span>
        </div>
      </div>
      <div className={styles.shotGrid}>
        {SHOTS.map((s, i) => (
          <span key={s.src} className={`${styles.shotImg} ${i < shots ? styles.ready : ''}`}>
            <span className={styles.shimmer} />
            <Img src={s.src} />
            <span className={styles.shotNum}>{i + 1}</span>
            <span className={styles.shotLine}>{s.line}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const sceneProgress = (lt, i) => clamp01((lt - MAKE_FROM - i * MAKE_EACH) / MAKE_EACH);

function SceneWatch({ lt, press, active, still, playing }) {
  const ref = useRef(null);
  const made = still ? 4 : STRIP.filter((_, i) => sceneProgress(lt, i) >= 1).length;
  const ready = still || lt >= PLAY_AT;
  const picked = !still && lt >= 6800;
  const saved = !still && lt >= 9000;
  const making = Math.min(4, made + 1);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    try {
      if (playing) {
        v.muted = true;
        v.play()?.catch?.(() => {});
      } else {
        v.pause();
      }
    } catch {
      // The poster stays up if the browser will not play it.
    }
  }, [playing]);

  return (
    <div className={`${styles.scene} ${styles.watch}`}>
      <div className={styles.player}>
        {still || !active ? (
          <Img src={POSTER} className={styles.media} />
        ) : (
          <video ref={ref} className={styles.media} src={VIDEO} poster={POSTER} preload="none" muted loop playsInline />
        )}
        <span className={`${styles.renderLayer} ${ready ? styles.gone : ''}`}>
          <span className={styles.renderCard}>
            <span className={styles.renderTitle}>Making scene {making} of 4</span>
            <span className={styles.track}><span style={{ transform: `scaleX(${clamp01((lt - MAKE_FROM) / (4 * MAKE_EACH)).toFixed(3)})` }} /></span>
          </span>
        </span>
      </div>
      <div className={styles.watchInfo}>
        <span className={`${styles.status} ${ready ? styles.statusDone : ''}`}>
          {ready ? <><Check /> Ready</> : 'Making your video…'}
        </span>
        <h3 className={styles.watchTitle}>The comeback cut</h3>
        <p className={styles.sub}>30 seconds, 9:16, captions on</p>
        {still ? (
          <ol className={styles.doneList} data-demo-steps>
            {SCENES.map((s) => (
              <li key={s.id} className={styles.in}>
                <span className={styles.doneMark}><Check /></span>
                {s.label}
              </li>
            ))}
          </ol>
        ) : (
          <>
            <div className={styles.strip}>
              {STRIP.map((s, i) => {
                const p = sceneProgress(lt, i);
                const id = `strip-${i + 1}`;
                return (
                  <span
                    key={s.src}
                    data-target={id}
                    className={`${styles.stripItem} ${p >= 1 ? styles.ready : ''} ${picked && i === 1 ? styles.picked : ''} ${press === id ? styles.pressed : ''}`}
                  >
                    <span className={styles.stripImg}>
                      <Img src={s.src} />
                      {p >= 1 && <span className={styles.stripTick}><Check /></span>}
                    </span>
                    <span className={styles.track}><span style={{ transform: `scaleX(${p.toFixed(3)})` }} /></span>
                    <span className={styles.stripLabel}>Scene {i + 1}</span>
                  </span>
                );
              })}
            </div>
            <span className={`${styles.ghostBtn} ${picked ? styles.in : ''}`}>Change this scene</span>
          </>
        )}
        <span
          data-target="download"
          className={`${styles.cta} ${styles.download} ${ready ? '' : styles.ctaOff} ${press === 'download' ? styles.pressed : ''}`}
        >
          {saved ? <><Check /> Saved</> : 'Download'}
        </span>
      </div>
    </div>
  );
}

const SCENE_VIEWS = { describe: SceneDescribe, script: SceneScript, plan: ScenePlan, watch: SceneWatch };

/** The chat beside the maker. On the script screen the customer asks for a change. */
function Chat({ id, lt, still }) {
  const typed = id === 'script' && lt < SEND_AT ? ASK.slice(0, Math.max(0, Math.floor((lt - ASK_FROM) / ASK_MS))) : '';
  const msgs = [];
  if (id === 'describe') msgs.push({ who: 'ai', text: 'Tell me your idea in one line. I picked a style, a length and a quality to start.' });
  if (id === 'script') {
    if (lt >= 400) msgs.push({ who: 'ai', text: 'Here is your script. Want any changes?' });
    if (lt >= SEND_AT) msgs.push({ who: 'me', text: ASK });
    if (lt >= SEND_AT + 200 && lt < REPLY_AT) msgs.push({ who: 'ai', typing: true });
    if (lt >= REPLY_AT) msgs.push({ who: 'ai', text: 'Done. Scene 1 is funnier now.' });
  }
  if (id === 'plan') msgs.push({ who: 'ai', text: 'Here is the plan. Try scene 1 first if you want to check the look.' });
  if (id === 'watch') msgs.push({ who: 'ai', text: still ? 'Your video is ready.' : 'Your video is ready. Pick a scene to change it.' });
  const focused = id === 'script' && lt >= 2600 && lt < SEND_AT;
  return (
    <div className={styles.chat}>
      <p className={styles.sideTitle}>Chat</p>
      <div className={styles.bubbles}>
        {msgs.map((m, i) => (
          <span key={`${id}-${i}-${m.typing ? 't' : 'm'}`} className={`${styles.bubble} ${m.who === 'me' ? styles.mine : ''}`}>
            {m.typing ? <span className={styles.dots3}><i /><i /><i /></span> : m.text}
          </span>
        ))}
      </div>
      <div className={`${styles.chatInput} ${focused ? styles.focused : ''}`} data-target="chat-input">
        <span className={styles.chatText}>
          <span data-testid="demo-chat-input">{typed}</span>
          {focused && <span className={styles.caret} />}
          {!typed && !focused && <span className={styles.chatPlaceholder}>Ask for a change</span>}
        </span>
        <span className={`${styles.send} ${typed ? styles.sendOn : ''}`} data-target="chat-send">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
      </div>
    </div>
  );
}

function Rail({ current }) {
  const ci = indexOf(current);
  return (
    <ol className={styles.rail} data-demo-rail>
      {SCENES.map((s, i) => {
        const state = i < ci ? 'done' : i === ci ? 'current' : 'upcoming';
        return (
          <li key={s.id} data-step={s.id} data-state={state} className={`${styles.railStep} ${styles[state]}`}>
            <span className={styles.marker}>{state === 'done' ? <Check /> : i + 1}</span>
            <span className={styles.railLabel}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export default function ProductDemo() {
  // 'pending' until the first effect knows whether motion is allowed (so the server render and the
  // first client render match), then 'anim' or 'still'.
  const [mode, setMode] = useState('pending');
  const [elapsed, setElapsed] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  const [cursor, setCursor] = useState(null);
  const [size, setSize] = useState(0);
  const frameRef = useRef(null);

  useEffect(() => {
    const mql = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const apply = () => setMode(mql?.matches ? 'still' : 'anim');
    apply();
    mql?.addEventListener?.('change', apply);
    return () => mql?.removeEventListener?.('change', apply);
  }, []);

  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) setOnScreen(e.isIntersecting);
    }, { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect?.();
  }, []);

  useEffect(() => {
    const onVis = () => setTabVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setSize((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const still = mode === 'still';
  const running = mode === 'anim' && !userPaused && onScreen && tabVisible;

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setElapsed((n) => n + TICK), TICK);
    return () => clearInterval(id);
  }, [running]);

  const t = still ? TOTAL - 1 : elapsed % TOTAL;
  const scene = sceneAt(t);
  const { lt } = scene;

  // Where the cursor is headed, and whether it is clicking right now.
  let target = null;
  let press = null;
  let clickKey = null;
  if (!still) {
    for (const [at, id, click] of scene.cursor) {
      if (lt >= at) target = id;
      if (click && lt >= at && lt < at + 260) press = id;
      if (click && lt >= at && lt < at + 600) clickKey = `${scene.id}-${at}`;
    }
  }

  // Measure the target on screen so the cursor lands on it at any window size.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const f = frame.getBoundingClientRect();
    const el = target
      && (frame.querySelector(`[data-panel="active"] [data-target="${target}"]`) || frame.querySelector(`[data-fixed] [data-target="${target}"]`));
    if (!el || !el.getClientRects().length) {
      // Rest in the lower middle until the first thing to click.
      setCursor((c) => c || { x: f.width * 0.5, y: f.height * 0.72 });
      return;
    }
    const r = el.getBoundingClientRect();
    setCursor({ x: r.left - f.left + r.width * 0.6, y: r.top - f.top + r.height * 0.6 });
  }, [target, scene.id, size, mode]);

  // Panels: the current one, the one fading out, and the next one (hidden, so its pictures load early).
  const panels = [{ index: scene.index, lt, role: 'active' }];
  if (!still && lt < 450 && (scene.index > 0 || elapsed >= TOTAL)) {
    const prev = (scene.index + SCENES.length - 1) % SCENES.length;
    panels.unshift({ index: prev, lt: SCENES[prev].ms, role: 'leaving' });
  }
  if (!still && scene.index < SCENES.length - 1) panels.push({ index: scene.index + 1, lt: 0, role: 'next' });

  const spent = scene.id === 'watch';
  const balance = spent ? BALANCE - COST : BALANCE;
  const progress = still ? 1 : t / TOTAL;

  return (
    <div className={styles.demo} data-demo>
      <p className={styles.srOnly}>
        A short demo of making a video with Ariya Lab. Someone describes a story idea in one line, checks the script and asks
        for a funnier opening, checks the cast, pictures, voice and music, then watches the finished video and downloads it.
      </p>
      <div className={styles.shell}>
        <div
          ref={frameRef}
          className={`${styles.frame} ${running ? '' : styles.paused}`}
          data-demo-step={scene.id}
          data-demo-static={still ? '' : undefined}
          aria-hidden="true"
        >
          <div className={styles.chrome}>
            <span className={styles.dots}><i /><i /><i /></span>
            <span className={styles.url}>
              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                <path d="M5 7V5a3 3 0 0 1 6 0v2h1v7H4V7zm1.5 0h3V5a1.5 1.5 0 0 0-3 0z" fill="currentColor" />
              </svg>
              ariyalab.com/app
            </span>
            <span />
          </div>
          <div className={styles.app}>
            <div className={styles.appHead}>
              <span className={styles.brand}>
                <span className={styles.logo}>A</span>
                <span className={styles.brandName}>Ariya Lab</span>
              </span>
              <Rail current={scene.id} />
              <span key={balance} className={`${styles.balance} ${spent && !still ? styles.flash : ''}`}>
                {fmt(balance)} <span className={styles.unit}>credits</span>
              </span>
            </div>
            <div className={styles.body}>
              <div className={styles.main}>
                <div className={styles.stage}>
                  {panels.map((p) => {
                    const View = SCENE_VIEWS[SCENES[p.index].id];
                    return (
                      <div key={SCENES[p.index].id} className={`${styles.panel} ${styles[p.role]}`} data-panel={p.role}>
                        <View
                          lt={p.lt}
                          press={p.role === 'active' ? press : null}
                          active={p.role !== 'next'}
                          still={still}
                          playing={p.role === 'active' && running && p.lt >= PLAY_AT}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className={styles.dock} data-fixed>
                  <div className={styles.quote}>
                    <span className={styles.quoteLabel}>{spent ? 'Spent on this video' : 'Estimated cost'}</span>
                    <strong className={styles.quoteTotal} data-testid="demo-cost">{fmt(COST)} credits</strong>
                    <span className={styles.quoteMeta}>Standard, 30 seconds</span>
                  </div>
                  <span className={styles.dockButtons}>
                    {scene.id === 'plan' && (
                      <span data-target="cta2" className={`${styles.ghostBtn} ${styles.in}`}>Try scene 1 first</span>
                    )}
                    {scene.id !== 'watch' && (
                      <span key={scene.id} data-target="cta" className={`${styles.cta} ${press === 'cta' ? styles.pressed : ''}`}>
                        {scene.id === 'describe' && 'Write my script'}
                        {scene.id === 'script' && 'Looks good, design my video'}
                        {scene.id === 'plan' && <span data-testid="demo-make">Make my video ({fmt(COST)} credits)</span>}
                        <span className={styles.arrow}>&rarr;</span>
                      </span>
                    )}
                  </span>
                </div>
              </div>
              <aside className={styles.side} data-fixed>
                <Chat id={scene.id} lt={lt} still={still} />
              </aside>
            </div>
          </div>
          {!still && (
            <span
              className={`${styles.cursor} ${cursor ? styles.cursorOn : ''}`}
              style={cursor ? { transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)` } : undefined}
            >
              {clickKey && <span key={clickKey} className={styles.ripple} />}
              <svg className={press ? styles.cursorDown : ''} viewBox="0 0 24 24" width="22" height="22">
                <path d="M5 3l13.5 8.2-6.1 1.3 3.6 6.7-2.6 1.4-3.6-6.8L5 18.3z" fill="#16130F" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            </span>
          )}
        </div>
      </div>
      <div className={styles.controls}>
        <span className={styles.caption} aria-hidden="true">
          <span className={styles.captionStep}>Step {scene.index + 1} of {SCENES.length}</span>
          <span className={styles.captionLabel}>{scene.label}</span>
        </span>
        <span className={styles.progress} aria-hidden="true">
          <span style={{ transform: `scaleX(${progress.toFixed(4)})` }} />
        </span>
        {!still && (
          <button
            type="button"
            className={styles.pause}
            aria-label="Pause demo"
            aria-pressed={userPaused}
            title={userPaused ? 'Play demo' : 'Pause demo'}
            onClick={() => setUserPaused((p) => !p)}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              {userPaused ? <path d="M4.5 2.5v11l9-5.5z" fill="currentColor" /> : <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor" />}
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
