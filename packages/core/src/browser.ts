/**
 * The browser-safe surface of `@p80/core`.
 *
 * The main barrel reaches `node:fs` through `paths.ts` and `node:path` through
 * `storage.ts`, and pulls in `pino`. None of that can be bundled for a browser, so the web
 * client imports `@p80/core/browser` instead of narrowing its imports by hand and hoping.
 *
 * What is exported here is the domain vocabulary, the error envelope, the API response
 * schemas, and the pure transcript logic — everything ADR 0007 says a client may use, and
 * nothing that would let it hold domain logic of its own. Adding a module here is a claim
 * that it is pure; `packages/core/test/browser-surface.test.ts` checks that claim by
 * asserting the transitive import graph touches no `node:` builtin.
 *
 * The package is marked `"sideEffects": false`, which is what lets a bundler drop the parts
 * of this barrel a client does not use. Without it, importing one pure function pulls in
 * `api-types.js` and therefore Zod — 57 kB of a schema library the browser never runs,
 * because the client uses those schemas as types only. Nothing in `@p80/core` runs at
 * import time, so the claim holds; if that ever stops being true, this is the flag to
 * revisit.
 */

export * from './api-types.js';
export * from './domain.js';
export * from './errors.js';
export * from './jobs.js';
export * from './media.js';
export * from './polling.js';
export * from './text.js';
export * from './timecode.js';
export * from './transcript.js';
export * from './words.js';
