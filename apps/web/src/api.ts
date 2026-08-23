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
  LibraryDeletePayload,
  LibraryListingPayload,
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
  UploadListPayload,
  UploadSessionPayload,
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
  LibraryDeletePayload,
  LibraryEntryPayload,
  LibraryListingPayload,
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
  UploadListPayload,
  UploadSessionPayload,
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

/**
 * Turn a failed response into a typed `ApiError`.
 *
 * Extracted so the upload chunk request can reuse it. That request cannot go through
 * `api<T>` — it must not send `content-type: application/json`, because its body is raw
 * bytes — and duplicating the envelope handling would mean two places that decide what a
 * failure looks like to the client.
 */
export async function throwEnvelope(response: Response): Promise<never> {
  let envelope: ApiErrorEnvelope | null = null;
  try {
    envelope = (await response.json()) as ApiErrorEnvelope;
  } catch {
    // A non-JSON failure means something upstream of the API answered — usually the
    // dev server with the API down, or a reverse proxy refusing the request before it
    // ever reached P80. Say that plainly rather than showing "unexpected token <".
  }
  throw new ApiError(
    envelope?.error ?? {
      code: response.status === 413 ? 'PROXY_BODY_TOO_LARGE' : 'API_UNREACHABLE',
      message:
        response.status === 413
          ? 'Something between this browser and P80 refused the request for being too large.'
          : 'The P80 API did not respond. Is it running? Start everything with `pnpm dev`.',
      retryable: true,
    },
    response.status,
  );
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!response.ok) await throwEnvelope(response);

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

/**
 * The jobs for one entity, newest first (`03-api.md` §8 — `status`, `type`, `entityId`).
 *
 * This is how a client finds a job it was never handed an id for. `INGEST_MEDIA` enqueues
 * `TRANSCRIBE` from inside the worker, long after the `202 { video, jobId }` went out, so
 * the transcribe job's id cannot appear in that response — it does not exist yet. Asking
 * the list route for it is the only path that also works on a later visit, when the
 * upload's in-memory state is long gone.
 */
export const listJobs = (query: {
  entityId?: string;
  jobType?: string;
  status?: string;
  limit?: number;
}) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return api<JobRecord[]>(`/api/jobs?${params.toString()}`);
};

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
/** `null` reverts a key to its environment value rather than writing one (ADR 0026). */
export const updateSettings = (
  settings: Record<string, string | number | boolean | null>,
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

/* --------------------------------------------- media library and uploads (ADR 0024) */

export const browseLibrary = (query: { path?: string; limit?: number; cursor?: string } = {}) => {
  const params = new URLSearchParams();
  if (query.path !== undefined) params.set('path', query.path);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  const qs = params.toString();
  return api<LibraryListingPayload>(`/api/library${qs === '' ? '' : `?${qs}`}`);
};

/** `acknowledgeVideos` is the second half of the server's two-step refusal. The client
 *  never decides on its own that a delete is safe — it relays the 409, shows what the API
 *  said would be affected, and comes back with the flag if the user agrees. */
export const deleteLibraryFile = (path: string, acknowledgeVideos = false) =>
  send<LibraryDeletePayload>(
    'DELETE',
    `/api/library/file?path=${encodeURIComponent(path)}&acknowledgeVideos=${acknowledgeVideos}`,
  );

export const createUpload = (body: {
  filename: string;
  sizeBytes: number;
  title?: string;
  interests?: Array<{ interestId: string; relevance: number }>;
  transcribe?: boolean;
}) => send<UploadSessionPayload>('POST', '/api/uploads', body);

export const getUpload = (id: string) => api<UploadSessionPayload>(`/api/uploads/${id}`);

export const listUploads = () => api<UploadListPayload>('/api/uploads');

export const abortUpload = (id: string) =>
  send<{ deleted: true; discardedBytes: number }>('DELETE', `/api/uploads/${id}`);

export const completeUpload = (id: string) =>
  send<VideoAcceptedPayload>('POST', `/api/uploads/${id}/complete`, {});

/**
 * Send one chunk.
 *
 * Deliberately not routed through `api<T>`: that helper's single job is JSON, and this
 * body is raw bytes. What the two share is `throwEnvelope`, so a refusal reaches the user
 * as the same typed `ApiError` either way.
 *
 * The `signal` is what makes Cancel immediate rather than "after this eight megabytes
 * finishes uploading".
 */
export const uploadChunk = async (
  id: string,
  offset: number,
  blob: Blob,
  signal?: AbortSignal,
): Promise<UploadSessionPayload> => {
  const response = await fetch(`/api/uploads/${id}/chunk?offset=${offset}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: blob,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) await throwEnvelope(response);
  return (await response.json()) as UploadSessionPayload;
};
