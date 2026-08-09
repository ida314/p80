import { useState } from 'react';
import { formatTimecodePrecise, validateSegmentEdit } from '@p80/core/browser';
import type { SegmentPayload } from '../api.js';

interface Props {
  segment: SegmentPayload;
  onCancel: () => void;
  onSave: (patch: { text?: string; startMs?: number; endMs?: number }) => Promise<void>;
}

/**
 * Corrects one segment (spec §35 step 12, exit criterion 4).
 *
 * A correction is an **append-only row**, never an edit: `transcript_segments` is
 * immutable after ingestion and the API refuses to change it. That is not a technicality —
 * it is what lets the original stay visible beside the correction, and what stops a later
 * fix from orphaning anything built on the segment.
 *
 * Coherence is checked by `validateSegmentEdit` from `packages/core`, the same function the
 * API calls. Duplicating the rules here would mean two answers to "is this edit valid",
 * and the client's would be the one nobody tested.
 */
export function SegmentEditor({ segment, onCancel, onSave }: Props) {
  const [text, setText] = useState(segment.text);
  const [startMs, setStartMs] = useState(String(segment.startMs));
  const [endMs, setEndMs] = useState(String(segment.endMs));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(null);

    const patch: { text?: string; startMs?: number; endMs?: number } = {};
    if (text !== segment.text) patch.text = text;
    if (Number(startMs) !== segment.startMs) patch.startMs = Number(startMs);
    if (Number(endMs) !== segment.endMs) patch.endMs = Number(endMs);

    const check = validateSegmentEdit(
      { startMs: segment.startMs, endMs: segment.endMs, text: segment.text },
      patch,
    );
    if (!check.ok) {
      setProblem(check.reason);
      return;
    }

    setSaving(true);
    try {
      await onSave(patch);
    } catch (caught: unknown) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="editor" onSubmit={(event) => void submit(event)}>
      <label>
        <span>Corrected text</span>
        {/* A controlled `textarea` — the transcript text goes in as a value, never as
            markup. React escapes it, and `test/web-safety.test.ts` asserts that no
            component in this app has a way around that. */}
        <textarea
          value={text}
          rows={3}
          onChange={(event) => setText(event.target.value)}
        />
      </label>

      <div className="editor__times">
        <label>
          <span>Start (ms)</span>
          <input
            type="number"
            min={0}
            value={startMs}
            onChange={(event) => setStartMs(event.target.value)}
          />
          <span className="hint">{formatTimecodePrecise(Number(startMs) || 0)}</span>
        </label>
        <label>
          <span>End (ms)</span>
          <input
            type="number"
            min={0}
            value={endMs}
            onChange={(event) => setEndMs(event.target.value)}
          />
          <span className="hint">{formatTimecodePrecise(Number(endMs) || 0)}</span>
        </label>
      </div>

      {problem !== null && (
        <p role="alert" className="editor__problem">
          {problem}
        </p>
      )}

      <div className="editor__actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save correction'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>

      <p className="hint">
        The original line is kept. Corrections are recorded separately, so you can always
        see what the transcript said before you changed it.
      </p>
    </form>
  );
}
