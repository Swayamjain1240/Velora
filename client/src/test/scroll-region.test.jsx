'use strict';

// L4: the scrollable region keyboard users can reach.
//
// These assert the two properties axe checks (a focusable element, an
// accessible name) plus the plumbing that lets a screen adopt it without
// changing its markup or losing extra attributes.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ScrollRegion from '../components/ScrollRegion';

describe('ScrollRegion', () => {
  it('is a named, focusable region so a scroll box is reachable by keyboard', () => {
    render(<ScrollRegion label="Active sessions">rows</ScrollRegion>);
    const region = screen.getByRole('region', { name: 'Active sessions' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveTextContent('rows');
  });

  it('keeps the panel-scroll class that gives it the scrollable bounds', () => {
    render(<ScrollRegion label="Audit events">rows</ScrollRegion>);
    expect(screen.getByRole('region')).toHaveClass('panel-scroll');
  });

  it('accepts extra classes and attributes without dropping them', () => {
    render(
      <ScrollRegion label="Metrics" className="panel-scroll--tight" data-testid="metrics">
        rows
      </ScrollRegion>
    );
    const region = screen.getByTestId('metrics');
    expect(region).toHaveClass('panel-scroll');
    expect(region).toHaveClass('panel-scroll--tight');
  });

  it('renders nothing focusable-breaking in its children', () => {
    // A region that already holds controls stays valid: the wrapper must not
    // swallow or reorder them.
    render(
      <ScrollRegion label="Queue items">
        <button type="button">Open</button>
      </ScrollRegion>
    );
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });
});
