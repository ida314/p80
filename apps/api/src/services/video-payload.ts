import { buildMediaDescriptor, type VideoPayload } from '@p80/core';
import {
  countSegments,
  listVideoInterests,
  type DatabaseHandle,
  type VideoRow,
} from '@p80/database';

/**
 * Assembles the response a client renders.
 *
 * `03-api.md` §1: *"a response must carry everything needed to render it; a client must
 * never have to recompute a score, a schedule, or a session plan."* Two things follow for
 * a video.
 *
 * **`media` is a descriptor, not a path.** The client gets a URL it can put in a `<video>`
 * element and a flag saying whether the file is still there. It never learns where media
 * lives on disk — `04-providers.md` §1 keeps paths behind `MediaSourceAdapter`, and the
 * one route that resolves them is the media stream itself. This is the same rule the
 * removed embed descriptor followed, which is why swapping the player did not reach the
 * clients' data shape.
 *
 * **`segmentCount` is counted here.** It is what the Videos list shows to distinguish "no
 * transcript yet" from "transcript ready", and asking the client to fetch every segment to
 * learn the number would be absurd.
 */
export function toVideoPayload(handle: DatabaseHandle, video: VideoRow): VideoPayload {
  return {
    id: video.id,
    profileId: video.profileId,
    sourceType: video.sourceType,
    externalVideoId: video.externalVideoId,
    url: video.url,
    title: video.title,
    targetLanguage: video.targetLanguage,
    durationMs: video.durationMs,
    speakerLabel: video.speakerLabel,
    regionLabel: video.regionLabel,
    transcriptStatus: video.transcriptStatus,
    processingStatus: video.processingStatus,
    estimatedCoverage: video.estimatedCoverage,
    difficultyLabel: video.difficultyLabel,
    pipelineVersion: video.pipelineVersion,
    mediaMissing: video.mediaMissing,
    createdAt: video.createdAt,
    updatedAt: video.updatedAt,
    media: buildMediaDescriptor(video.id, { missing: video.mediaMissing }),
    segmentCount: countSegments(handle, video.id),
    interests: listVideoInterests(handle, video.id),
  };
}
