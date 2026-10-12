'use strict';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { clinicalValues, formatWhen, safePlanMessage } from '../plans/planRules';

// The patient's own view of the CURRENT APPROVED plan. Drafts, clarification
// notes and the reviewer's working notes are not part of this projection on the
// server, so they can never appear here either.
export default function PatientPlan({ episodeId }) {
  const [plan, setPlan] = useState(null);
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api(`/patient/me/episodes/${episodeId}/plan`);
      setPlan(data.plan || null);
      setItems(data.items || []);
    } catch (err) {
      // A denial clears the loaded plan before the message is shown.
      setPlan(null);
      setItems([]);
      setError(safePlanMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [episodeId]);

  useEffect(() => {
    setLoaded(false);
    load();
  }, [load]);

  if (!loaded) return <p className="muted">Loading your care plan…</p>;
  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }

  if (!plan) {
    return (
      <p className="muted">
        Your care team has not published an approved plan for this episode yet. Drafts stay private
        until a clinical reviewer approves them.
      </p>
    );
  }

  return (
    <div className="plans plans--patient">
      <div className="plans__head">
        <h2>{plan.title || 'Approved care plan'}</h2>
        <span className="pill pill--ready">Approved v{plan.version}</span>
      </div>
      <dl className="summary">
        <dt>Approved by</dt>
        <dd>{plan.approvedByLabel || 'Clinical reviewer'}</dd>
        <dt>Approved at</dt>
        <dd>{formatWhen(plan.approvedAt)}</dd>
      </dl>
      {plan.summary && <p>{plan.summary}</p>}

      <div className="panel-scroll">
        <ul className="plans__list">
          {items.map((item) => (
            <li key={item.id} className="plans__item">
              <div className="plans__item-head">
                <strong>
                  {item.order}. {item.originalWording}
                </strong>
              </div>
              <dl className="summary">
                {clinicalValues(item).map(([key, label, value]) => (
                  <div key={key} className="plans__field">
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {item.sources && item.sources.length > 0 && (
                <details className="plans__sources">
                  <summary>Where this comes from</summary>
                  <ul className="plans__list">
                    {item.sources.map((source) => (
                      <li key={source.id}>
                        <span className="muted">
                          {source.documentFilename || 'Discharge document'}
                          {source.page ? ` · page ${source.page}` : ''}
                          {source.location ? ` · ${source.location}` : ''}
                        </span>
                        <blockquote className="plans__quote">{source.text}</blockquote>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
          {items.length === 0 && <li className="muted">This plan has no items yet.</li>}
        </ul>
      </div>
      <p className="muted">
        This is your current approved plan. If something looks unclear, contact your care team — do
        not change any medication on your own.
      </p>
    </div>
  );
}
