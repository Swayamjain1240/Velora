'use strict';

// WAI-ARIA tabs keyboard contract, shared by every tab strip in the app.
//
// The screens already marked their strips `role="tablist"` / `role="tab"`, but
// that alone only renames the buttons: a keyboard user still had to Tab through
// every tab, and the arrow keys did nothing. The pattern requires
//
//  - ONE tab stop for the whole strip (roving tabindex: the selected tab has
//    tabIndex 0, the others -1), and
//  - Left/Right to move between tabs, wrapping at both ends, with Home/End
//    jumping to the first/last tab.
//
// Selection follows focus, which is the "automatic activation" variant: every
// panel here is cheap to render, so a user should not have to press Enter after
// arrowing.
//
// Deliberately NOT a hook: these are pure functions called from the tab list's
// onKeyDown, so a screen adds two attributes instead of restructuring its
// component to satisfy the rules of hooks. `keys` must be the VISIBLE tabs in
// order, and `onChange` should mirror the click handler so arrow navigation
// cannot land on a state the click path would have reset (a stale page number,
// for example).

export function tabStop(key, active) {
  // Roving tabindex: exactly one tab in the strip is reachable with Tab.
  return key === active ? 0 : -1;
}

export function onTabListKeyDown(event, keys, active, onChange) {
  const current = keys.indexOf(active);
  if (current === -1) return;
  const last = keys.length - 1;
  let nextIndex;
  switch (event.key) {
    case 'ArrowRight':
      nextIndex = current === last ? 0 : current + 1;
      break;
    case 'ArrowLeft':
      nextIndex = current === 0 ? last : current - 1;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = last;
      break;
    default:
      return;
  }
  event.preventDefault();
  const next = keys[nextIndex];
  onChange(next);
  // Focus follows selection. The buttons are not re-created by the state change
  // (same keys, same order), so the node is still in the document and can be
  // focused immediately; the re-render then gives it tabIndex 0.
  const buttons = event.currentTarget.querySelectorAll('[role="tab"]');
  const target = buttons[nextIndex];
  if (target && typeof target.focus === 'function') target.focus();
}
