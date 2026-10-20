import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { onTabListKeyDown, tabStop } from '../lib/tabs';

const KEYS = ['one', 'two', 'three'];

// A minimal stand-in for the real screens: the same two attributes they use,
// the same roving tabindex rule, nothing else.
function Harness({ onChange = () => {} }) {
  const [active, setActive] = useState('one');
  const select = (next) => {
    setActive(next);
    onChange(next);
  };
  return (
    <div
      role="tablist"
      aria-label="Test sections"
      onKeyDown={(event) => onTabListKeyDown(event, KEYS, active, select)}
    >
      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={active === key}
          tabIndex={tabStop(key, active)}
          onClick={() => select(key)}
        >
          {key}
        </button>
      ))}
    </div>
  );
}

function tab(name) {
  return screen.getByRole('tab', { name });
}

describe('tab list keyboard contract', () => {
  it('exposes exactly one tab stop: the selected tab', () => {
    render(<Harness />);
    expect(tab('one')).toHaveAttribute('tabindex', '0');
    expect(tab('two')).toHaveAttribute('tabindex', '-1');
    expect(tab('three')).toHaveAttribute('tabindex', '-1');
  });

  it('moves with ArrowRight, wrapping at the end', async () => {
    const user = userEvent.setup();
    const seen = [];
    render(<Harness onChange={(next) => seen.push(next)} />);

    tab('one').focus();
    await user.keyboard('{ArrowRight}');
    expect(tab('two')).toHaveFocus();
    expect(tab('two')).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight}{ArrowRight}');
    // three -> wraps to one
    expect(seen).toEqual(['two', 'three', 'one']);
    expect(tab('one')).toHaveFocus();
  });

  it('moves with ArrowLeft, wrapping at the start', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    tab('one').focus();
    await user.keyboard('{ArrowLeft}');
    expect(tab('three')).toHaveFocus();
  });

  it('jumps to the first and last tab with Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    tab('one').focus();
    await user.keyboard('{End}');
    expect(tab('three')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tab('one')).toHaveFocus();
  });

  it('leaves other keys alone so Enter and Space keep their normal meaning', async () => {
    const user = userEvent.setup();
    const seen = [];
    render(<Harness onChange={(next) => seen.push(next)} />);
    tab('one').focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(seen).toEqual(['one']);
    expect(tab('one')).toHaveAttribute('aria-selected', 'true');
  });

  it('does not move when the active key is not in the visible list', async () => {
    const seen = [];
    render(<Harness onChange={(next) => seen.push(next)} />);
    tab('one').focus();
    // The visible list is the contract; a keyboard press cannot invent a tab.
    expect(() => onTabListKeyDown({ key: 'ArrowRight', preventDefault() {} }, [], 'gone', () => seen.push('x'))).not.toThrow();
    expect(seen).toEqual([]);
  });
});
