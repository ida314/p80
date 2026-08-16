import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatTimecode } from '@p80/core/browser';
import { listVideos, type VideoPayload } from '../api.js';
import { useResource } from '../hooks/useResource.js';

const STATUS_COPY: Record<string, string> = {
  none: 'no transcript',
  parsing: 'reading transcript…',
  ready: 'ready',
  failed: 'transcript failed',
};

/** Spec §10.3 — the video library. */
export function Videos() {
  const [query, setQuery] = useState('');
  const videos = useResource(() => listVideos(query.trim() === '' ? {} : { q: query.trim() }), [query]);

  return (
    <section className="panel">
      <div className="videos__head">
        <h1>Videos</h1>
        <span className="library__actions">
          <Link className="button-link" to="/library">
            Library
          </Link>
          <Link className="button-link" to="/videos/new">
            Add a video
          </Link>
        </span>
      </div>

      <input
        type="search"
        className="videos__search"
        value={query}
        placeholder="Search titles"
        onChange={(event) => setQuery(event.target.value)}
      />

      {videos.error !== null && (
        <div role="alert" className="panel panel--error">
          <strong>{videos.error.code}</strong>
          <p>{videos.error.message}</p>
        </div>
      )}

      {videos.data !== null && videos.data.videos.length === 0 && (
        <p className="hint">
          {query.trim() === ''
            ? 'No videos yet. Add one, then attach a transcript you already have.'
            : 'Nothing matches that.'}
        </p>
      )}

      <ul className="videos__list">
        {(videos.data?.videos ?? []).map((video) => (
          <li key={video.id}>
            <Link to={`/videos/${video.id}`}>{video.title ?? video.url}</Link>
            <span className="hint">{describe(video)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function describe(video: VideoPayload): string {
  const parts = [STATUS_COPY[video.transcriptStatus] ?? video.transcriptStatus];
  if (video.transcriptStatus === 'ready') {
    parts.push(`${video.segmentCount.toLocaleString()} lines`);
  }
  if (video.durationMs !== null) parts.push(formatTimecode(video.durationMs));
  if (video.interests.length > 0) {
    parts.push(video.interests.map((interest) => interest.name).join(', '));
  }
  return parts.join(' · ');
}
