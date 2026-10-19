'use strict';

// L2: the shared tooltip.
//
// A tooltip supplements a control that already has a text label; it never carries
// information that exists nowhere else, because it is unreachable by touch and
// by several assistive-technology paths. Screens keep their visible label.
//
// Rules kept here:
//  - it shows on hover *and* on keyboard focus, so it is not a mouse-only affordance;
//  - it is wired with `aria-describedby`, so a screen reader reads it as part of
//    the control rather than as a stray element;
//  - Escape hides it, so a keyboard user is never stuck under a floating layer;
//  - it never sets pointer-events, so it can never intercept a click aimed at the
//    control beneath it.
import { cloneElement, useCallback, useEffect, useId, useRef, useState } from 'react';

export default function Tooltip({ label, children, placement = 'top' }) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  const wrapperRef = useRef(null);

  const show = useCallback(() => setVisible(true), []);
  const hide = useCallback(() => setVisible(false), []);

  // Escape dismisses from anywhere inside the wrapper.
  useEffect(() => {
    if (!visible) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setVisible(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visible]);

  // The child keeps its own props; we only add the described-by wiring.
  const child = cloneElement(children, { 'aria-describedby': visible ? id : undefined });

  return (
    <span
      className="tooltip-wrap"
      ref={wrapperRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {child}
      <span role="tooltip" id={id} className={`tooltip tooltip--${placement}`} data-visible={visible || undefined}>
        {label}
      </span>
    </span>
  );
}
