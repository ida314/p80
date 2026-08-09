import { Link } from 'react-router-dom';
import { getDueSummary, getForecast, getProfile } from '../api.js';
import { useResource } from '../hooks/useResource.js';

/**
 * Spec §10.1, and §35 steps 15 and 16 — the due-card dashboard and the new-item limit.
 *
 * Every number here is computed by the API. The client does not add up card times, does
 * not decide what "overdue" means, and does not work out how much of today's allowance is
 * left — all three are §8 and §7 questions, and answering them here would put scheduling
 * policy in a browser (ADR 0007).
 */
export function Today() {
  const profile = useResource(() => getProfile(), []);
  const due = useResource(() => getDueSummary(), []);
  const forecast = useResource(() => getForecast(), []);

  const summary = due.data;
  const burden = forecast.data;

  return (
    <section className="panel">
      <h1>Today</h1>

      {profile.data && (
        <p className="hint">
          {profile.data.targetLanguage} → {profile.data.nativeLanguage} ·{' '}
          {profile.data.dailyMinutes} minutes a day
        </p>
      )}

      {summary === null ? (
        <p className="hint">Loading…</p>
      ) : (
        <>
          <div className="today__counts">
            <Count label="Due now" value={summary.dueNow} />
            <Count label="Overdue" value={summary.overdue} />
            <Count label="New items waiting" value={summary.newItemsAvailable} />
          </div>

          <p>
            About {Math.round(summary.estimatedMinutes)} minute
            {Math.round(summary.estimatedMinutes) === 1 ? '' : 's'} of reviews.
          </p>

          <p className="hint">
            {/* §7 counts items, not cards, and saying which is what stops the number
                looking wrong when one item produces three cards. */}
            {summary.newItemsIntroducedToday} new item
            {summary.newItemsIntroducedToday === 1 ? '' : 's'} introduced today ·{' '}
            {summary.newItemAllowance} left in today's allowance. An item counts once
            however many cards it produces.
          </p>

          {summary.dueNow === 0 && summary.newItemsAvailable === 0 ? (
            <p>
              Nothing to review. <Link to="/videos">Add a video</Link> and highlight
              something in its transcript.
            </p>
          ) : (
            <Link className="today__start" to="/review">
              Start reviewing
            </Link>
          )}
        </>
      )}

      {burden !== null && burden.totalMinutes > 0 && (
        <section className="today__forecast">
          <h2>Next seven days</h2>
          <p className="hint">
            {/* §8's `review_burden`. Displayed here, and used by the session builder to
                stop introducing new items when it exceeds the session budget. */}
            About {Math.round(burden.totalMinutes)} minutes of reviews, of which{' '}
            {Math.round(burden.overdueMinutes)} are already overdue.
          </p>
          <ol className="forecast">
            {burden.days.map((day) => (
              <li key={day.date}>
                <span className="forecast__date">{day.date.slice(5)}</span>
                <span
                  className="forecast__bar"
                  style={{ width: `${Math.min(100, day.minutes * 4)}%` }}
                  aria-hidden="true"
                />
                <span className="forecast__count">
                  {day.cards} card{day.cards === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="today__count">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
