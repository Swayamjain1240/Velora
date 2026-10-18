'use strict';

// L2: a shared loading skeleton.
//
// It is decoration for a region whose shape is already known, so it is hidden
// from assistive technology; the caller keeps a real status message for screen
// readers (see MetricsPanel). Under prefers-reduced-motion the shimmer stops and
// only a static placeholder remains.
export default function Skeleton({ lines = 3, className = '' }) {
  return (
    <div className={`skeleton ${className}`.trim()} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="skeleton__line" />
      ))}
    </div>
  );
}
