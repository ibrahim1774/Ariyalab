/*
 * Duration control for Ariya Lab video generation.
 * Standard (Seedance) → 4/6/12s preset pills.
 * Studio Pro (Kling 3.0) → 3–15s slider.
 * Live cost reflects model × resolution × audio.
 */

import { costForBilling } from '../lib/cost';

export const STANDARD_DURATION_PRESETS = [4, 6, 12];

// Convenience helper for callers that compute cost outside the slider.
// `billing` is the entitlement's flag ('v2' = ledger credits, the price the
// server charges then; anything else = legacy credits).
export function costForDuration(seconds, model = 'standard', resolution = '480p', audio = false, billing = null) {
  return costForBilling(billing, { seconds, model, resolution, audio });
}

export function snapToStandardPreset(d) {
  if (STANDARD_DURATION_PRESETS.includes(d)) return d;
  return STANDARD_DURATION_PRESETS.reduce((a, b) =>
    Math.abs(b - d) < Math.abs(a - d) ? b : a
  );
}

export default function DurationSlider({
  value,
  onChange,
  label = 'Length',
  min = 3,
  max = 15,
  showCost = true,
  ariaLabel = 'Duration',
  model = 'standard',
  resolution = '480p',
  audio = false,
  billing = null,
}) {
  const cost = costForBilling(billing, { seconds: value, model, resolution, audio });
  const isStandard = model === 'standard';

  return (
    <div>
      <div
        style={{
          fontFamily: 'inherit',
          fontSize: 13,
          color: 'var(--text)',
          margin: '12px 0 6px',
          letterSpacing: '0.02em',
        }}
      >
        {label}:{' '}
        <span style={{ color: 'var(--text)' }}>{value} seconds</span>
        {showCost && (
          <>
            {' · '}
            <span style={{ color: 'var(--text)' }}>
              {cost} credit{cost === 1 ? '' : 's'}
            </span>
          </>
        )}
      </div>

      {isStandard ? (
        <div
          role="radiogroup"
          aria-label={ariaLabel}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
        >
          {STANDARD_DURATION_PRESETS.map((sec) => {
            const selected = value === sec;
            return (
              <button
                key={sec}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange(sec)}
                style={{
                  flex: '1 1 0',
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: selected
                    ? '1px solid var(--accent)'
                    : '1px solid rgba(22, 19, 15, 0.14)',
                  background: selected ? 'var(--accent)' : 'var(--surface)',
                  color: selected ? '#fff' : 'var(--text)',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  fontWeight: selected ? 600 : 500,
                  cursor: 'pointer',
                  transition: 'background 120ms ease, color 120ms ease',
                }}
              >
                {sec}s
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <input
            type="range"
            min={min}
            max={max}
            step={1}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
            aria-label={ariaLabel}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              color: 'var(--text-dim)',
              marginTop: 4,
              fontFamily: 'inherit',
            }}
          >
            <span>{min}s</span>
            <span>{max}s</span>
          </div>
        </>
      )}
    </div>
  );
}
