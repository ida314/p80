import { useParams } from 'react-router-dom';

/** Spec §10.4. Placeholder — the synchronized transcript and click-to-seek land in
 *  Stage 2. */
export function VideoDetail() {
  const { id } = useParams();
  return (
    <section className="panel">
      <h1>Video</h1>
      {/* Rendered as text. Route params are untrusted input like anything else. */}
      <p>{id}</p>
      <p className="hint">Player and synchronized transcript arrive in Stage 2.</p>
    </section>
  );
}
