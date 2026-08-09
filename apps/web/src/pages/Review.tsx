import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { SCHEDULER_RATINGS, type SchedulerRating } from '@p80/core/browser';
import {
  ApiError,
  answerCard,
  completeSession,
  getDueSummary,
  getNextCard,
  hintCard,
  rateCard,
  startSession,
  type ReviewCardPayload,
  type ReviewRevealPayload,
  type SessionPayload,
} from '../api.js';
import { ClipPlayer, type ClipPlayerHandle } from '../review/ClipPlayer.js';

/**
 * The review session (spec §10.2, §19, §35 steps 9–11).
 *
 * Review is a browser surface because audio recognition needs programmatic
 * seek-and-stop against a video, which a terminal cannot host (ADR 0007). Everything that
 * is not playback comes from the API: which card is next, what its front says, what the
 * back says, and what a rating did to the schedule. This component holds no scheduling
 * logic — a `curl` script can complete the same session.
 *
 * **The back face arrives from the server, on `answer`.** Not because it is secret, but
 * because a rep happens before the answer is revealed (§9.9): if the client already held
 * the answer, a reveal would stop being an event the server can distinguish from a
 * retrieval, and the latency in `reviews` would measure nothing.
 */

/** §33, and `05-cards-and-review.md` §11. Keyboard-only review is a requirement, not an
 *  enhancement — every action here has a key and none of them needs a pointing device. */
const SHORTCUTS: ReadonlyArray<[string, string]> = [
  ['Space', 'play / pause'],
  ['R', 'replay clip'],
  ['Enter', 'reveal answer'],
  ['1 – 4', 'Again / Hard / Good / Easy'],
  ['H', 'hint'],
  ['C', 'expand context'],
];

const RATING_LABELS: Readonly<Record<SchedulerRating, string>> = {
  again: 'Again',
  hard: 'Hard',
  good: 'Good',
  easy: 'Easy',
};

/** §18.5, so the learner rates against the same definitions the scheduler assumes. */
const RATING_HINTS: Readonly<Record<SchedulerRating, string>> = {
  again: 'Not recognised, or the meaning had changed.',
  hard: 'Right, but after a hint or real hesitation.',
  good: 'Right, unaided, with normal hesitation.',
  easy: 'Immediate, confident, natural.',
};

type Phase = 'idle' | 'front' | 'revealed' | 'done';

export function Review() {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [card, setCard] = useState<ReviewCardPayload | null>(null);
  const [reveal, setReveal] = useState<ReviewRevealPayload | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [response, setResponse] = useState('');
  const [hints, setHints] = useState(0);
  const [contextOpen, setContextOpen] = useState(false);
  const [showImage, setShowImage] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [due, setDue] = useState<{ dueNow: number; newItemsAvailable: number } | null>(null);

  const clip = useRef<ClipPlayerHandle | null>(null);
  const shownAt = useRef<number>(0);
  const onClipHandle = useCallback((handle: ClipPlayerHandle | null) => {
    clip.current = handle;
  }, []);

  useEffect(() => {
    getDueSummary()
      .then((summary) =>
        setDue({ dueNow: summary.dueNow, newItemsAvailable: summary.newItemsAvailable }),
      )
      .catch(() => setDue(null));
  }, [phase]);

  const advance = useCallback(async (sessionId: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await getNextCard(sessionId);
      if ('done' in next) {
        await completeSession(sessionId);
        setCard(null);
        setPhase('done');
        return;
      }
      setCard(next);
      setReveal(null);
      setResponse('');
      setHints(0);
      setContextOpen(false);
      setPhase('front');
      shownAt.current = Date.now();
    } catch (caught) {
      setError(caught as ApiError);
    } finally {
      setBusy(false);
    }
  }, []);

  const begin = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await startSession({ desiredMinutes: 20, includeNewItems: true });
      setSession(created);
      await advance(created.id);
    } catch (caught) {
      setError(caught as ApiError);
      setBusy(false);
    }
  }, [advance]);

  const doReveal = useCallback(async () => {
    if (session === null || card === null || phase !== 'front' || busy) return;
    setBusy(true);
    try {
      const revealed = await answerCard(session.id, {
        reviewId: card.reviewId,
        ...(response.trim() ? { responseText: response } : {}),
        // Measured from render to submit. §23.1 wants it honest, which is why the client
        // measures it rather than the server inferring it from two request timestamps.
        responseLatencyMs: Date.now() - shownAt.current,
        sourceContextUsed: contextOpen,
      });
      setReveal(revealed);
      setPhase('revealed');
    } catch (caught) {
      setError(caught as ApiError);
    } finally {
      setBusy(false);
    }
  }, [session, card, phase, busy, response, contextOpen]);

  const doRate = useCallback(
    async (rating: SchedulerRating) => {
      if (session === null || card === null || phase !== 'revealed' || busy) return;
      setBusy(true);
      try {
        const result = await rateCard(session.id, { reviewId: card.reviewId, rating });
        const days = result.intervalDays;
        setLastResult(
          days < 1
            ? `${RATING_LABELS[rating]} — back in ${Math.max(1, Math.round(days * 24 * 60))} min`
            : `${RATING_LABELS[rating]} — back in ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`,
        );
        await advance(session.id);
      } catch (caught) {
        setError(caught as ApiError);
        setBusy(false);
      }
    },
    [session, card, phase, busy, advance],
  );

  const doHint = useCallback(async () => {
    if (session === null || card === null || phase !== 'front') return;
    const result = await hintCard(session.id, card.reviewId).catch(() => null);
    if (result) setHints(result.hintCount);
  }, [session, card, phase]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // A learner typing an answer is not issuing shortcuts. `Enter` still reveals, because
      // submitting from the field is the natural gesture; everything else is a character.
      const inField =
        event.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA'].includes(event.target.tagName);

      if (event.key === 'Enter' && phase === 'front') {
        event.preventDefault();
        void doReveal();
        return;
      }
      if (inField) return;

      if (event.key === ' ') {
        event.preventDefault();
        clip.current?.toggle();
      } else if (event.key.toLowerCase() === 'r') {
        clip.current?.replay();
      } else if (event.key.toLowerCase() === 'h' && phase === 'front') {
        void doHint();
      } else if (event.key.toLowerCase() === 'c') {
        setContextOpen((open) => !open);
      } else if (['1', '2', '3', '4'].includes(event.key) && phase === 'revealed') {
        void doRate(SCHEDULER_RATINGS[Number(event.key) - 1] as SchedulerRating);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, doReveal, doRate, doHint]);

  if (phase === 'idle' || session === null) {
    return (
      <section className="panel">
        <h1>Review</h1>
        {due !== null ? (
          <p>
            {due.dueNow} card{due.dueNow === 1 ? '' : 's'} due
            {due.newItemsAvailable > 0 && `, ${due.newItemsAvailable} new item${due.newItemsAvailable === 1 ? '' : 's'} waiting`}
            .
          </p>
        ) : (
          <p className="hint">Checking what is due…</p>
        )}
        {error && (
          <div role="alert" className="panel panel--error">
            <strong>{error.code}</strong>
            <p>{error.message}</p>
          </div>
        )}
        <button type="button" onClick={() => void begin()} disabled={busy}>
          {busy ? 'Starting…' : 'Start a session'}
        </button>
        <p className="hint">
          Nothing to review? Open a video, highlight a phrase in its transcript, and turn it
          into an item.
        </p>
        <Shortcuts />
      </section>
    );
  }

  if (phase === 'done' || card === null) {
    const plan = session.plan;
    return (
      <section className="panel">
        <h1>Session finished</h1>
        <p>
          {plan.cards.length} card{plan.cards.length === 1 ? '' : 's'} planned.
        </p>
        {plan.deferredSiblings > 0 && (
          // §6 rule 2 at work, not a shortfall. Without this line "1 card" reads as a bug.
          <p className="hint">
            {plan.deferredSiblings} more card{plan.deferredSiblings === 1 ? '' : 's'} from
            the same items are held for another day — siblings are introduced apart, not
            together.
          </p>
        )}
        {plan.newItemsSuppressedByBurden && (
          <p className="hint">
            New items were held back: the next seven days of reviews already exceed your
            session budget.
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setSession(null);
            setPhase('idle');
            setLastResult(null);
          }}
        >
          Back
        </button>
        <Link to="/videos">Add more items</Link>
      </section>
    );
  }

  const clipUsable = card.clip !== null && !card.clip.mediaMissing;
  const clipOfferedNow =
    clipUsable && (card.clipAvailableBeforeAnswer || phase === 'revealed');

  return (
    <section className="panel review">
      <header className="review__head">
        <span className="hint">
          {card.position + 1} of {card.total}
        </span>
        <span className="badge">{card.cardType.replace(/_/g, ' ')}</span>
        {lastResult !== null && <span className="hint">{lastResult}</span>}
      </header>

      {error && (
        <div role="alert" className="panel panel--error">
          <strong>{error.code}</strong>
          <p>{error.message}</p>
        </div>
      )}

      {clipOfferedNow && card.clip !== null && (
        <>
          <ClipPlayer
            src={card.clip.mediaUrl}
            startMs={card.clip.startMs}
            endMs={card.clip.endMs}
            showImage={showImage}
            disabled={false}
            onHandle={onClipHandle}
          />
          <label className="review__toggle">
            <input
              type="checkbox"
              checked={showImage}
              onChange={(e) => setShowImage(e.target.checked)}
            />
            Show the picture
          </label>
          {card.clip.timingPrecision === 'cue' && (
            // ADR 0017. Surfaced rather than absorbed: a clip covering the whole line when
            // one word was asked for is a worse answer, not a rounder one.
            <p className="hint">
              This transcript has line-level timing, so the clip covers the whole line.
            </p>
          )}
        </>
      )}

      {clipUsable && !clipOfferedNow && (
        <p className="hint">
          {/* §3.2. Offering the clip first turns a retrieval into a listening exercise. */}
          The source clip becomes available once you have answered.
        </p>
      )}

      {card.clip !== null && card.clip.mediaMissing && (
        <p className="hint">
          The media file for this clip is missing, so there is no audio. The card still
          works.
        </p>
      )}

      <p className="review__prompt">{card.prompt}</p>

      {card.clozeText !== null && <p className="review__cloze">{card.clozeText}</p>}

      {phase === 'front' && (
        <>
          <label className="review__answer">
            Your answer <span className="hint">optional — a mental answer counts</span>
            <textarea
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              rows={2}
              autoFocus
            />
          </label>
          <div className="editor__actions">
            <button type="button" onClick={() => void doReveal()} disabled={busy}>
              Reveal
            </button>
            <button type="button" onClick={() => void doHint()}>
              Hint{hints > 0 ? ` (${hints})` : ''}
            </button>
          </div>
        </>
      )}

      {phase === 'revealed' && reveal !== null && (
        <div className="review__back">
          <h2>{reveal.canonicalForm}</h2>
          <p>{reveal.meaning}</p>
          {reveal.translation !== null && <p className="hint">{reveal.translation}</p>}

          {!reveal.meaningVerified && (
            <p className="badge badge--unverified">
              {/* Hard rule 12: never present a low-confidence result as confident. */}
              Unverified — your own gloss, not a dictionary's
            </p>
          )}

          {reveal.automaticCheck !== null && (
            <p className={reveal.automaticCheck.correct ? 'check check--ok' : 'check'}>
              {reveal.automaticCheck.correct
                ? 'Your answer matches the source form.'
                : `The source form was “${reveal.automaticCheck.expected}”.`}{' '}
              {/* §18.6: the machine never rates. */}
              <span className="hint">You decide the rating.</span>
            </p>
          )}

          {reveal.isOneOfSeveralAnswers && (
            <p className="hint">
              {/* §19.3: never presented as the only correct sentence. */}
              This is one acceptable answer, not the only one.
            </p>
          )}

          <Highlighted
            text={reveal.sentenceText}
            start={reveal.spanStart}
            end={reveal.spanEnd}
          />

          {contextOpen && (
            <p className="hint">
              {reveal.precedingText} … {reveal.followingText}
            </p>
          )}

          <div className="review__ratings" role="group" aria-label="Rate this card">
            {SCHEDULER_RATINGS.map((rating, index) => (
              <button
                key={rating}
                type="button"
                onClick={() => void doRate(rating)}
                disabled={busy}
                title={RATING_HINTS[rating]}
              >
                <strong>{index + 1}</strong> {RATING_LABELS[rating]}
                <span className="hint">{RATING_HINTS[rating]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <Shortcuts />
    </section>
  );
}

/**
 * The source sentence with the item marked.
 *
 * Offsets from the API, applied to text React escapes as a child. The server never sends
 * markup and this never builds any — transcript text is untrusted input (rule 8), and a
 * highlight built by interpolating a `<mark>` into a string is exactly the injection that
 * rule exists to prevent.
 */
function Highlighted({ text, start, end }: { text: string; start: number; end: number }) {
  if (text === '' || end <= start) return <p className="review__sentence">{text}</p>;
  return (
    <p className="review__sentence">
      {text.slice(0, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </p>
  );
}

function Shortcuts() {
  return (
    <dl className="shortcuts">
      {SHORTCUTS.map(([key, action]) => (
        <div key={key}>
          <dt>
            <kbd>{key}</kbd>
          </dt>
          <dd>{action}</dd>
        </div>
      ))}
    </dl>
  );
}
