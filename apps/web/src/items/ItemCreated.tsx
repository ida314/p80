import { CARD_TYPES, type CardType } from '@p80/core/browser';
import type { ItemPayload } from '../api.js';

const CARD_LABELS: Readonly<Record<CardType, string>> = {
  audio_recognition: 'Audio recognition',
  contextual_cloze: 'Contextual cloze',
  productive_recall: 'Productive recall',
};

const CARD_OBJECTIVES: Readonly<Record<CardType, string>> = {
  // `05-cards-and-review.md` §3, one objective per card. Shown because §1 rule 1 —
  // one retrieval objective per card — is invisible otherwise, and a learner who does not
  // know what a card is asking cannot rate it honestly.
  audio_recognition: 'Recognise it in continuous speech, from the clip alone.',
  contextual_cloze: 'Retrieve the form from its context.',
  productive_recall: 'Produce it from a meaning or a situation.',
};

/**
 * Spec §35 step 8 — card preview.
 *
 * Shown immediately after creation rather than on a separate items page, because this is
 * the moment the answer matters: the user has just made a judgement call about which cards
 * to generate, and this is what it produced. Item *management* is the TUI's (ADR 0007).
 */
export function ItemCreated({ item, onDone }: { item: ItemPayload; onDone: () => void }) {
  const generated = CARD_TYPES.filter((type) => item.skills[type]?.cardId != null);
  const skipped = CARD_TYPES.filter((type) => item.skills[type]?.cardId == null);

  return (
    <div className="panel item-created" role="status">
      <h2>
        Added <strong>{item.canonicalForm}</strong>
      </h2>
      <p className="hint">
        {item.itemType.replace(/_/g, ' ')} · {item.meaning}
      </p>

      <p className="badge badge--unverified">
        {/* Hard rule 11. A user-authored gloss has no dictionary evidence, and saying so is
            not a criticism of the gloss — it is the difference between what P80 knows and
            what it was told. */}
        Meaning is user-authored, not dictionary-verified
      </p>

      <ul className="item-created__cards">
        {generated.map((type) => (
          <li key={type}>
            <strong>{CARD_LABELS[type]}</strong>
            <span className="hint">{CARD_OBJECTIVES[type]}</span>
          </li>
        ))}
      </ul>

      {skipped.length > 0 && (
        <p className="hint">
          Not generated: {skipped.map((type) => CARD_LABELS[type]).join(', ')}.
        </p>
      )}

      <p className="hint">
        All {generated.length} are due now. They will not be shown back to back — siblings
        are spaced out, and a new item's cards are usually introduced across different days.
      </p>

      <div className="editor__actions">
        <button type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
