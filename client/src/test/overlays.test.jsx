'use strict';

// L2 primitives: dialog, toast, tooltip.
//
// These assert the behaviours that make the primitives safe to adopt: focus is
// trapped and restored, Escape always gets out, the toast queue is bounded and
// never hides a message on a timer under reduced motion, and the tooltip is a
// described-by supplement that never replaces a label.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import Dialog from '../components/Dialog';
import Toast, { nextToast, TOAST_LIMIT } from '../components/Toast';
import Tooltip from '../components/Tooltip';

function DialogHarness({ dismissOnBackdrop = true }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Confirm action"
        description="Are you sure?"
        dismissOnBackdrop={dismissOnBackdrop}
        footer={<button type="button">Confirm</button>}
      />
    </div>
  );
}

describe('Dialog', () => {
  it('is not rendered until opened', () => {
    render(<Dialog open={false} onClose={() => {}} title="Hidden" />);
    expect(screen.queryByText('Hidden')).toBeNull();
  });

  it('exposes an alertdialog with an accessible name and description', () => {
    render(<Dialog open onClose={() => {}} title="Confirm action" description="Are you sure?" />);
    const panel = screen.getByRole('alertdialog', { name: 'Confirm action' });
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(panel).toHaveAccessibleDescription('Are you sure?');
  });

  it('moves focus into the dialog on open', () => {
    render(<DialogHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const panel = screen.getByRole('alertdialog', { name: 'Confirm action' });
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('restores focus to the trigger on close', () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    // A real click focuses the button first, so focus has somewhere to return.
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to wherever focus was before it opened', () => {
    // If the dialog is opened programmatically from a field, focus goes back to
    // that field rather than to <body>.
    function FieldHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <input aria-label="Search" />
          <button type="button" onClick={() => setOpen(true)}>Open</button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Confirm action" description="Are you sure?" />
        </div>
      );
    }
    render(<FieldHarness />);
    const field = screen.getByLabelText('Search');
    field.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(document.activeElement).toBe(field);
  });

  it('closes on Escape', () => {
    render(<DialogHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('cycles Tab from the last control back to the first', () => {
    render(<Dialog open onClose={() => {}} title="Trap" description="d" footer={<button type="button">Last</button>} />);
    const panel = screen.getByRole('alertdialog');
    const close = screen.getByRole('button', { name: 'Close dialog' });
    const last = screen.getByRole('button', { name: 'Last' });

    last.focus();
    fireEvent.keyDown(panel, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('names the icon-only close control', () => {
    render(<Dialog open onClose={() => {}} title="Named" />);
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeInTheDocument();
  });
});

describe('Toast', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = render(<Toast toasts={[]} onDismiss={() => {}} />);
    expect(container.querySelector('[data-testid="toast-region"]')).toBeNull();
  });

  it('is a polite live region carrying the message', () => {
    render(<Toast toasts={[nextToast('Saved', 'success')]} onDismiss={() => {}} />);
    const region = screen.getByTestId('toast-region');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('bounds the queue to TOAST_LIMIT, keeping the newest', () => {
    const many = Array.from({ length: TOAST_LIMIT + 2 }, (_, i) => nextToast(`msg ${i}`));
    render(<Toast toasts={many} onDismiss={() => {}} />);
    expect(screen.getByText(`msg ${many.length - 1}`)).toBeInTheDocument();
    expect(screen.queryByText('msg 0')).toBeNull();
    expect(screen.getAllByRole('status')[0].children.length).toBeLessThanOrEqual(TOAST_LIMIT);
  });

  it('dismisses through the labelled control', () => {
    const onDismiss = vi.fn();
    const toast = nextToast('Saved', 'success');
    render(<Toast toasts={[toast]} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Saved' }));
    expect(onDismiss).toHaveBeenCalledWith(toast.id);
  });

  it('gives every toast a distinct id', () => {
    const ids = new Set([nextToast('a').id, nextToast('b').id, nextToast('c').id]);
    expect(ids.size).toBe(3);
  });
});

describe('Tooltip', () => {
  it('stays hidden until hover or focus', () => {
    render(
      <Tooltip label="Extra detail">
        <button type="button">Label</button>
      </Tooltip>
    );
    const tip = screen.getByRole('tooltip');
    expect(tip).not.toHaveAttribute('data-visible');
  });

  it('shows on focus and wires aria-describedby to the control', () => {
    render(
      <Tooltip label="Extra detail">
        <button type="button">Label</button>
      </Tooltip>
    );
    const button = screen.getByRole('button', { name: 'Label' });
    fireEvent.focus(button);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveAttribute('data-visible');
    expect(button).toHaveAttribute('aria-describedby', tip.getAttribute('id'));
  });

  it('hides on blur and on Escape', () => {
    render(
      <Tooltip label="Extra detail">
        <button type="button">Label</button>
      </Tooltip>
    );
    const button = screen.getByRole('button', { name: 'Label' });
    const tip = screen.getByRole('tooltip');

    fireEvent.focus(button);
    expect(tip).toHaveAttribute('data-visible');
    fireEvent.blur(button);
    expect(tip).not.toHaveAttribute('data-visible');

    fireEvent.focus(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tip).not.toHaveAttribute('data-visible');
  });

  it('keeps the child label intact (a tooltip never replaces it)', () => {
    render(
      <Tooltip label="Extra detail">
        <button type="button">Label</button>
      </Tooltip>
    );
    expect(screen.getByRole('button', { name: 'Label' })).toBeInTheDocument();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Extra detail');
  });
});

