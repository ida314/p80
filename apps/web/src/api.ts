/**
 * The web client's only interface to P80 (`03-api.md` §1, ADR 0007).
 *
 * Clients hold no domain logic: scoring, session generation, sibling burying, and FSRS
 * live in `packages/core` and are reachable only through `/api/*`. If a component here
 * ever needs to compute a score, that is a signal the API response is incomplete — fix
 * the response, not the component.
 */

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable: boolean;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(envelope: ApiErrorEnvelope['error'], readonly status: number) {
    super(envelope.message);
    this.name = 'ApiError';
    this.code = envelope.code;
    this.retryable = envelope.retryable;
    this.details = envelope.details;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    let envelope: ApiErrorEnvelope | null = null;
    try {
      envelope = (await response.json()) as ApiErrorEnvelope;
    } catch {
      // A non-JSON failure means something upstream of the API answered — usually the
      // dev server with the API down. Say that plainly rather than showing "unexpected
      // token <".
    }
    throw new ApiError(
      envelope?.error ?? {
        code: 'API_UNREACHABLE',
        message:
          'The P80 API did not respond. Is it running? Start everything with `pnpm dev`.',
        retryable: true,
      },
      response.status,
    );
  }

  return (await response.json()) as T;
}

export interface Health {
  status: 'ok' | 'degraded';
  service: 'api';
  version: string;
  database: { reachable: boolean; migrationsApplied: number };
  inference: { mode: 'local'; configured: boolean };
}

export interface Profile {
  id: string;
  nativeLanguage: string;
  targetLanguage: string;
  proficiencyLabel: string | null;
  learningPurpose: string | null;
  dailyMinutes: number;
  newItemLimit: number;
  createdAt: number;
  updatedAt: number;
}

export const getHealth = () => api<Health>('/api/health');
export const getProfile = () => api<Profile>('/api/profile');
