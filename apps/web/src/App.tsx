import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { ApiError, getHealth, type Health } from './api.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { Today } from './pages/Today.js';
import { Library } from './pages/Library.js';
import { Videos } from './pages/Videos.js';
import { AddVideo } from './pages/AddVideo.js';
import { VideoDetail } from './pages/VideoDetail.js';
import { VideoTranscript } from './pages/VideoTranscript.js';
import { Review } from './pages/Review.js';
import { Settings } from './pages/Settings.js';

/**
 * **Media surfaces, plus settings** (ADR 0007, amended by ADR 0019 §6).
 *
 * RESOLVED — divergence from spec §35's "Initial pages" list, which names Today, Videos,
 * Candidates, Items, Settings, and Diagnostics as web pages. That list predates ADR 0007,
 * which assigns the last four to the TUI: they are the highest-volume, keyboard-driven,
 * pure-text surfaces, and building them in React now would create pages to be deleted.
 *
 * Settings is the one that came back, and only because the media root decides whether
 * everything else here works: a library of unplayable videos with the repair control in
 * another application is a worse split than the one ADR 0007 was avoiding. Candidates,
 * Items, and Diagnostics stay in the TUI on the original reasoning.
 */
const NAV = [
  { to: '/', label: 'Today', end: true },
  { to: '/videos', label: 'Videos' },
  { to: '/library', label: 'Library' },
  { to: '/review', label: 'Review' },
  { to: '/settings', label: 'Settings' },
];

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((h) => !cancelled && setHealth(h))
      .catch((e: unknown) => !cancelled && setError(e as ApiError));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__brand">P80</span>
        <nav>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <span className="app__status">
          {error ? 'api unreachable' : health ? `api ${health.status}` : 'checking…'}
        </span>
      </header>

      {/* Global error display (Stage 1 step 13). Shows the envelope's message, which the
          API guarantees is safe to display, and never a raw exception. */}
      {error && (
        <div role="alert" className="panel panel--error">
          <strong>{error.code}</strong>
          <p>{error.message}</p>
        </div>
      )}

      <main>
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Today />} />
            <Route path="/videos" element={<Videos />} />
            {/* Real routes, not modals: linkable, back-button-correct, and each one is
                scoped by the `ErrorBoundary` above. `/videos/new` has to precede
                `/videos/:id` conceptually but not textually — the router prefers the
                static segment either way. */}
            <Route path="/library" element={<Library />} />
            <Route path="/videos/new" element={<AddVideo />} />
            <Route path="/videos/:id" element={<VideoDetail />} />
            <Route path="/videos/:id/transcript" element={<VideoTranscript />} />
            <Route path="/review" element={<Review />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </ErrorBoundary>
      </main>

      <footer className="app__footer">
        Management surfaces — candidates, items, diagnostics — live in the TUI. Run{' '}
        <code>pnpm --filter @p80/tui dev</code>.
      </footer>
    </div>
  );
}
