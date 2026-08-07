# P80 — Status

> Single source of truth for *where the project is*. Read at the start of every session,
> update at the end of every session. Keep it short — this is a dashboard, not a journal.

**Current stage:** Stage 0 — Lock scope and constraints
**Milestone:** M0 — Decisions (no code)
**Last updated:** 2026-08-07

---

## Now

**All eleven ADRs are accepted. Stage 0's decision work is finished and Stage 1 is
unblocked.** What remains in Stage 0 is manual work, not decisions.

The shape that fell out:

| | |
|---|---|
| Language | German → English. One pair ships; `LanguageAdapter` becomes a registry so the other three stay a registration, not a rewrite |
| NLP | Python sidecar, spaCy `de_core_news_lg`, loopback only |
| Dictionary | Local Wiktextract index over **both** the English and German Wiktionary editions, English glosses preferred |
| Frequency | Self-built OpenSubtitles-DE unigram + n-gram counts. SUBTLEX-DE is a correlation **fixture**, never a data source |
| LLM | **Local vLLM only.** No cloud adapter, no API keys, no outbound requests |
| Eval corpus | Two 10-min videos, same channel, two labelling passes |

## Blocked on

Nothing blocks Stage 1.

**Outstanding Stage 0 work**, none of which gates the skeleton:

- [ ] **ADR 0006 Pass A** — video 1, exhaustive word labels (~500 lemmas) plus
      `worth_learning` and reasons. Spans marked, not scored. ~1 day. *This is the only
      unmet Stage 0 exit criterion, and the item most likely to slip.*
- [ ] Stage 0 step 7 — source-use and privacy notices (`docs/policy/`)
- [ ] Stage 0 step 9 — initial German function-word list, in the adapter

## Done

- [x] Repo initialized, `.gitignore`
- [x] Spec frozen at `docs/original_spec.md`
- [x] Contracts extracted to `docs/contracts/` (7 documents), with 11 schema gaps closed
      and 4 spec ambiguities resolved
- [x] `CLAUDE.md` written
- [x] **ADR 0007 accepted** — TUI for management surfaces, browser for media surfaces.
      Two clients, one API, no domain logic in either.
- [x] **ADRs 0008–0010 accepted** — extraction rewritten from filter-first to recall-first.
      Three tiers (observed → candidate → item), validity gates only, lazy enrichment,
      global ranked queue with a per-video floor.
- [x] **ADR 0011 accepted** — MWE qualification split into two ranked scores, unithood and
      idiomaticity, with stored breakdowns. Contiguous enumeration is the base generator;
      dependency paths are the discontinuity extension.
- [x] **ADRs 0001–0006 accepted (2026-08-07)** — see the table above. Stage 0's twelve
      spec steps are now ten done, two outstanding.

## Next actions

1. **Label ADR 0006 Pass A.** Manual, unglamorous, blocks nothing today, and expensive
   exactly when it is missing. Everything else on this list can proceed in parallel.
2. Write the Stage 1 brief. Repo layout is fully determined now: `apps/{tui,web,api,worker}`,
   `services/nlp`, `packages/*`.
3. Start the skeleton.
4. Alongside Stage 1 setup, verify ADR 0001's readiness checklist — the resources are
   *named*, none is *verified*, and the boxes stay unticked until a fixture exercises each.

## Milestones

| # | Stages | Outcome | State |
|---|---|---|---|
| M0 | 0 | Scope locked, providers chosen, evaluation set exists | **decisions done; Pass A outstanding** |
| M1 | 1–3 | First complete vertical slice: add video → manual item → review it | not started |
| M2 | 4–6 | Deterministic extraction + dictionary-grounded meanings | not started |
| M3 | 7–8 | LLM disambiguation, expressions, constructions | not started |
| M4 | 9–10 | Learner model, adaptive admission, video difficulty | not started |
| M5 | 11–12 | Video loop, struggle diagnosis, recommendations | not started |
| M6 | 13 | Metrics, export, pilot readiness | not started |

## Open questions

Two remain, both inside ADR 0011, both deliberately left to measurement rather than
defaulted. Neither blocks anything before Stage 8.

- **Is the embedding non-compositionality path MVP or deferred?** Resolved as a *decision
  rule*, not a decision: build the dictionary path in Stage 6, then measure its recall
  against the Pass B idiomaticity labels at Stage 8 and record the number. ADR 0005's move
  to local inference removed the cost objection but not the tuning objection, which is the
  binding one — the embedding path needs labelled idiom data that does not exist until
  Pass B.
- **Layer 2 write threshold** — contiguous enumeration is ~7,500 spans/video against ~150
  from dependency, so Layer 3's sizing does not transfer. Default: persist on second
  sighting. Validated at Stage 8.

`07-extraction.md` §14 carries three further tunables with recorded defaults. One of them,
the recurrence promotion threshold (3 distinct videos), is **not measurable against a
two-video corpus** and has to wait for a real library.

## Notes

- Contracts introduced 11 tables absent from spec §28 (`tokens`, `review_sessions`,
  `known_lexicon`, `known_frequency_bands`, `placement_results`, `video_loop_sessions`,
  `provider_calls`, `transcript_corrections`, `recommendation_feedback`,
  `pipeline_versions`, `construction_patterns`). See `docs/contracts/02-database.md` §2.
- The contracts diverge from the frozen spec in three named places, all ADR-backed:
  §14.10's reject-on-value gates (ADR 0008), §27.1's enrich-before-score job order
  (ADR 0008), and §26.1's all-TypeScript monorepo (ADR 0002, Python sidecar). All marked
  `RESOLVED` inline.
- **Local-only inference strengthens local-first rather than compromising it.** There is no
  API key to leak, no external request to disclose, and transcript text never leaves the
  machine — §32.3 and §15 become structural guarantees instead of disciplines. The
  trade is a heavier setup and slower enrichment. `CLAUDE.md` rules 14 and 15 were rewritten.
- **New dependency: `uselimit`** (`~/Projects/uselimit`), enforcing the enrichment ceilings —
  100 candidates/video and 45 min/job, both hard; 40 h/month, warn only. It needs a
  transactional SQLite `StorageAdapter` written upstream, because the shipped
  `InMemoryAdapter` is single-process and both the API and worker consume budget.
- **Setup is not `pnpm install`.** spaCy model, two Wiktextract dumps, the OpenSubtitles
  corpus, a dictionary index build, and a frequency counting pass. Document all of it.
- **Named risk: German lemmatization.** spaCy's German lemmatizer is rule/lookup-based and
  weakest on verb inflection and separable verbs — which is what §14.8 consolidation,
  §22.1 coverage, and MWE lemma identity all key on. Three stages, one root cause, and the
  symptoms point elsewhere. Verify at Stage 4; the fallback is Stanza inside the same
  sidecar, which is a version bump rather than an architecture change.
- **Two dictionary editions introduce one failure mode worth watching:** a German-edition
  sense grounds an item, but its English rendering is an LLM bridge translation and must be
  labelled unverified. Never let that translation be presented as the dictionary's own
  definition.
- ADR 0001 originally listed four target languages. Resolved: German ships, the other three
  are Phase E, and the registry is the only cost paid now.
