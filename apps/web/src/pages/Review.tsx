/** Spec §10.2, §19. Placeholder — review lives in the browser because audio recognition
 *  needs programmatic seek-and-stop through the IFrame player, which a terminal cannot
 *  host (ADR 0007). */
export function Review() {
  return (
    <section className="panel">
      <h1>Review</h1>
      <p>Nothing to review yet.</p>
      <p className="hint">
        Cards, FSRS scheduling, and embedded source playback arrive in Stage 3.
      </p>
    </section>
  );
}
