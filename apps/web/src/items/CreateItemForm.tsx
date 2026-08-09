import { useState } from 'react';
import { LEARNING_ITEM_TYPES, REGISTERS, type LearningItemType } from '@p80/core/browser';
import { ApiError, createItem, type ItemPayload } from '../api.js';
import type { TranscriptSelection } from '../transcript/selection.js';

interface Props {
  videoId: string;
  selection: TranscriptSelection;
  onCreated: (item: ItemPayload) => void;
  onCancel: () => void;
}

/**
 * Spec §35 steps 2 and 3 — the form that turns a highlight into a learning item.
 *
 * Everything here is typed by a person, which is what makes `POST /api/items` compatible
 * with hard rule 6 rather than an exception to it (ADR 0020 §1).
 *
 * The two card checkboxes are `05-cards-and-review.md` §2's judgement calls made visible:
 * whether a source sentence is *useful* enough for a cloze, and whether a construction's
 * realization is clear enough for an audio card. Left alone they use the server's
 * heuristic; ticked or unticked they override it. They are checkboxes rather than a
 * setting because the answer is per-item.
 */
export function CreateItemForm({ videoId, selection, onCreated, onCancel }: Props) {
  const [canonicalForm, setCanonicalForm] = useState(selection.text);
  const [itemType, setItemType] = useState<LearningItemType>(
    // A multi-word highlight is much more often an expression than a word, and getting the
    // default right is worth more than the keystroke it saves — the type decides which
    // cards exist.
    selection.text.includes(' ') ? 'multiword_expression' : 'word',
  );
  const [meaning, setMeaning] = useState('');
  const [translation, setTranslation] = useState('');
  const [register, setRegister] = useState<string>('neutral');
  const [audioOverride, setAudioOverride] = useState<boolean | null>(null);
  const [clozeOverride, setClozeOverride] = useState<boolean | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const item = await createItem({
        videoId,
        selection: {
          segmentIds: selection.segmentIds,
          spanStart: selection.spanStart,
          spanEnd: selection.spanEnd,
        },
        canonicalForm,
        itemType,
        meaning,
        ...(translation.trim() ? { translation } : {}),
        register: register as (typeof REGISTERS)[number],
        ...(audioOverride === null ? {} : { includeAudioCard: audioOverride }),
        ...(clozeOverride === null ? {} : { includeClozeCard: clozeOverride }),
      });
      onCreated(item);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel item-form" onSubmit={submit}>
      <h2>New learning item</h2>

      <p className="item-form__source">
        {/* Escaped as a child. Transcript text is untrusted input (rule 8). */}
        <span className="item-form__context">{selection.contextText.slice(0, selection.spanStart)}</span>
        <mark>{selection.text}</mark>
        <span className="item-form__context">{selection.contextText.slice(selection.spanEnd)}</span>
      </p>

      {error && (
        <div role="alert" className="panel panel--error">
          <strong>{error.code}</strong>
          <p>{error.message}</p>
          {error.code === 'ITEM_SENSE_EXISTS' && (
            <p className="hint">
              Describing the meaning differently keeps the two senses apart. P80 does not
              guess that they are different, because two senses described the same way are
              more often one item entered twice.
            </p>
          )}
        </div>
      )}

      <label>
        Canonical form
        <input
          value={canonicalForm}
          onChange={(e) => setCanonicalForm(e.target.value)}
          required
          maxLength={200}
        />
        <span className="hint">
          The label, not a replacement — the form you highlighted is stored separately.
        </span>
      </label>

      <label>
        Type
        <select value={itemType} onChange={(e) => setItemType(e.target.value as LearningItemType)}>
          {LEARNING_ITEM_TYPES.map((type) => (
            <option key={type} value={type}>
              {type.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </label>

      <label>
        Meaning
        <textarea
          value={meaning}
          onChange={(e) => setMeaning(e.target.value)}
          required
          maxLength={1000}
          rows={2}
        />
        <span className="hint">
          Your own gloss. It is stored as user-authored and shown as unverified — the
          dictionary is the lexical authority, and it arrives in Stage 6.
        </span>
      </label>

      <label>
        Natural translation <span className="hint">optional</span>
        <input
          value={translation}
          onChange={(e) => setTranslation(e.target.value)}
          maxLength={1000}
        />
        <span className="hint">
          Leave it blank when no single phrase fits. A forced translation becomes a
          confident-looking wrong answer.
        </span>
      </label>

      <label>
        Register
        <select value={register} onChange={(e) => setRegister(e.target.value)}>
          {REGISTERS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="item-form__cards">
        <legend>Cards</legend>
        <p className="hint">
          Production is always generated. The other two default to what suits this item;
          override them here.
        </p>
        <CardToggle
          label="Audio recognition"
          value={audioOverride}
          onChange={setAudioOverride}
        />
        <CardToggle label="Contextual cloze" value={clozeOverride} onChange={setClozeOverride} />
      </fieldset>

      <div className="item-form__actions">
        <button type="submit" disabled={busy || meaning.trim().length === 0}>
          {busy ? 'Creating…' : 'Create item'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Three states, not two: on, off, and *let the server decide*. A plain checkbox would
 *  force the user to make a call the heuristic can usually make for them, and would make
 *  "I didn't think about it" indistinguishable from "no". */
function CardToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
}) {
  return (
    <div className="item-form__card-toggle">
      <span>{label}</span>
      <select
        value={value === null ? 'auto' : value ? 'yes' : 'no'}
        onChange={(e) =>
          onChange(e.target.value === 'auto' ? null : e.target.value === 'yes')
        }
      >
        <option value="auto">automatic</option>
        <option value="yes">include</option>
        <option value="no">skip</option>
      </select>
    </div>
  );
}
