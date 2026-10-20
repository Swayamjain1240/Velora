'use strict';

import ResponsiveTable from '../../components/ResponsiveTable';
import Skeleton from '../../components/Skeleton';
import MiniBars from '../../components/MiniBars';
import ScrollRegion from '../../components/ScrollRegion';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { onTabListKeyDown, tabStop } from '../../lib/tabs';

// Operational metrics (Part 9). One switchable panel at a time so the screen
// stays inside one viewport, and every panel shows the definition's
// "not a measure of" line so a duration is never read as a clinical outcome.
const PANELS = [
  { key: 'approval_time', label: 'Approvals' },
  { key: 'clarification_response_time', label: 'Clarifications' },
  { key: 'queue_age', label: 'Queue age' },
  { key: 'coordination_workload', label: 'Workload' },
];

function duration(value) {
  if (!value || value.count === 0) return 'No data in this window.';
  return `${value.averageHours}h average (median ${value.medianHours}h, max ${value.maxHours}h) across ${value.count} item(s).`;
}

export default function MetricsPanel() {
  const [panel, setPanel] = useState('approval_time');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api('/metrics'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const metric = data && data.metrics.find((m) => m.key === panel);

  return (
    <section className="card card--tabs" aria-labelledby="metrics-title">
      <h1 id="metrics-title">Workflow metrics</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {data && <p className="muted">{data.note}</p>}

      <div
        className="tabs"
        role="tablist"
        aria-label="Metric panels"
        onKeyDown={(event) =>
          onTabListKeyDown(event, PANELS.map((entry) => entry.key), panel, setPanel)
        }
      >
        {PANELS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={panel === entry.key}
            tabIndex={tabStop(entry.key, panel)}
            className={panel === entry.key ? 'tab tab--active' : 'tab'}
            onClick={() => setPanel(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <ScrollRegion label="Metrics">
        {!metric && (
          <div>
            <span className="visually-hidden" role="status">
              Loading metrics…
            </span>
            <Skeleton lines={5} />
          </div>
        )}
        {metric && (
          <div>
            <h2>{metric.label}</h2>
            <p className="muted">{metric.definition}</p>
            <p className="muted">Not a measure of: {metric.notAMeasureOf}</p>

            {panel === 'queue_age' && (
              <>
              <MiniBars
                items={Object.entries(metric.value.queues).map(([key, value]) => ({
                  label: key.replace(/_/g, ' '),
                  value: value.openItems,
                }))}
                unit="open"
              />
              <ResponsiveTable>
                <caption className="visually-hidden">Queue age by queue</caption>
                <thead><tr><th scope="col">Queue</th><th scope="col">Open</th><th scope="col">Oldest (hours)</th></tr></thead>
                <tbody>
                  {Object.entries(metric.value.queues).map(([key, value]) => (
                    <tr key={key}>
                      <td>{key.replace(/_/g, ' ')}</td>
                      <td>{value.openItems}</td>
                      <td>{value.oldestHours ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </ResponsiveTable>
              </>
            )}

            {panel === 'coordination_workload' && (
              <>
              <MiniBars
                items={metric.value.members.map((member) => ({
                  label: member.label || member.member,
                  value: member.active,
                }))}
                unit="active"
              />
              <ResponsiveTable>
                <caption className="visually-hidden">Coordination workload</caption>
                <thead><tr><th scope="col">Member</th><th scope="col">Active</th><th scope="col">Released</th><th scope="col">Claimed in window</th></tr></thead>
                <tbody>
                  {metric.value.members.map((member) => (
                    <tr key={member.member}>
                      <td className="truncate">{member.label || member.member}</td>
                      <td>{member.active}</td>
                      <td>{member.released}</td>
                      <td>{member.claimedInWindow}</td>
                    </tr>
                  ))}
                  {metric.value.members.length === 0 && <tr><td colSpan={4}>No queue ownership in this window.</td></tr>}
                </tbody>
              </ResponsiveTable>
              </>
            )}

            {(panel === 'approval_time' || panel === 'clarification_response_time') && (
              <p>{duration(metric.value)}</p>
            )}

            {data.clinicianNote && <p className="muted">{data.clinicianNote}</p>}
          </div>
        )}
      </ScrollRegion>
    </section>
  );
}
