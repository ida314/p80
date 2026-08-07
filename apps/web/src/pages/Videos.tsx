/** Spec §10.3. Placeholder — Stage 2 builds add-video, transcript upload, and the
 *  duplicate check. */
export function Videos() {
  return (
    <section className="panel">
      <h1>Videos</h1>
      <p>No videos yet.</p>
      <p className="hint">
        Adding a video and attaching a transcript is Stage 2. P80 never downloads video or
        audio — playback is through the YouTube IFrame player and transcripts are
        user-supplied.
      </p>
    </section>
  );
}
