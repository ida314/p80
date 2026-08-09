import { useEffect, useRef } from 'react';

/**
 * Keeps the active transcript line in view while the video plays.
 *
 * Two rules, both from the same worry — that the page should never fight the user:
 *
 * - **Only when following is on.** Scrolling away is how someone reads ahead, and a view
 *   that yanks itself back every 200 ms cannot be read at all. The caller turns following
 *   off when the user scrolls and back on with an explicit button.
 * - **Only when the active line actually changes.** Re-scrolling on every playback sample
 *   would make a smooth scroll restart four times a second and never arrive.
 */
export function useFollowPlayback(
  activeIndex: number,
  enabled: boolean,
  container: React.RefObject<HTMLElement>,
): void {
  const lastIndex = useRef(-1);

  useEffect(() => {
    if (!enabled || activeIndex < 0) return;
    if (activeIndex === lastIndex.current) return;
    lastIndex.current = activeIndex;

    const row = container.current?.querySelector(`[data-segment-index="${activeIndex}"]`);
    // `nearest` rather than `center`: it scrolls only when the line is off-screen, so a
    // line already visible stays exactly where the reader's eye left it.
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIndex, enabled, container]);
}
