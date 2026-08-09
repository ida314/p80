import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api.js';

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** Re-fetches without clearing `data`, so a refresh after a correction does not blank
   *  the transcript and lose the scroll position. */
  reload: () => void;
  /** Applies a locally known result — used where the API already returned the new row and
   *  a second round trip would only add latency. */
  set: (next: T) => void;
}

/**
 * Fetch-once-and-reload, with the cancellation every `useEffect` fetch needs.
 *
 * Deliberately not a cache. Stage 2 has four screens and no shared state between them;
 * introducing a query library here would be infrastructure for a problem P80 does not have
 * yet, and ADR 0007 means none of this can grow into domain logic anyway.
 */
export function useResource<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `fetcher` is a fresh closure
  // on every render; the caller's `deps` are what actually decide when to re-fetch.
  const run = useCallback(fetcher, deps);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    run()
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError(
                { code: 'UNEXPECTED', message: String(caught), retryable: false },
                0,
              ),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [run, nonce]);

  return {
    data,
    error,
    loading,
    reload: useCallback(() => setNonce((n) => n + 1), []),
    set: useCallback((next: T) => setData(next), []),
  };
}
