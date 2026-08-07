"""P80 NLP sidecar.

ADR 0002: spaCy behind ``LanguageAdapter``, in a Python process, because Stage 4 needs
lemmatization, POS tagging, NER, **and a dependency parse** for German, and no TypeScript
library delivers all four. The deviation from spec §26.1's all-TypeScript monorepo is
narrow and contained: this service is stateless, exposes one narrow HTTP interface
matching ``LanguageAdapter.annotate``, and is reachable on loopback only.

**Stage 1 ships the stub.** ``/health`` is real; ``/annotate`` returns 501. spaCy and
``de_core_news_lg`` arrive in Stage 4 — installing a 500 MB model to serve a placeholder
would be paying Stage 4's setup cost five stages early.

One thing this stub must get right, because Stage 4 depends on it: a sidecar that is
**down or unimplemented must fail visibly**. It must never degrade into whitespace
tokenization. Spec §35 Stage 4 requires annotation failures to be visible rather than
silently ignored, and a plausible-looking wrong lemma is the hardest kind of bug to trace
— every downstream symptom points somewhere else.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

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


class AnnotateRequest(BaseModel):
    language: str
    sentences: list[str]


@app.get("/health", response_model=Health)
def health() -> Health:
    """Reports readiness honestly.

    ``status`` is ``ok`` because the process is up and answering. ``annotate_available``
    is separate and false, because the capability is not there. Collapsing the two would
    let a caller believe annotation works.
    """
    return Health(
        status="ok",
        version=SERVICE_VERSION,
        model_id=MODEL_ID,
        annotate_available=MODEL_ID is not None,
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
                    "Stage 4; until then the NLP sidecar answers health checks only."
                ),
                "details": {"language": request.language, "stage": 4},
                "retryable": False,
            }
        },
    )
