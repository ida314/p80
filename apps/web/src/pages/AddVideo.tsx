import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SUPPORTED_MEDIA_EXTENSIONS } from '@p80/core/browser';
import { ApiError, createInterest, createVideo, listInterests } from '../api.js';
import { useResource } from '../hooks/useResource.js';

/**
 * Add a video (spec §12.1 steps 2–5), by pointing P80 at a file it can already reach.
 *
 * **The path is not validated here.** It is posted, and whatever the API says is rendered.
 * A client-side check would be a second containment implementation, and the two would
 * disagree the first time either changed — which for a path check means the client would
 * be quietly wrong about what is inside the media root. ADR 0007 puts that logic behind
 * `MediaSourceAdapter`; the client displays an answer.
 *
 * `targetLanguage` is absent, diverging from §12.1 step 5. ADR 0001 ships exactly one
 * language pair and it comes from the profile; a field offering a choice with one legal
 * answer is a promise the rest of P80 does not keep.
 *
 * Since ADR 0016 this leads to the video rather than to the transcript form: adding a
 * video enqueues transcription, so the next thing worth looking at is the job, not an
 * upload the user probably does not need to do.
 */
export function AddVideo() {
  const navigate = useNavigate();
  const interests = useResource(() => listInterests(), []);

  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newInterest, setNewInterest] = useState('');
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addInterest = async () => {
    const name = newInterest.trim();
    if (name === '') return;
    try {
      const created = await createInterest({ name });
      setNewInterest('');
      interests.reload();
      setSelected((current) => new Set(current).add(created.id));
    } catch (caught: unknown) {
      if (caught instanceof ApiError) setProblem(caught);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaving(true);
    try {
      const accepted = await createVideo({
        path: path.trim(),
        ...(title.trim() === '' ? {} : { title: title.trim() }),
        interests: [...selected].map((interestId) => ({ interestId, relevance: 1 })),
      });
      navigate(`/videos/${accepted.video.id}`);
    } catch (caught: unknown) {
      setProblem(
        caught instanceof ApiError
          ? caught
          : new ApiError({ code: 'UNEXPECTED', message: String(caught), retryable: false }, 0),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel">
      <h1>Add a video</h1>

      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>File path</span>
          <input
            type="text"
            value={path}
            autoFocus
            placeholder="german/lektion-3.mp4"
            onChange={(event) => setPath(event.target.value)}
          />
          <span className="hint">
            Relative to your media library folder. {SUPPORTED_MEDIA_EXTENSIONS.join(', ')}.
            P80 reads the file where it is and never copies it.
          </span>
        </label>

        <label className="field">
          <span>Title (optional)</span>
          <input
            type="text"
            value={title}
            placeholder="What you want to call it"
            onChange={(event) => setTitle(event.target.value)}
          />
          <span className="hint">Defaults to the file path.</span>
        </label>

        <fieldset className="field">
          <legend>Topics</legend>
          {interests.data === null || interests.data.length === 0 ? (
            <p className="hint">No topics yet. Add one below if you want to tag this video.</p>
          ) : (
            <div className="chips">
              {interests.data.map((interest) => (
                <label key={interest.id} className="chip">
                  <input
                    type="checkbox"
                    checked={selected.has(interest.id)}
                    onChange={() => toggle(interest.id)}
                  />
                  {interest.name}
                </label>
              ))}
            </div>
          )}
          <div className="field__inline">
            <input
              type="text"
              value={newInterest}
              placeholder="New topic"
              onChange={(event) => setNewInterest(event.target.value)}
              onKeyDown={(event) => {
                // A bare Enter here would submit the form and create the video, which is
                // not what someone typing a topic name meant.
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addInterest();
                }
              }}
            />
            <button type="button" onClick={() => void addInterest()}>
              Add topic
            </button>
          </div>
        </fieldset>

        {problem !== null && (
          <div role="alert" className="panel panel--error">
            <strong>{problem.code}</strong>
            {/* The API's message, which the envelope guarantees is safe to display. */}
            <p>{problem.message}</p>
          </div>
        )}

        <div className="editor__actions">
          <button type="submit" disabled={saving || path.trim() === ''}>
            {saving ? 'Adding…' : 'Add video'}
          </button>
          <button type="button" onClick={() => navigate('/videos')}>
            Cancel
          </button>
        </div>
      </form>

      <p className="hint">
        P80 transcribes the audio locally once the file is added — nothing is uploaded and
        no request leaves this machine. If transcription is unavailable you can supply a
        subtitle file instead, and a transcript you supply always wins over one P80
        produced.
      </p>
    </section>
  );
}
