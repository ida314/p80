"""Transcription: a media file on disk -> a flat array of timed words (ADR 0016).

This is deliberately *not* an LLM watching a video. It is ASR, and the reason is timing:
P80 needs to know when each word was said so a review card can replay exactly that word
(ADR 0017). A video-understanding model gives worse timestamps and invents speech that was
never said.

**Whisper's own segment boundaries are discarded.** They come from timestamp-token
sampling and the 30-second decoding window, not from linguistics, and they routinely fall
nowhere near the punctuation the model itself emitted. What leaves this module is a word
array; sentences are decided in Stage 4 from that array.

Three refusals, each covering a case where the system would otherwise report success while
being wrong (ADR 0016 §3):

* **No model installed** -> 501. Never an empty transcript, which is indistinguishable
  from "this video has no speech".
* **GPU configured and unavailable** -> 503. ASR on CPU is roughly twenty times slower and
  otherwise identical, which produces a job that looks like it is working for forty
  minutes. This is the same failure the sibling project documents: a CPU-only wheel
  installs cleanly and then silently runs on CPU.
* **Detected language disagrees with the requested one** -> 409. A German profile fed an
  English video would otherwise get a plausible transcript and a curriculum of the wrong
  language.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Whisper emits these over silence and music, learned from subtitle training data. They are
# fluent, correctly formatted, and entirely fabricated. P80 does not drop them — §14.2
# forbids discarding transcript content silently — so a match becomes a warning on a stored
# row and the user decides. The list is shared with the subtitle parsers (ADR 0013 §4),
# which see the same strings for the same reason: a good share of subtitle files were
# scraped from the corpora Whisper trained on.
HALLUCINATION_PATTERNS = (
    r"^\s*(thanks?|thank you) for watching",
    r"^\s*subtitles? (by|created|provided)",
    r"^\s*(amara\.org|subscene|opensubtitles)",
    r"^\s*please (subscribe|like and subscribe)",
    r"^\s*untertitel (von|im auftrag)",
    r"^\s*vielen dank für(s| das) zuschauen",
)

# Thresholds from the sibling project, unchanged. ADR 0013 recorded that these did not
# transfer to user-supplied transcripts because those carry no confidence signals; ASR
# output does, so ADR 0016 brings them across.
NO_SPEECH_LIMIT = 0.6
LOGPROB_LIMIT = -1.0
REPEAT_WINDOW = 2  # identical text this many segments back is a stuck decoder


class AsrUnavailable(RuntimeError):
    """No model, or no usable device. 501/503 — a setup problem, not a bad request."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


class AsrLanguageMismatch(RuntimeError):
    """409. Both languages are named in the message, because either could be the mistake."""


@dataclass
class Word:
    text: str
    start_ms: int
    end_ms: int
    confidence: float | None


@dataclass
class Warning_:
    kind: str
    segment_index: int | None
    message: str


@dataclass
class Result:
    words: list[Word] = field(default_factory=list)
    detected_language: str = ""
    language_probability: float = 0.0
    duration_ms: int = 0
    warnings: list[Warning_] = field(default_factory=list)
    model_id: str = ""
    alignment_model_id: str | None = None


@dataclass(frozen=True)
class Settings:
    model_id: str
    device: str
    compute_type: str
    require_gpu: bool
    align: bool
    # How far the detected language may fall below the requested one before the mismatch
    # is an error. Whisper reports a probability, and a confident disagreement is a
    # different event from an uncertain one.
    language_min_probability: float

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> Settings:
        e = env if env is not None else dict(os.environ)
        return Settings(
            model_id=e.get("P80_ASR_MODEL", "large-v3"),
            device=e.get("P80_ASR_DEVICE", "cuda"),
            compute_type=e.get("P80_ASR_COMPUTE_TYPE", "float16"),
            require_gpu=e.get("P80_ASR_REQUIRE_GPU", "true").lower() in ("1", "true"),
            align=e.get("P80_ASR_ALIGN", "true").lower() in ("1", "true"),
            language_min_probability=float(e.get("P80_ASR_LANG_MIN_PROB", "0.5")),
        )


def available(settings: Settings | None = None) -> bool:
    """Whether ``/transcribe`` can serve, reported separately on ``/health``.

    An import check rather than a load: loading the model takes tens of seconds and holds
    gigabytes, and health checks run often.
    """
    try:
        import faster_whisper  # noqa: F401, PLC0415
    except ImportError:
        return False
    return True


def assert_device(settings: Settings) -> None:
    """Fail loudly rather than fall back to CPU.

    The failure this prevents is specific and has bitten this stack's ancestor: CTranslate2
    ships no aarch64 CUDA wheels, so ``pip install`` succeeds and inference then runs on
    CPU at roughly a twentieth of the speed. On a job that was going to take three minutes
    that produces something which looks like it is working for an hour. This check is the
    difference between finding out in a second and finding out after the job.
    """
    if not settings.require_gpu or not settings.device.startswith("cuda"):
        return
    try:
        import torch  # noqa: PLC0415
    except ImportError as exc:
        raise AsrUnavailable(
            "GPU was requested but torch is not installed, so device availability "
            "cannot be verified. Set P80_ASR_REQUIRE_GPU=0 to run on CPU deliberately."
        ) from exc
    if not torch.cuda.is_available():
        raise AsrUnavailable(
            "CUDA was requested and is unavailable. Transcription on CPU is roughly "
            "twenty times slower, so P80 refuses rather than running a job that looks "
            "healthy for an hour. Set P80_ASR_REQUIRE_GPU=0 to run on CPU deliberately.",
            retryable=True,
        )


def transcribe(media_path: str, language: str, settings: Settings | None = None) -> Result:
    """Decode the file's audio and return a flat, time-ordered word array.

    The path arrives already resolved and contained by the caller (``CLAUDE.md`` rule 4).
    This module does not re-derive it from user input, and does not accept a URL — there is
    no code path here that produces bytes P80 was not given.
    """
    cfg = settings or Settings.from_env()
    path = Path(media_path)
    if not path.is_file():
        raise AsrUnavailable(f"No media file at the given path: {path.name}")

    assert_device(cfg)

    try:
        from faster_whisper import WhisperModel  # noqa: PLC0415
    except ImportError as exc:
        raise AsrUnavailable(
            "faster-whisper is not installed. See docs/SETUP.md — the ASR model is a "
            "setup step, not a runtime download."
        ) from exc

    model = WhisperModel(cfg.model_id, device=cfg.device, compute_type=cfg.compute_type)

    # `language` is pinned rather than detected (ADR 0016 §3). Detection still runs, and
    # `info` carries what the model would have chosen — which is the evidence for the
    # mismatch check below.
    segments, info = model.transcribe(
        str(path),
        language=language,
        # Word timing is the entire reason this stage exists (ADR 0017).
        word_timestamps=True,
        # VAD keeps silence out of the decoder, which removes most hallucinations at
        # source rather than filtering them afterwards.
        vad_filter=True,
    )

    result = Result(
        detected_language=info.language,
        language_probability=float(info.language_probability or 0.0),
        duration_ms=int(round((info.duration or 0.0) * 1000)),
        model_id=cfg.model_id,
    )

    _assert_language(language, result, cfg)

    # `segments` is a generator; consuming it is what actually runs the decode.
    result.words, result.warnings = _collect(segments)

    if not result.words:
        raise AsrUnavailable(
            "Transcription produced no words. The file may have no speech track."
        )

    if cfg.align:
        result.alignment_model_id = _align(result, str(path), language, cfg)

    return result


def _assert_language(requested: str, result: Result, cfg: Settings) -> None:
    detected = (result.detected_language or "").split("-")[0].lower()
    wanted = requested.split("-")[0].lower()
    if not detected or detected == wanted:
        return
    # An uncertain disagreement is not evidence of anything. A confident one is.
    if result.language_probability < cfg.language_min_probability:
        result.warnings.append(
            Warning_(
                kind="low_asr_confidence",
                segment_index=None,
                message=(
                    f"language detection was uncertain: detected {detected} at "
                    f"{result.language_probability:.2f}, decoded as {wanted}"
                ),
            )
        )
        return
    raise AsrLanguageMismatch(
        f"This audio appears to be {detected} (confidence "
        f"{result.language_probability:.2f}), but the profile studies {wanted}. "
        "Transcribing it anyway would produce a curriculum in the wrong language."
    )


def _collect(segments) -> tuple[list[Word], list[Warning_]]:
    """Flatten to a single word array, warning about — never dropping — suspect output."""
    import re  # noqa: PLC0415

    patterns = [re.compile(p, re.IGNORECASE) for p in HALLUCINATION_PATTERNS]
    words: list[Word] = []
    warnings: list[Warning_] = []
    recent: list[str] = []
    unaligned = 0

    for index, seg in enumerate(segments):
        text = (seg.text or "").strip()

        if any(p.search(text) for p in patterns):
            warnings.append(
                Warning_(
                    kind="subtitle_boilerplate",
                    segment_index=index,
                    # No transcript text in a warning message, ever (ADR 0014) — this
                    # column is persisted forever and re-served on every read.
                    message="matched a subtitle-boilerplate pattern",
                )
            )

        reasons = []
        if (seg.no_speech_prob or 0.0) > NO_SPEECH_LIMIT:
            reasons.append("no_speech")
        if (seg.avg_logprob or 0.0) < LOGPROB_LIMIT:
            reasons.append("low_logprob")
        if text and text in recent[-REPEAT_WINDOW:]:
            reasons.append("repeat")
        if reasons:
            warnings.append(
                Warning_(
                    kind="low_asr_confidence",
                    segment_index=index,
                    message=f"low-confidence region: {', '.join(reasons)}",
                )
            )
        recent.append(text)

        for w in seg.words or []:
            surface = (w.word or "").strip()
            if not surface:
                continue
            if w.start is None or w.end is None:
                unaligned += 1
                continue
            words.append(
                Word(
                    text=surface,
                    start_ms=int(round(w.start * 1000)),
                    end_ms=int(round(w.end * 1000)),
                    confidence=float(w.probability) if w.probability is not None else None,
                )
            )

    if unaligned:
        warnings.append(
            Warning_(
                kind="unaligned_words",
                segment_index=None,
                message=f"{unaligned} words had no timestamp and were not placed",
            )
        )

    return words, warnings


def _align(result: Result, media_path: str, language: str, cfg: Settings) -> str | None:
    """Refine word timings with wav2vec2 forced alignment, if it is installed.

    Whisper's own word timestamps come from cross-attention DTW and are good; forced
    alignment against the waveform is better, and better is what makes a single-word replay
    land on the word.

    **Absence is reported, not absorbed.** The returned model id is written to
    ``transcript_files.asr_alignment_model_id``, so a transcript timed by DTW alone is
    distinguishable from one that was aligned — rather than both claiming the same
    precision. That is the same reason ADR 0017 stores the timing tier instead of inferring
    it.
    """
    try:
        import whisperx  # noqa: PLC0415
    except ImportError:
        result.warnings.append(
            Warning_(
                kind="low_asr_confidence",
                segment_index=None,
                message=(
                    "forced alignment unavailable; word timings come from Whisper's "
                    "own attention weights and are less precise"
                ),
            )
        )
        return None

    audio = whisperx.load_audio(media_path)
    align_model, meta = whisperx.load_align_model(
        language_code=language.split("-")[0], device=cfg.device
    )
    # Alignment consumes segments, so the word array is regrouped into one span per
    # contiguous run. The text is not rewritten — only the timings are replaced.
    aligned = whisperx.align(
        [
            {
                "start": result.words[0].start_ms / 1000,
                "end": result.words[-1].end_ms / 1000,
                "text": " ".join(w.text for w in result.words),
            }
        ],
        align_model,
        meta,
        audio,
        cfg.device,
        return_char_alignments=False,
    )

    refined = [w for seg in aligned.get("segments", []) for w in seg.get("words", [])]
    if len(refined) != len(result.words):
        # A length mismatch means the aligner tokenized differently, and pairing them by
        # position would silently bind each word to its neighbour's timing. Keep the DTW
        # timings and say so — a visibly less precise transcript beats a confidently
        # wrong one.
        result.warnings.append(
            Warning_(
                kind="unaligned_words",
                segment_index=None,
                message=(
                    f"aligner returned {len(refined)} words for {len(result.words)}; "
                    "keeping the original timings"
                ),
            )
        )
        return None

    for original, r in zip(result.words, refined, strict=True):
        if r.get("start") is None or r.get("end") is None:
            continue
        original.start_ms = int(round(float(r["start"]) * 1000))
        original.end_ms = int(round(float(r["end"]) * 1000))
        if r.get("score") is not None:
            original.confidence = float(r["score"])

    return meta.get("model_name") if isinstance(meta, dict) else "wav2vec2"
