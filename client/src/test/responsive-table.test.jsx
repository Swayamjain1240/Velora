import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ResponsiveTable from '../components/ResponsiveTable';

function Sample({ extra = false }) {
  return (
    <ResponsiveTable className="custom">
      <caption>Care plan versions</caption>
      <thead>
        <tr>
          <th scope="col">Version</th>
          <th scope="col">State</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>v2</td>
          <td>Approved</td>
        </tr>
        {extra && (
          <tr>
            <td>v3</td>
            <td>Draft</td>
          </tr>
        )}
        <tr>
          <td colSpan={2}>No further versions.</td>
        </tr>
      </tbody>
    </ResponsiveTable>
  );
}

describe('ResponsiveTable', () => {
  it('keeps the table classes and any screen-specific class', () => {
    render(<Sample />);
    const table = screen.getByRole('table', { name: 'Care plan versions' });
    expect(table.className).toContain('table');
    expect(table.className).toContain('table--stack');
    expect(table.className).toContain('custom');
  });

  it('labels every cell with its column name so the stacked card keeps meaning', () => {
    render(<Sample />);
    const cells = screen.getAllByRole('cell');
    expect(cells[0]).toHaveAttribute('data-label', 'Version');
    expect(cells[1]).toHaveAttribute('data-label', 'State');
    // A full-width message row belongs to no single column.
    expect(cells[2]).not.toHaveAttribute('data-label');
  });

  it('keeps explicit table semantics for the stacked layout', () => {
    const { container } = render(<Sample />);
    expect(container.querySelector('table')).toHaveAttribute('role', 'table');
    expect(container.querySelector('thead')).toHaveAttribute('role', 'rowgroup');
    expect(screen.getByRole('columnheader', { name: 'Version' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('labels rows that appear after the first render (pagination, tabs, updates)', async () => {
    const { rerender } = render(<Sample />);
    rerender(<Sample extra />);
    await waitFor(() => {
      const cell = screen.getByText('v3');
      expect(cell).toHaveAttribute('data-label', 'Version');
    });
  });
});
