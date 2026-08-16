# Architecture Decision Records

One file per decision. Numbered, immutable once accepted.

## When to write one

Write an ADR when a decision changes an **interface, a table, a formula, or a
dependency** — or when you find yourself about to make the same argument a second time.

Do not write one for ordinary implementation choices. The test is whether a reasonable
person could arrive later, see the code, and ask "why is it like this?"

## Status values

- **Proposed** — drafted with a recommendation, awaiting a decision
- **Accepted** — decided; binding on all code
- **Superseded by NNNN** — replaced; the file stays, so the history stays readable
- **Rejected** — considered and declined; kept so it is not re-proposed

Never delete an ADR. The value is in the record of what was considered.

## Index

| # | Decision | Outcome | Status |
|---|---|---|---|
| [0001](0001-language-pair.md) | First target and native language | German → English; one pair ships, adapter registry hook | Accepted |
| [0002](0002-nlp-stack.md) | NLP stack: TypeScript-only vs. Python sidecar | Python sidecar, spaCy `de_core_news_lg` | Accepted |
| [0003](0003-dictionary-provider.md) | Dictionary provider | Local Wiktextract index, **both** en + de editions | Accepted |
| [0004](0004-frequency-source.md) | Frequency dataset | Self-built OpenSubtitles unigram + n-gram; SUBTLEX-DE as a test fixture | Accepted |
| [0005](0005-llm-provider.md) | LLM provider and resource ceiling | **Local inference only** — vLLM, no cloud adapter, no API keys | Accepted |
| [0006](0006-evaluation-corpus.md) | Hand-labelled evaluation corpus | Two videos, same channel, two labelling passes | Accepted |
| [0007](0007-ui-topology.md) | UI topology: TUI for management, browser for media | Two clients, one API | Accepted |
| [0008](0008-recall-first-extraction.md) | Recall-first extraction: three tiers, lazy enrichment | | Accepted |
| [0009](0009-mwe-identification.md) | Multiword expression identification and storage | Amended by 0011 | Accepted |
| [0010](0010-multilanguage-forward-compat.md) | Multi-language: two hooks now, laddering deferred | | Accepted |
| [0011](0011-mwe-unithood-and-idiomaticity.md) | MWE unithood and idiomaticity as separate scores | Two scores, contiguous base generator | Accepted |
| [0012](0012-database-layer.md) | Database access layer | Drizzle over `better-sqlite3`; migrations hand-authored, never generated | Accepted |
| [0013](0013-reuse-from-bilingual-audio-generator.md) | Reuse from `bilingual-audio-generator` | Take sentence-boundary fusion + LLM index prompts | Accepted; amended by 0017 |
| [0014](0014-parse-warning-vocabulary.md) | The parse-warning vocabulary, and where it lives | Eighth kind `subtitle_boilerplate`; list moves to `packages/core` | Accepted |
| [0015](0015-local-media-scope.md) | What P80 ingests | **Local `.mp4` by reference only**; `youtube_embedded` removed, hard media rules rewritten | Accepted |
| [0016](0016-asr-transcription.md) | Where transcripts come from | Local ASR primary, user upload fallback; both in `services/nlp` | Accepted |
| [0017](0017-word-level-timing.md) | Transcript timing granularity | Word array is the source of truth; two declared tiers | Accepted |
| [0018](0018-media-file-identity.md) | What identifies a media file | Content hash is identity, path is a repairable locator | Accepted |
| [0019](0019-runtime-settings.md) | Which configuration is editable while the system runs | `settings` table seeded by the environment; live vs boot tiers; settings surface in both clients | Accepted |
| [0020](0020-manual-item-creation.md) | How a hand-made learning item enters the system | `POST /api/items`; occurrences anchor to segment-derived sentences, which constrains Stage 4 | Accepted |
| [0021](0021-running-as-a-service.md) | How P80 runs when somebody is using it | systemd user units over containers; the API serves the built client; migrations and backups get their own units | Accepted |
| [0022](0022-continuous-integration-and-deployment.md) | How a change reaches the running system | Hosted CI checks every push; deploying is a local pull-based script that snapshots, verifies, and rolls back code but never the database | Accepted |
| [0023](0023-reverse-proxy-origins.md) | Reaching P80 from another device | `P80_TRUSTED_ORIGINS`, empty by default, boot-tier, wildcards refused; the proxy's access control is the whole security model | Accepted |
| [0024](0024-uploading-media.md) | Putting a file into the library from the browser | Chunked resumable upload into one writable directory; rule 1 re-phrased as a mechanism; deletion bounded to what P80 wrote | Accepted |

**All 24 ADRs are accepted as of 2026-08-16.** Two questions inside ADR 0011 remain open by
design and resolve by measurement at Stage 8; one inside ADR 0016 resolves at the close of
Stage 2.

**0015 is the largest revision so far.** It replaces the media source, which reaches ADR
0007's playback assumptions and ADR 0013's timing constraints. Neither is superseded
outright — 0007's two-client split stands on reasoning that never depended on YouTube, and
0013's borrowed fusion survives with one of its four adaptations withdrawn by 0017. The
files stay as written; the amendments are recorded in the ADRs that make them.

One decision is deliberately deferred rather than made: the **TUI framework**. ADR 0007
requires the client but names no stack, and the surface that decides it is the candidate
inbox in Stage 5. Stage 1 ships a framework-free CLI; the ADR gets written when there is a
real screen to choose against, and takes whatever number is next by then.
