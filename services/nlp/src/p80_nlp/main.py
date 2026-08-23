"""P80 NLP sidecar.

ADR 0002: spaCy behind ``LanguageAdapter``, in a Python process, because Stage 4 needs
lemmatization, POS tagging, NER, **and a dependency parse** for German, and no TypeScript
library delivers all four. The deviation from spec §26.1's all-TypeScript monorepo is
narrow and contained: this service is stateless, exposes one narrow HTTP interface
matching ``LanguageAdapter.annotate``, and is reachable on loopback only.

``/annotate`` is still the Stage 4 stub and returns 501. spaCy and ``de_core_news_lg``
arrive with it — installing a 500 MB model to serve a placeholder would be paying Stage 4's
setup cost early.

``/transcribe`` is real (ADR 0016). It is here rather than in a fifth process because
ADR 0002 already drew the boundary at *Python only where the models are*. It differs from
the annotation endpoints in one way that matters operationally: an ASR call holds this
process for minutes, while ``annotate`` is called per sentence. ``04-providers.md`` §2
records the condition that splits it out.

One thing every endpoint here must get right: a sidecar that is **down or unimplemented
must fail visibly**. It must never degrade into whitespace tokenization or an empty
transcript. Spec §35 Stage 4 requires annotation failures to be visible rather than
silently ignored, and a plausible-looking wrong result is the hardest kind of bug to trace
— every downstream symptom points somewhere else.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from p80_nlp import asr

SERVICE_VERSION = "0.0.0"

# Recorded in pipeline_versions.language_adapter_version once a model is loaded, so
# annotations stay recomputable and comparable across a model change (§27.5).
MODEL_ID: str | None = None

app = FastAPI(
    title="P80 NLP sidecar",
    version=SERVICE_VERSION,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


class Health(BaseModel):
    status: str
    service: str = "nlp"
    version: str
    model_id: str | None = Field(
        default=None,
        description="Null until Stage 4 loads de_core_news_lg.",
    )
    annotate_available: bool
    transcribe_available: bool = False
    asr_model_id: str | None = None


class AnnotateRequest(BaseModel):
    language: str
    sentences: list[str]


class TranscribeOptions(BaseModel):
    """Per-request transcription settings (ADR 0019 §5).

    Every field is optional and an absent one keeps the sidecar's own default, so a caller
    states only what it wants to change. P80 itself always sends all six: the settings
    surface resolves them from the database, which is what makes them editable without
    restarting this process.
    """

    model: str | None = None
    device: str | None = None
    compute_type: str | None = None
    require_gpu: bool | None = None
    align: bool | None = None
    language_min_probability: float | None = Field(default=None, ge=0.0, le=1.0)
    condition_on_previous_text: bool | None = None


class TranscribeRequest(BaseModel):
    """The path arrives absolute and already contained under ``P80_MEDIA_ROOT`` by the
    caller (``CLAUDE.md`` rule 4). Containment is checked once, where the untrusted value
    enters the system, rather than re-derived at every layer — a second check against a
    root this process does not own would be a second answer to the same question."""

    media_path: str
    language: str
    options: TranscribeOptions | None = None


@app.get("/health", response_model=Health)
def health() -> Health:
    """Reports readiness honestly, one flag per capability.

    ``status`` is ``ok`` because the process is up and answering. Each capability is
    separate, because they arrive at different stages and fail independently — collapsing
    them into one flag would let a caller with a working ASR model believe annotation works
    too.
    """
    asr_settings = asr.Settings.from_env()
    asr_ready = asr.available(asr_settings)
    return Health(
        status="ok",
        version=SERVICE_VERSION,
        model_id=MODEL_ID,
        annotate_available=MODEL_ID is not None,
        transcribe_available=asr_ready,
        asr_model_id=asr_settings.model_id if asr_ready else None,
    )


@app.post("/annotate")
def annotate(request: AnnotateRequest) -> JSONResponse:
    """Not implemented until Stage 4.

    Returns 501 with an actionable message rather than an empty token list. An empty
    list is indistinguishable from "this sentence had no tokens", which is exactly the
    silent degradation ADR 0002 forbids.
    """
    return JSONResponse(
        status_code=501,
        content={
            "error": {
                "code": "NOT_IMPLEMENTED",
                "message": (
                    "Annotation is not implemented yet. The spaCy model is installed in "
                    "Stage 4; until then the NLP sidecar serves transcription and health "
                    "checks only."
                ),
                "details": {"language": request.language, "stage": 4},
                "retryable": False,
            }
        },
    )


@app.post("/transcribe")
def transcribe(request: TranscribeRequest) -> JSONResponse:
    """Media file -> flat word array with per-word timing (ADR 0016).

    Every failure below is a refusal with a reason. None of them returns a partial or empty
    transcript, because a caller cannot tell an empty transcript from a silent video, and
    the difference decides whether a user goes looking for a subtitle file or for a bug.
    """
    settings = asr.Settings.from_env().merged(
        request.options.model_dump() if request.options else None
    )

    try:
        result = asr.transcribe(request.media_path, request.language, settings)
    except asr.AsrLanguageMismatch as exc:
        return _error(409, "ASR_LANGUAGE_MISMATCH", str(exc), retryable=False)
    except asr.AsrUnavailable as exc:
        # 501 means "install something"; 503 means "try again". The client maps the two
        # differently: one offers the upload fallback, the other schedules a retry.
        status = 503 if exc.retryable else 501
        return _error(status, "ASR_UNAVAILABLE", str(exc), retryable=exc.retryable)
    except Exception as exc:  # noqa: BLE001 — the boundary; nothing above catches this
        return _error(500, "ASR_FAILED", f"Transcription failed: {exc}", retryable=True)

    return JSONResponse(
        content={
            "words": [
                {
                    "text": w.text,
                    "start_ms": w.start_ms,
                    "end_ms": w.end_ms,
                    "confidence": w.confidence,
                }
                for w in result.words
            ],
            "detected_language": result.detected_language,
            "language_probability": result.language_probability,
            "duration_ms": result.duration_ms,
            "warnings": [
                {"kind": w.kind, "segment_index": w.segment_index, "message": w.message}
                for w in result.warnings
            ],
            "model_id": result.model_id,
            "alignment_model_id": result.alignment_model_id,
        }
    )


def _error(status: int, code: str, message: str, *, retryable: bool) -> JSONResponse:
    """The same envelope shape ``03-api.md`` §1 defines, so the sidecar's failures and the
    API's read identically in a log."""
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message, "retryable": retryable}},
    )
