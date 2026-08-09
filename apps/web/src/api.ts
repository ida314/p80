/**
 * The web client's only interface to P80 (`03-api.md` §1, ADR 0007).
 *
 * Clients hold no domain logic: scoring, session generation, sibling burying, and FSRS
 * live in `packages/core` and are reachable only through `/api/*`. If a component here
 * ever needs to compute a score, that is a signal the API response is incomplete — fix
 * the response, not the component.
 *
 * Response *types* come from `@p80/core/browser`, the same objects `apps/api` uses as its
 * Fastify response schemas. They are imported `type`-only, so `verbatimModuleSyntax`
 * erases them and no Zod reaches the bundle — but a drift between what the API sends and
 * what this file expects becomes a typecheck failure rather than a runtime surprise.
 */

import type {
  CreateItemBody,
  DueSummaryPayload,
  InterestPayload,
  ItemHistoryPayload,
  ItemPayload,
  JobRecord,
  MediaRootPreflightPayload,
  ReviewCardPayload,
  ReviewForecastPayload,
  ReviewRevealPayload,
  SessionPayload,
  SettingsPayload,
  SegmentPayload,
  TranscriptFormat,
  TranscriptPayload,
  TranscriptPreviewPayload,
  TranscriptWordsPayload,
  VideoAcceptedPayload,
  VideoPayload,
} from '@p80/core/browser';

export type {
  CreateItemBody,
  DueSummaryPayload,
  InterestPayload,
  ItemHistoryPayload,
  ItemPayload,
  JobRecord,
  MediaRootPreflightPayload,
  ParseWarningPayload,
  ReviewCardPayload,
  ReviewForecastPayload,
  ReviewRevealPayload,
  SessionPayload,
  SettingViewPayload,
  SettingsPayload,
  SegmentPayload,
  TranscriptFormat,
  TranscriptPayload,
  TranscriptPreviewPayload,
  TranscriptWordsPayload,
  VideoAcceptedPayload,
  VideoPayload,
} from '@p80/core/browser';

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

const send = <T>(method: string, path: string, body?: unknown) =>
  api<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

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

/* ---------------------------------------------------------------- videos */

export interface VideoListPayload {
  videos: VideoPayload[];
  nextCursor: string | null;
}

export const listVideos = (query: { q?: string } = {}) => {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  const search = params.toString();
  return api<VideoListPayload>(`/api/videos${search ? `?${search}` : ''}`);
};

export const getVideo = (id: string) => api<VideoPayload>(`/api/videos/${id}`);

/**
 * `targetLanguage` is deliberately absent: it comes from the profile (ADR 0001). So is any
 * validation of `path` — a client that decided what was inside the media root would be
 * holding domain logic, and the two implementations would disagree the first time one
 * changed, which for a containment check means being quietly wrong about what is reachable.
 *
 * Returns `202` with a job, not the finished video: identity, duration, and transcription
 * all happen in `INGEST_MEDIA` (ADR 0018).
 */
export const createVideo = (body: {
  /** Relative to the server's media root. */
  path: string;
  title?: string;
  speakerLabel?: string | null;
  regionLabel?: string | null;
  interests?: Array<{ interestId: string; relevance: number }>;
}) => send<VideoAcceptedPayload>('POST', '/api/videos', body);

/** Re-point a video whose file moved (ADR 0018 §3). The hash is verified in the job, so a
 *  different file fails there with `MEDIA_CONTENT_MISMATCH` rather than being accepted. */
export const repairMedia = (id: string, path: string) =>
  send<VideoAcceptedPayload>('POST', `/api/videos/${id}/media/repair`, { path });

export const getTranscriptWords = (id: string) =>
  api<TranscriptWordsPayload>(`/api/videos/${id}/transcript/words`);

export const updateVideo = (
  id: string,
  body: {
    title?: string | null;
    speakerLabel?: string | null;
    regionLabel?: string | null;
    durationMs?: number | null;
    interests?: Array<{ interestId: string; relevance: number }>;
  },
) => send<VideoPayload>('PUT', `/api/videos/${id}`, body);

export interface DeletionCounts {
  deletedSegments: number;
  deletedCorrections: number;
  deletedFiles: number;
  cancelledJobs: number;
}

export const deleteVideo = (id: string) =>
  send<DeletionCounts & { deleted: true; archivedItems: number }>(
    'DELETE',
    `/api/videos/${id}`,
  );

/* ------------------------------------------------------------ transcript */

export interface TranscriptUpload {
  content: string;
  filename?: string | null;
  format?: TranscriptFormat;
  replace?: boolean;
}

export interface TranscriptAccepted {
  jobId: string;
  status: 'pending';
  transcriptFileId: string;
}

export const previewTranscript = (videoId: string, body: TranscriptUpload) =>
  send<TranscriptPreviewPayload>('POST', `/api/videos/${videoId}/transcript/preview`, body);

export const uploadTranscript = (videoId: string, body: TranscriptUpload) =>
  send<TranscriptAccepted>('POST', `/api/videos/${videoId}/transcript`, body);

export const getTranscript = (videoId: string) =>
  api<TranscriptPayload>(`/api/videos/${videoId}/transcript`);

export const correctSegment = (
  videoId: string,
  segmentId: string,
  body: { text?: string; startMs?: number; endMs?: number },
) =>
  send<SegmentPayload>(
    'PUT',
    `/api/videos/${videoId}/transcript/segments/${segmentId}`,
    body,
  );

export const deleteTranscript = (videoId: string) =>
  send<DeletionCounts>('DELETE', `/api/videos/${videoId}/transcript`);

/* ----------------------------------------------------------------- jobs */

export const getJob = (id: string) => api<JobRecord>(`/api/jobs/${id}`);

/* ------------------------------------------------------------ interests */

export const listInterests = () => api<InterestPayload[]>('/api/interests');

export const createInterest = (body: { name: string; weight?: number }) =>
  send<InterestPayload>('POST', '/api/interests', body);

/* ------------------------------------------------------------- settings */
/**
 * ADR 0019. The page renders from `control` and `editable` and knows nothing about what
 * any individual setting means — the registry, the validation, and the refusal all live
 * behind the API, which is what keeps this client and the TUI from disagreeing.
 */
export const getSettings = () => api<SettingsPayload>('/api/settings');

export const preflightMediaRoot = (path: string) =>
  send<MediaRootPreflightPayload>('POST', '/api/settings/media-root/preflight', { path });

/**
 * `acknowledgeOrphans` confirms a counted, stated, reversible consequence — that some
 * videos will stop resolving under the new media root. It is not a force flag, and the
 * page only sends it after showing the number.
 */
export const updateSettings = (
  settings: Record<string, string | number | boolean>,
  acknowledgeOrphans = false,
) => send<SettingsPayload>('PUT', '/api/settings', { settings, acknowledgeOrphans });

/* --------------------------------------------------------- items (Stage 3) */
/**
 * ADR 0020. `createItem` sends a **selection** — segment ids and character offsets — and
 * never a timing. The server resolves the offsets against the word array and derives the
 * clip window, because deciding what a clip is would be domain logic (ADR 0007) and a
 * client-supplied `startMs` would be unverifiable.
 */
export const createItem = (body: CreateItemBody) => send<ItemPayload>('POST', '/api/items', body);

export const getItem = (id: string) => api<ItemPayload>(`/api/items/${id}`);

export const listItems = (params: { videoId?: string; limit?: number } = {}) => {
  const query = new URLSearchParams();
  if (params.videoId) query.set('videoId', params.videoId);
  if (params.limit) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return api<{ items: ItemPayload[]; nextCursor: string | null }>(
    `/api/items${suffix ? `?${suffix}` : ''}`,
  );
};

export const getItemHistory = (id: string) =>
  api<ItemHistoryPayload>(`/api/items/${id}/history`);

/* -------------------------------------------------------- review (Stage 3) */

export const getDueSummary = () => api<DueSummaryPayload>('/api/review/due');

export const getForecast = () => api<ReviewForecastPayload>('/api/review/forecast');

export const startSession = (body: {
  desiredMinutes: number;
  includeNewItems: boolean;
}) => send<SessionPayload>('POST', '/api/review/session', body);

/** `{ done: true }` when the plan is exhausted. The union is the API's, not a client
 *  invention — a session with nothing left is a normal outcome, not a 404. */
export const getNextCard = (sessionId: string, preRollMs?: number) => {
  const query = preRollMs === undefined ? '' : `?preRollMs=${preRollMs}`;
  return api<ReviewCardPayload | { done: true }>(
    `/api/review/session/${sessionId}/next${query}`,
  );
};

/** The attempt, which is what earns the back face (§1 rule 2). */
export const answerCard = (
  sessionId: string,
  body: { reviewId: string; responseText?: string; responseLatencyMs?: number; sourceContextUsed?: boolean },
) => send<ReviewRevealPayload>('POST', `/api/review/session/${sessionId}/answer`, body);

export const rateCard = (
  sessionId: string,
  body: { reviewId: string; rating: 'again' | 'hard' | 'good' | 'easy' },
) =>
  send<{
    cardId: string;
    rating: string;
    dueAt: number;
    intervalDays: number;
    phase: string;
    lapsed: boolean;
    requeued: boolean;
  }>('POST', `/api/review/session/${sessionId}/rate`, body);

export const hintCard = (sessionId: string, reviewId: string) =>
  send<{ reviewId: string; hintCount: number }>(
    'POST',
    `/api/review/session/${sessionId}/hint`,
    { reviewId },
  );

export const completeSession = (sessionId: string) =>
  send<SessionPayload>('POST', `/api/review/session/${sessionId}/complete`, {});
