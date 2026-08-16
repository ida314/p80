import { afterEach, describe, expect, it } from 'vitest';
import {
  UPLOAD_TTL_MS,
  advanceUpload,
  completeUpload,
  createUpload,
  findInFlightByFilename,
  getUpload,
  listExpiredUploads,
  listInFlightUploads,
  listUploads,
  settleUpload,
} from '../src/repositories/media-uploads.js';
import { createVideo } from '../src/repositories/videos.js';
import { ensureProfile } from '../src/repositories/profile.js';
import { createTempDatabase, type TempDatabase } from './helpers.js';

/**
 * ADR 0024's upload sessions.
 *
 * `advanceUpload` is the reason this file exists. Every other repository in P80 updates a
 * row unconditionally, because two requests racing to write the same field is either
 * impossible or harmless. Chunk arrival is neither, and the guard is one WHERE clause that
 * is easy to delete during a refactor because nothing about the call site looks fragile.
 */

let temp: TempDatabase;
afterEach(() => temp?.dispose());

function setup() {
  temp = createTempDatabase();
  const profile = ensureProfile(temp);
  const upload = createUpload(temp, {
    profileId: profile.id,
    originalFilename: 'Lektion 3.mp4',
    filename: 'Lektion-3.mp4',
    sizeBytes: 1000,
    mediaRoot: '/media/library',
    title: 'Lektion 3',
    interestsJson: null,
    transcribe: true,
  });
  return { profile, upload };
}

describe('a new session starts empty and in progress', () => {
  it('records what it was told and nothing it was not', () => {
    const { upload } = setup();
    expect(upload.receivedBytes).toBe(0);
    expect(upload.status).toBe('in_progress');
    expect(upload.originalFilename).toBe('Lektion 3.mp4');
    expect(upload.filename).toBe('Lektion-3.mp4');
    expect(upload.transcribe).toBe(true);
    // Null until the file is actually linked into place — this is what makes a reaped row
    // unambiguous rather than something that looks half-finished.
    expect(upload.mediaPath).toBeNull();
    expect(upload.videoId).toBeNull();
  });

  it('expires a day after it was last touched', () => {
    const { upload } = setup();
    expect(upload.expiresAt - upload.updatedAt).toBe(UPLOAD_TTL_MS);
  });
});

describe('advancing is conditional on the offset nobody else moved', () => {
  it('accepts a chunk that starts exactly where the file ends', () => {
    const { upload } = setup();
    expect(advanceUpload(temp, { id: upload.id, fromReceivedBytes: 0, toReceivedBytes: 400 }))
      .toBe(true);
    expect(getUpload(temp, upload.id)?.receivedBytes).toBe(400);
  });

  it('refuses a second writer claiming the offset the first already took', () => {
    const { upload } = setup();
    // Two chunks both read `receivedBytes: 0` and both try to advance. Without the
    // conditional update the second would silently overwrite bytes the first counted.
    expect(advanceUpload(temp, { id: upload.id, fromReceivedBytes: 0, toReceivedBytes: 400 }))
      .toBe(true);
    expect(advanceUpload(temp, { id: upload.id, fromReceivedBytes: 0, toReceivedBytes: 400 }))
      .toBe(false);
    expect(getUpload(temp, upload.id)?.receivedBytes).toBe(400);
  });

  it('refuses once the session is no longer in progress', () => {
    const { upload } = setup();
    settleUpload(temp, { id: upload.id, status: 'aborted' });
    expect(advanceUpload(temp, { id: upload.id, fromReceivedBytes: 0, toReceivedBytes: 400 }))
      .toBe(false);
  });

  it('pushes the expiry out, so a slow upload is not reaped mid-flight', () => {
    const { upload } = setup();
    advanceUpload(temp, { id: upload.id, fromReceivedBytes: 0, toReceivedBytes: 400 });
    const after = getUpload(temp, upload.id);
    expect(after).not.toBeNull();
    expect(after!.expiresAt).toBeGreaterThanOrEqual(upload.expiresAt);
  });
});

describe('settling a session', () => {
  it('records the path only on completion', () => {
    const { profile, upload } = setup();
    const video = createVideo(temp, {
      profileId: profile.id,
      sourceType: 'local_media',
      url: 'uploads/Lektion-3.mp4',
      mediaPath: 'uploads/Lektion-3.mp4',
      title: 'Lektion 3',
      targetLanguage: 'de',
      speakerLabel: null,
      regionLabel: null,
    });
    const done = completeUpload(temp, {
      id: upload.id,
      mediaPath: 'uploads/Lektion-3.mp4',
      videoId: video.id,
      jobId: 'job-1',
    });
    expect(done?.status).toBe('completed');
    expect(done?.mediaPath).toBe('uploads/Lektion-3.mp4');
    expect(done?.videoId).toBe(video.id);
  });

  it('will not complete a session that already settled', () => {
    const { upload } = setup();
    settleUpload(temp, { id: upload.id, status: 'aborted' });
    const done = completeUpload(temp, {
      id: upload.id,
      mediaPath: 'uploads/x.mp4',
      videoId: 'v1',
      jobId: 'j1',
    });
    expect(done?.status).toBe('aborted');
    expect(done?.mediaPath).toBeNull();
  });

  it('keeps aborted and failed apart, because they read differently in a list', () => {
    const { upload } = setup();
    const failed = settleUpload(temp, {
      id: upload.id,
      status: 'failed',
      error: { code: 'UPLOAD_STORAGE_FULL' },
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.errorJson).toContain('UPLOAD_STORAGE_FULL');
  });
});

describe('what the reaper and the browser can see', () => {
  it('lists in-flight sessions across profiles, because the sweep runs before one is in scope', () => {
    setup();
    expect(listInFlightUploads(temp)).toHaveLength(1);
  });

  it('finds nothing expired until the clock passes the expiry', () => {
    const { upload } = setup();
    expect(listExpiredUploads(temp, upload.expiresAt - 1)).toHaveLength(0);
    expect(listExpiredUploads(temp, upload.expiresAt + 1)).toHaveLength(1);
  });

  it('never reaps a session that already settled', () => {
    const { upload } = setup();
    settleUpload(temp, { id: upload.id, status: 'aborted' });
    expect(listExpiredUploads(temp, upload.expiresAt + 1)).toHaveLength(0);
  });

  it('filters a listing by status', () => {
    const { profile, upload } = setup();
    settleUpload(temp, { id: upload.id, status: 'aborted' });
    expect(listUploads(temp, { profileId: profile.id, status: 'in_progress' })).toHaveLength(0);
    expect(listUploads(temp, { profileId: profile.id, status: 'aborted' })).toHaveLength(1);
    expect(listUploads(temp, { profileId: profile.id })).toHaveLength(1);
  });

  it('warns about a name another live session already intends to write', () => {
    const { profile } = setup();
    expect(findInFlightByFilename(temp, { profileId: profile.id, filename: 'Lektion-3.mp4' }))
      .not.toBeNull();
    // Settled sessions do not reserve a name — the file is either there or it is not, and
    // the filesystem is the authority on that.
    expect(findInFlightByFilename(temp, { profileId: profile.id, filename: 'other.mp4' }))
      .toBeNull();
  });
});
