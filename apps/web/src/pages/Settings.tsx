import { useEffect, useId, useState } from 'react';
import {
  ApiError,
  getSettings,
  preflightMediaRoot,
  updateSettings,
  type MediaRootPreflightPayload,
  type SettingViewPayload,
} from '../api.js';
import { useResource } from '../hooks/useResource.js';

/**
 * The settings surface (ADR 0019 §6).
 *
 * ADR 0007 put settings in the TUI, and 0019 amends that for one specific reason: the
 * media root decides whether the media surfaces work at all, and a browser client that
 * renders a library of unplayable videos while the control that repairs them lives in
 * another application is a worse split than the one 0007 was avoiding.
 *
 * **This page holds no knowledge of any individual setting.** It renders from `control`,
 * `editable`, and `description`; it validates nothing; it decides nothing about what a
 * media root is. Every refusal on screen is the API's, rendered from the envelope. That is
 * ADR 0007's rule, and here it is also what keeps this page and `p80 settings` from
 * disagreeing about anything.
 *
 * Values are rendered as text, never as markup. A media root is a string the user typed,
 * which makes this a render surface for untrusted input like any other (`CLAUDE.md` rule
 * 8) — React escapes it, and nothing here reaches for `dangerouslySetInnerHTML`.
 */
export function Settings() {
  const settings = useResource(() => getSettings(), []);
  // `null` is a draft too: it means "revert this key to the environment" (ADR 0026). It has
  // to be a draft rather than an immediate write so that reverting the media root can be
  // refused, counted, and confirmed on the same path as changing it.
  const [drafts, setDrafts] = useState<Record<string, string | number | boolean | null>>({});
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const rows = settings.data?.settings ?? [];
  const live = rows.filter((row) => row.tier === 'live');
  const boot = rows.filter((row) => row.tier === 'boot');

  const reverting = (row: SettingViewPayload) => drafts[row.key] === null;
  // `??` is wrong here: a null draft is a value, not an absence. Shown as the environment
  // value, because that is what saving would leave in place.
  const draftOf = (row: SettingViewPayload) =>
    !(row.key in drafts) ? row.value : (drafts[row.key] ?? row.environmentValue);
  const changed = (row: SettingViewPayload) =>
    row.key in drafts && drafts[row.key] !== row.value;
  const dirty = live.filter(changed);

  const edit = (key: string, value: string | number | boolean) => {
    setSaved(false);
    setDrafts((current) => ({ ...current, [key]: value }));
  };

  // Typing in the field afterwards cancels it, which is what the shared `drafts` map buys.
  const revert = (key: string) => {
    setSaved(false);
    setDrafts((current) => ({ ...current, [key]: null }));
  };

  const save = async (acknowledgeOrphans = false) => {
    setProblem(null);
    setSaving(true);
    try {
      const payload = Object.fromEntries(dirty.map((row) => [row.key, drafts[row.key]!]));
      await updateSettings(payload, acknowledgeOrphans);
      setDrafts({});
      setSaved(true);
      settings.reload();
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

  const mediaRootDraft = dirty.find((row) => row.key === 'P80_MEDIA_ROOT');

  return (
    <section className="panel">
      <h1>Settings</h1>

      {settings.error !== null && (
        <div role="alert" className="panel panel--error">
          <strong>{settings.error.code}</strong>
          <p>{settings.error.message}</p>
        </div>
      )}

      <h2>Editable</h2>
      <p className="hint">
        These take effect the next time they are used. No restart, and no process to
        remember to restart.
      </p>

      {live.map((row) => (
        <SettingField
          key={row.key}
          row={row}
          value={draftOf(row)}
          changed={changed(row)}
          reverting={reverting(row)}
          onChange={(value) => edit(row.key, value)}
          onRevert={() => revert(row.key)}
        />
      ))}

      {/* The preflight is a live read while the field is being typed, which is why it is
          its own component with its own debounce rather than part of the save path. */}
      {mediaRootDraft !== undefined && !reverting(mediaRootDraft) && (
        <MediaRootImpact path={String(drafts[mediaRootDraft.key])} />
      )}

      {problem !== null && (
        <div role="alert" className="panel panel--error">
          <strong>{problem.code}</strong>
          <p>{problem.message}</p>
          {/* Not a failure — a counted, reversible consequence waiting for a second
              confirmation. Offering the confirmation here is the whole point of refusing
              the first attempt. */}
          {problem.code === 'MEDIA_ROOT_WOULD_ORPHAN' && (
            <button type="button" disabled={saving} onClick={() => void save(true)}>
              Change it anyway
            </button>
          )}
        </div>
      )}

      <div className="editor__actions">
        <button type="button" disabled={saving || dirty.length === 0} onClick={() => void save()}>
          {saving ? 'Saving…' : `Save ${dirty.length || ''}`.trim()}
        </button>
        <button type="button" disabled={dirty.length === 0} onClick={() => setDrafts({})}>
          Discard
        </button>
        {saved && dirty.length === 0 && <span className="hint">Saved.</span>}
      </div>

      <h2>Set at startup</h2>
      <p className="hint">
        Read once when P80 starts, so changing them here would do nothing. Edit
        <code> .env.local</code> and restart.
      </p>

      <dl className="settings__readonly">
        {boot.map((row) => (
          <div key={row.key}>
            <dt>
              <code>{row.key}</code>
              {/* Eleven rows, each with a sentence saying why it takes a restart. Worth
                  having and not worth reading eleven times. */}
              <InfoTip id={`boot-${row.key}`} text={row.description} />
            </dt>
            <dd>
              <code>{String(row.value)}</code>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * A setting's description, on hover and on focus.
 *
 * Seven editable fields and eleven read-only ones, each with a paragraph explaining it,
 * buried the values under their own documentation — so the prose moved behind a marker and
 * the page became a list of settings again.
 *
 * **Hover is not the only trigger, and that is not a hedge.** A tooltip reachable only by
 * pointer is unreachable by keyboard and by touch, so the marker is a real focusable button
 * and the panel opens on `:focus-visible` too. `aria-describedby` binds the text to the
 * marker rather than to the input: the description is help *about* the setting, and reading
 * it out as part of every field's label would make the form worse to hear than to see.
 *
 * A `<button>` rather than a focusable `<span>` because it needs a role and keyboard
 * affordance anyway, and `type="button"` keeps it out of form submission. It has no click
 * handler on purpose — activating it does nothing that hovering or focusing has not already
 * done.
 */
function InfoTip({ id, text }: { id: string; text: string }) {
  return (
    <span className="tip">
      <button type="button" className="tip__mark" aria-label="What this does" aria-describedby={id}>
        ?
      </button>
      <span role="tooltip" id={id} className="tip__body">
        {text}
      </span>
    </span>
  );
}

function SettingField({
  row,
  value,
  changed,
  reverting,
  onChange,
  onRevert,
}: {
  row: SettingViewPayload;
  value: string | number | boolean;
  changed: boolean;
  reverting: boolean;
  onChange: (value: string | number | boolean) => void;
  onRevert: () => void;
}) {
  const id = useId();
  const tipId = `${id}-tip`;

  return (
    // A `div` with an explicit `htmlFor`, not a wrapping `label`. A label forwards clicks to
    // its control, so the help marker inside one would toggle the checkbox settings — which
    // is the difference between a tooltip and a setting the user did not mean to change.
    <div className="field">
      <span className="field__label">
        <label htmlFor={id}>
          <code>{row.key}</code>
        </label>
        <InfoTip id={tipId} text={row.description} />
        {/* A stored value that no longer matches .env.local is overridden, not ignored,
            and those two look identical without saying so. */}
        {row.source === 'database' && !changed && <em>· overridden here</em>}
        {changed && !reverting && <em>· unsaved</em>}
        {reverting && <em>· reverting to .env.local</em>}
      </span>

      {row.control === 'boolean' ? (
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
      ) : row.control === 'choice' ? (
        <select
          id={id}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {(row.choices ?? []).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : row.control === 'number' ? (
        <input
          id={id}
          type="number"
          step="0.05"
          min="0"
          max="1"
          value={String(value)}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      ) : (
        <input
          id={id}
          type="text"
          value={String(value)}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      {/* These two stay on the page. The description is reference material you read once;
          these are the current state of *this* setting — what reverting would give you, and
          the fact that a stored value could not be read at all. Hiding a live warning behind
          a hover is how it goes unnoticed. */}
      {row.source === 'database' && (
        <span className="hint">
          Your <code>.env.local</code> says <code>{String(row.environmentValue)}</code>.{' '}
          {/* Only where there is an override to drop. On a row already tracking the
              environment there is nothing to revert, and a disabled button would imply
              otherwise (ADR 0026 §3). Typing the environment value in by hand is a
              different act — it writes a row that then stops tracking the file. */}
          <button type="button" className="button-link" disabled={reverting} onClick={onRevert}>
            Revert to it
          </button>
        </span>
      )}
      {row.invalid !== undefined && (
        <span className="hint hint--warning">{row.invalid}</span>
      )}
    </div>
  );
}

/**
 * What the proposed media root would cost, shown while it is being typed.
 *
 * Debounced because every keystroke would otherwise `statSync` the whole library. 400 ms
 * is long enough that a typed path settles first and short enough that the answer arrives
 * before the user reaches the Save button.
 */
function MediaRootImpact({ path }: { path: string }) {
  const [result, setResult] = useState<MediaRootPreflightPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    const timer = setTimeout(() => {
      preflightMediaRoot(path)
        .then((r) => !cancelled && setResult(r))
        .catch(() => undefined);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path]);

  if (result === null) return <p className="hint">Checking that folder…</p>;

  if (!result.valid) {
    return (
      <div role="status" className="panel panel--error">
        <p>{result.message}</p>
      </div>
    );
  }

  if (result.orphaned === 0) {
    return (
      <p className="hint">
        {result.videoCount === 0
          ? 'That folder is readable. You have no videos yet, so nothing is affected.'
          : `That folder is readable, and all ${result.videoCount} of your videos still resolve under it.`}
      </p>
    );
  }

  return (
    <div role="status" className="panel panel--warning">
      <p>
        <strong>
          {result.orphaned} of {result.videoCount} videos would stop resolving.
        </strong>{' '}
        They stay in your library and keep their transcripts, corrections, and review
        history — only playback stops, and setting the root back restores it exactly.
      </p>
      <ul>
        {result.orphanedSample.map((video) => (
          <li key={video.id}>{video.title}</li>
        ))}
        {result.orphaned > result.orphanedSample.length && (
          <li>…and {result.orphaned - result.orphanedSample.length} more</li>
        )}
      </ul>
    </div>
  );
}
