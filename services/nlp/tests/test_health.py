"""Stage 1 checks for the sidecar.

The 501 test is the one that matters. ADR 0002 makes annotation quality load-bearing for
three later stages, and its named failure mode is silent degradation — a sidecar that
answers with something plausible instead of admitting it cannot answer. This asserts the
stub refuses rather than returns an empty token list.
"""

from fastapi.testclient import TestClient

from p80_nlp.main import app

client = TestClient(app)


def test_health_reports_up_but_not_capable() -> None:
    response = client.get("/health")
    assert response.status_code == 200

    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "nlp"
    # Up and answering is not the same as able to annotate. Collapsing these two would
    # let a caller believe annotation works.
    assert body["annotate_available"] is False
    assert body["model_id"] is None


def test_annotate_refuses_rather_than_returning_empty_tokens() -> None:
    response = client.post(
        "/annotate",
        json={"language": "de", "sentences": ["Ich fange um acht Uhr an."]},
    )
    assert response.status_code == 501

    error = response.json()["error"]
    assert error["code"] == "NOT_IMPLEMENTED"
    assert error["retryable"] is False
    # No token list of any kind — an empty one is indistinguishable from a sentence that
    # genuinely had no tokens.
    assert "tokens" not in response.json()


def test_no_openapi_surface_is_exposed() -> None:
    # Loopback-only service with one narrow interface. There is nothing to browse.
    assert client.get("/openapi.json").status_code == 404
    assert client.get("/docs").status_code == 404
