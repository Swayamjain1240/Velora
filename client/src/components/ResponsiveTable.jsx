'use strict';

// L3: one table, two layouts.
//
// Above 720 px this is an ordinary semantic <table>. Below that it becomes a
// stack of cards, one per row, where every cell carries its column name so a
// value is never left without its meaning. The column names are read from the
// rendered <thead>, so screens keep their existing markup and no copy is
// duplicated (and no locale string is invented twice).
//
// Changing `display` on table elements makes some browsers drop the implicit
// table semantics, so explicit ARIA roles are written alongside the labels:
// screen readers keep the same table/row/cell structure in both layouts.
import { useEffect, useRef } from 'react';

export default function ResponsiveTable({ className = '', children, ...rest }) {
  const tableRef = useRef(null);

  useEffect(() => {
    const table = tableRef.current;
    if (!table) return undefined;

    // Roles are explicit so the stacked layout keeps its semantics.
    table.setAttribute('role', 'table');
    table.querySelectorAll('thead').forEach((el) => el.setAttribute('role', 'rowgroup'));
    table.querySelectorAll('tbody, tfoot').forEach((el) => el.setAttribute('role', 'rowgroup'));
    table.querySelectorAll('tr').forEach((el) => el.setAttribute('role', 'row'));
    table.querySelectorAll('thead th').forEach((el) => {
      if (!el.hasAttribute('role')) el.setAttribute('role', 'columnheader');
    });
    table.querySelectorAll('tbody td').forEach((el) => {
      if (!el.hasAttribute('role')) el.setAttribute('role', 'cell');
    });

    const labelCells = () => {
      const headers = [...table.querySelectorAll('thead th')].map((th) =>
        (th.textContent || '').trim()
      );
      table.querySelectorAll('tbody tr').forEach((row) => {
        [...row.children].forEach((cell, index) => {
          if (cell.tagName !== 'TD') return;
          // A full-width message row has no single column to name.
          if (cell.hasAttribute('colspan')) {
            cell.removeAttribute('data-label');
            return;
          }
          cell.setAttribute('data-label', headers[index] || '');
        });
      });
    };

    labelCells();
    // Rows repaint on pagination, tab switches and optimistic updates; the
    // observer keeps new cells labelled without a second render pass.
    const observer = new MutationObserver(labelCells);
    observer.observe(table, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <table ref={tableRef} className={`table table--stack ${className}`.trim()} {...rest}>
      {children}
    </table>
  );
}
