/**
 * Reading a transcript selection out of the DOM, in the shape `POST /api/items` wants.
 *
 * This is the one piece of Stage 3 that can only live in a browser: a `Selection` is not a
 * thing the server has. What it produces is deliberately *not* a decision — segment ids
 * and character offsets, which the API resolves into timings against the word array. The
 * client never computes a clip (ADR 0007).
 *
 * **The joiner must match the server's.** `apps/api/src/routes/items.ts` joins the touched
 * segments with a single space to build the context string the offsets index into. If the
 * two ever disagree, every multi-segment selection silently anchors to the wrong words —
 * which is why the offsets are computed here from the same join rather than from anything
 * the DOM happens to render.
 */

export const SEGMENT_JOINER = ' ';

/** The attribute a transcript row puts on the element wrapping its text. */
export const SEGMENT_ATTRIBUTE = 'data-segment-id';

export interface TranscriptSelection {
  segmentIds: string[];
  spanStart: number;
  spanEnd: number;
  /** What the user actually highlighted, for the form to prefill. */
  text: string;
  /** The joined context the offsets index into, for a preview of the cloze. */
  contextText: string;
}

/**
 * How far into `element`'s text content the point `(node, offset)` sits.
 *
 * Done with a Range rather than by walking text nodes, because `toString()` is what
 * decides where the characters are — a walk would have to reimplement the browser's own
 * answer and would disagree the first time a row contains an element boundary.
 */
function offsetWithin(element: Element, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  try {
    range.setEnd(node, offset);
  } catch {
    // The point is outside this element entirely — before it, in practice, since callers
    // only ask about elements the selection intersects.
    return 0;
  }
  return range.toString().length;
}

export function readTranscriptSelection(container: HTMLElement): TranscriptSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const elements = [...container.querySelectorAll<HTMLElement>(`[${SEGMENT_ATTRIBUTE}]`)];
  const touched = elements.filter((element) => range.intersectsNode(element));
  if (touched.length === 0) return null;

  const first = touched[0] as HTMLElement;
  const last = touched[touched.length - 1] as HTMLElement;

  const startsInFirst = first.contains(range.startContainer);
  const endsInLast = last.contains(range.endContainer);

  const localStart = startsInFirst
    ? offsetWithin(first, range.startContainer, range.startOffset)
    : 0;
  const localEnd = endsInLast
    ? offsetWithin(last, range.endContainer, range.endOffset)
    : (last.textContent ?? '').length;

  const texts = touched.map((element) => element.textContent ?? '');
  const contextText = texts.join(SEGMENT_JOINER);

  // Offset of the last touched segment inside the joined string.
  const lastStart = texts
    .slice(0, -1)
    .reduce((total, text) => total + text.length + SEGMENT_JOINER.length, 0);

  const spanStart = localStart;
  const spanEnd = touched.length === 1 ? localEnd : lastStart + localEnd;
  if (spanEnd <= spanStart) return null;

  const text = contextText.slice(spanStart, spanEnd).trim();
  if (text.length === 0) return null;

  return {
    segmentIds: touched.map((element) => element.getAttribute(SEGMENT_ATTRIBUTE) as string),
    spanStart,
    spanEnd,
    text,
    contextText,
  };
}
