/*
 * Resolution + audio selector for video generation.
 *
 * - Resolution pills: 480p / 720p / 1080p (compact single-line)
 * - Audio: iOS-style toggle switch on the label row
 *
 * Live credit cost on the CTA reflects whatever the user picks.
 */

import { ratePerSecond } from '../lib/cost';

const RESOLUTIONS = ['480p', '720p', '1080p'];

export default function ResolutionPicker({
  model = 'standard',
  resolution = '480p',
  audio = false,
  onChange,
  disabled = false,
}) {
  const update = (patch) => {
    if (!onChange) return;
    onChange({ resolution, audio, ...patch });
  };
  const currentRate = ratePerSecond({ model, resolution, audio });
  return (
    <div style={wrapStyle}>
      <div style={labelRowStyle}>
        <span style={labelStyle}>Quality</span>
        <span style={rateStyle}>{currentRate} cr/sec</span>
        <button
          type="button"
          role="switch"
          aria-checked={audio}
          aria-label={audio ? 'Audio on, click to mute' : 'Audio off, click to enable'}
          disabled={disabled}
          onClick={() => update({ audio: !audio })}
          style={{
            ...switchRowStyle,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.55 : 1,
          }}
        >
          <span style={switchLabelStyle}>{audio ? '🔊 Audio' : '🔇 Silent'}</span>
          <span
            style={{
              ...switchTrackStyle,
              background: audio ? 'var(--accent)' : 'rgba(22, 19, 15, 0.18)',
            }}
          >
            <span
              style={{
                ...switchKnobStyle,
                transform: audio ? 'translateX(16px)' : 'translateX(0)',
              }}
            />
          </span>
        </button>
      </div>
      <div style={resRowStyle}>
        {RESOLUTIONS.map((r) => {
          const active = resolution === r;
          return (
            <button
              key={r}
              type="button"
              disabled={disabled}
              onClick={() => update({ resolution: r })}
              style={{
                ...pillStyle,
                ...(active ? pillActiveStyle : null),
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.55 : 1,
              }}
              aria-pressed={active}
            >
              {r}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const wrapStyle = { marginBottom: 10 };
const labelRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 6,
};
const labelStyle = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 11,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--text-dim)',
};
const rateStyle = {
  fontSize: 11,
  color: 'var(--text-dim)',
  marginRight: 'auto',
};
const switchRowStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px 4px 10px',
  border: '1px solid rgba(22, 19, 15, 0.126)',
  borderRadius: 999,
  background: 'rgba(22, 19, 15, 0.02)',
  color: 'var(--text)',
  fontFamily: 'inherit',
};
const switchLabelStyle = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.01em',
};
const switchTrackStyle = {
  position: 'relative',
  display: 'inline-block',
  width: 32,
  height: 16,
  borderRadius: 999,
  transition: 'background 120ms ease',
};
const switchKnobStyle = {
  position: 'absolute',
  top: 1,
  left: 1,
  width: 14,
  height: 14,
  borderRadius: '50%',
  background: '#ffffff',
  boxShadow: '0 1px 2px rgba(22, 19, 15, 0.09)',
  transition: 'transform 120ms ease',
};
const resRowStyle = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr 1fr',
  gap: 8,
};
const pillStyle = {
  padding: '8px 10px',
  border: '1px solid rgba(22, 19, 15, 0.162)',
  borderRadius: 10,
  background: 'rgba(22, 19, 15, 0.02)',
  color: 'var(--text)',
  fontFamily: 'inherit',
  fontSize: 14,
  fontWeight: 500,
  textAlign: 'center',
};
const pillActiveStyle = {
  borderColor: 'rgba(22, 19, 15, 0.2)',
  background: 'rgba(22, 19, 15, 0.06)',
  fontWeight: 600,
};
