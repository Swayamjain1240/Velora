import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Skeleton from '../components/Skeleton';
import MiniBars from '../components/MiniBars';

describe('Skeleton', () => {
  it('renders the requested number of placeholder lines and stays out of the a11y tree', () => {
    const { container } = render(<Skeleton lines={4} />);
    const root = container.querySelector('.skeleton');
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root.querySelectorAll('.skeleton__line')).toHaveLength(4);
  });
});

describe('MiniBars', () => {
  it('scales bars to the largest value and states each number', () => {
    const { container } = render(
      <MiniBars
        items={[
          { label: 'pending approvals', value: 4 },
          { label: 'open questions', value: 2 },
        ]}
        unit="open"
      />
    );
    const root = container.querySelector('.mini-bars');
    expect(root).toHaveAttribute('aria-hidden', 'true');
    const fills = [...container.querySelectorAll('.mini-bars__fill')];
    expect(fills).toHaveLength(2);
    expect(fills[0].style.width).toBe('100%');
    expect(fills[1].style.width).toBe('50%');
    expect(container.textContent).toContain('4 open');
    expect(container.textContent).toContain('2 open');
  });

  it('renders nothing rather than an empty chart frame', () => {
    const { container } = render(<MiniBars items={[]} />);
    expect(container.querySelector('.mini-bars')).toBeNull();
  });
});
