'use strict';

// L4: a scroll box a keyboard can actually drive.
//
// `.panel-scroll` clips content that grows past its bounds - a long list, a
// wide table. When such a region holds interactive rows, Tab already reaches
// them and the browser scrolls the focused control into view. When it holds
// only text, a keyboard-only user has no way to scroll it at all: axe reports
// this as scrollable-region-focusable and, more substantively, WCAG 2.1.1
// (Keyboard) fails.
//
// So the region joins the tab order and carries a name, which also turns an
// anonymous div into a landmark a screen reader can jump to. The focus ring is
// the global :focus-visible outline from base.css.
//
// `label` is required in practice: a nameless focusable region is a stop that
// announces nothing.
export default function ScrollRegion({ label, className = '', children, ...rest }) {
  return (
    <div
      className={`panel-scroll ${className}`.trim()}
      role="region"
      aria-label={label}
      tabIndex={0}
      {...rest}
    >
      {children}
    </div>
  );
}
