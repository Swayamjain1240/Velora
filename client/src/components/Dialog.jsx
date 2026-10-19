'use strict';

// L2: the shared modal dialog.
//
// Rules this primitive keeps so screens cannot get them wrong by accident:
//  - focus moves into the dialog on open and returns to the trigger on close;
//  - Tab and Shift+Tab cycle inside the dialog (a real trap, not a scroll lock);
//  - Escape and a backdrop click both dismiss, because a destructive action must
//    always have an obvious way out;
//  - `role="alertdialog"` with an accessible name and description, so a screen
//    reader announces what it is and why;
//  - nothing is animated from zero opacity, and prefers-reduced-motion renders
//    the final state immediately (the same contract as lib/motion.js).
//
// It is presentation only: it performs no request, holds no data and changes no
// copy. A confirmation that triggers a destructive call still belongs to the
// screen, which keeps the server as the authorization boundary.
import { useCallback, useEffect, useId, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  /** Label for the close control; required so the icon-only button is named. */
  closeLabel = 'Close dialog',
  /** Set false for a confirmation that must be answered, not dismissed by click. */
  dismissOnBackdrop = true,
}) {
  const panelRef = useRef(null);
  const previouslyFocused = useRef(null);
  const titleId = useId();
  const descriptionId = useId();

  // Remember the element that opened the dialog, then move focus into the
  // panel. Both happen in one effect on purpose: a separate focus effect would
  // run after this capture and record <body>, losing the restore target.
  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement;

    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector(FOCUSABLE);
      (first || panel).focus();
    }

    return () => {
      const target = previouslyFocused.current;
      if (target && typeof target.focus === 'function' && document.contains(target)) {
        target.focus();
      }
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      // Cycle focus inside the dialog.
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  if (!open) return null;

  return (
    <div
      className="dialog"
      onKeyDown={handleKeyDown}
      data-testid="dialog-root"
    >
      <div
        className="dialog__backdrop"
        onClick={dismissOnBackdrop ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        className="dialog__panel"
        role={description ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="dialog__head">
          <h2 id={titleId} className="dialog__title">
            {title}
          </h2>
          <button type="button" className="dialog__close" onClick={onClose} aria-label={closeLabel}>
            <span aria-hidden="true">&#215;</span>
          </button>
        </div>

        {description ? (
          <p id={descriptionId} className="dialog__description">
            {description}
          </p>
        ) : null}

        {children ? <div className="dialog__body">{children}</div> : null}
        {footer ? <div className="dialog__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
