interface Props {
  /** How many corrections are about to be discarded. Counted, not estimated — the API
   *  returns real numbers from `DELETE`, and this is the same figure read from the
   *  transcript before the fact. */
  correctionCount: number;
  segmentCount: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Names the cost before it is paid.
 *
 * Replacing a transcript re-parses the file and rewrites every segment, which means every
 * correction attached to the old segments is gone. The uploaded file itself stays on disk,
 * so the *source* is recoverable and the corrections are not — which is why the corrections
 * are the number in bold and the file is the reassurance underneath.
 *
 * This is also `CLAUDE.md` rule 6's shape applied to destructive work: an explicit user
 * action, with the consequence stated in advance rather than in a toast afterwards.
 */
export function ConfirmReplace({
  correctionCount,
  segmentCount,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div role="alertdialog" aria-label="Replace this transcript?" className="panel panel--error">
      <h2>Replace this transcript?</h2>
      <p>
        This video already has a transcript of {segmentCount.toLocaleString()} lines.
        Replacing it discards{' '}
        <strong>
          {correctionCount === 0
            ? 'no corrections'
            : `${correctionCount.toLocaleString()} correction${correctionCount === 1 ? '' : 's'}`}
        </strong>
        {correctionCount === 0 ? '.' : ' — corrections cannot be recovered.'}
      </p>
      <p className="hint">
        The transcript file you uploaded before stays on disk either way, so the source
        itself is not lost.
      </p>
      <div className="editor__actions">
        <button type="button" onClick={onConfirm} disabled={busy}>
          {busy ? 'Replacing…' : 'Replace and re-parse'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Keep what I have
        </button>
      </div>
    </div>
  );
}
