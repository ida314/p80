import { useState } from 'react';

export interface TranscriptDraft {
  content: string;
  filename: string | null;
}

interface Props {
  value: TranscriptDraft;
  onChange: (draft: TranscriptDraft) => void;
  disabled?: boolean;
}

/** Matches the API's `bodyLimit` headroom. Refusing here saves a 4 MiB round trip that
 *  would only be rejected. */
const MAX_CHARS = 2_000_000;

/**
 * Where a transcript comes in — a file, or pasted text (spec §12.1 step 6).
 *
 * The file is read in the browser with `FileReader` and posted as JSON. That is a
 * deliberate choice rather than a convenience: with no multipart upload there is no upload
 * filename that could ever reach a path, because the storage path is generated entirely
 * from ids server-side. The filename that is sent is display-only, and sanitized again on
 * arrival.
 *
 * There is no "fetch captions" button and there will not be one. Media rule 2
 * is explicit: transcripts are user-supplied in MVP.
 */
export function TranscriptSource({ value, onChange, disabled }: Props) {
  const [readError, setReadError] = useState<string | null>(null);

  const readFile = (file: File) => {
    setReadError(null);
    if (file.size > MAX_CHARS) {
      setReadError(
        `That file is ${Math.round(file.size / 1_000_000)} MB. P80 reads transcripts up to about 2 MB — larger than any subtitle file for a single video.`,
      );
      return;
    }
    const reader = new FileReader();
    reader.onerror = () =>
      setReadError('Your browser could not read that file. Try pasting the text instead.');
    reader.onload = () =>
      onChange({ content: String(reader.result ?? ''), filename: file.name });
    // UTF-8 assumed. A file that is not UTF-8 comes through with replacement characters,
    // and the parser records an `encoding_fallback` warning rather than failing.
    reader.readAsText(file, 'utf-8');
  };

  return (
    <div className="source">
      <label className="source__file">
        <span>Transcript file</span>
        <input
          type="file"
          accept=".vtt,.srt,.txt,text/vtt,text/plain,application/x-subrip"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) readFile(file);
          }}
        />
        <span className="hint">WebVTT, SubRip, or plain text with a timestamp per line.</span>
      </label>

      <label className="source__paste">
        <span>…or paste it</span>
        <textarea
          rows={10}
          value={value.content}
          disabled={disabled}
          placeholder={'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nGuten Tag, wie geht es Ihnen?'}
          onChange={(event) => onChange({ content: event.target.value, filename: value.filename })}
        />
      </label>

      {value.filename !== null && value.content.length > 0 && (
        // Display only. Never an `href`, a `download`, or a `Content-Disposition` — the
        // uploaded file has no download endpoint at all.
        <p className="hint">
          Loaded {value.filename} — {value.content.length.toLocaleString()} characters.
        </p>
      )}

      {readError !== null && (
        <p role="alert" className="editor__problem">
          {readError}
        </p>
      )}

      <p className="hint">
        P80 never fetches a transcript from anywhere. It transcribes the audio locally; if
        that is unavailable, or you already have a better transcript, supply one here. A
        transcript you supply always wins over one P80 produced.
      </p>
    </div>
  );
}
