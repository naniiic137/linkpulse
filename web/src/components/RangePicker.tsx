import { useId, useState } from 'react';
import { customRange, isoDate, PRESETS, presetRange, type DateRange } from '../lib/range';

interface Props {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

export function RangePicker({ value, onChange }: Props) {
  const [showCustom, setShowCustom] = useState(value.preset === 'custom');
  const [from, setFrom] = useState(isoDate(value.from));
  const [to, setTo] = useState(isoDate(value.to));
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const today = new Date().toISOString().slice(0, 10);

  const applyCustom = () => {
    const r = customRange(from, to);
    if (!r) return setError('Pick a start date on or before the end date.');
    setError(null);
    onChange(r);
  };

  return (
    <div className="range">
      <div className="segmented segmented--pills" role="group" aria-label="Date range">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="segmented__btn"
            aria-pressed={value.preset === p.id}
            onClick={() => {
              setShowCustom(false);
              onChange(presetRange(p.id));
            }}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className="segmented__btn"
          aria-pressed={value.preset === 'custom'}
          aria-expanded={showCustom}
          onClick={() => setShowCustom((s) => !s)}
        >
          Custom
        </button>
      </div>
      {showCustom && (
        <div className="range__custom">
          <label className="range__field" htmlFor={`${uid}-from`}>
            <span>From</span>
            <input id={`${uid}-from`} type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="range__field" htmlFor={`${uid}-to`}>
            <span>To</span>
            <input id={`${uid}-to`} type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="button" className="btn btn--secondary btn--sm" onClick={applyCustom}>
            Apply
          </button>
          {error && (
            <p className="field__error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
