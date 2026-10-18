'use strict';

// L2 / stage 4: a compact bar comparison for a handful of named counts.
//
// The chart is a second view of numbers that are also in a table, so it is
// hidden from assistive technology and the table remains the source of truth.
// No charting dependency: a few flex rows are enough for "which queue is
// oldest/busiest", and they reflow at every width.
export default function MiniBars({ items, unit = '', className = '' }) {
  if (!items || items.length === 0) return null;
  const max = Math.max(...items.map((item) => Number(item.value) || 0), 1);
  return (
    <div className={`mini-bars ${className}`.trim()} aria-hidden="true">
      {items.map((item) => {
        const value = Number(item.value) || 0;
        const percent = Math.max(2, Math.round((value / max) * 100));
        return (
          <div className="mini-bars__row" key={item.label}>
            <span className="mini-bars__label">{item.label}</span>
            <span className="mini-bars__track">
              <span className="mini-bars__fill" style={{ width: `${percent}%` }} />
            </span>
            <span className="mini-bars__value">
              {value}
              {unit ? ` ${unit}` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}
