"""Checks for ``/transcribe`` (ADR 0016).

None of these installs a model. What is testable without gigabytes of weights is exactly
what ADR 0016 §3 is about: **the refusals**. Each of the three cases below is one where the
system would otherwise report success while being wrong, and each is worth more than a
happy-path test that only runs on a machine with a GPU.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from p80_nlp import asr
from p80_nlp.main import app

client = TestClient(app)


def _settings(**overrides) -> asr.Settings:
    base = {
        "model_id": "large-v3",
        "device": "cuda",
        "compute_type": "float16",
        "require_gpu": True,
        "align": True,
        "language_min_probability": 0.5,
    }
    base.update(overrides)
    return asr.Settings(**base)


class TestRefusals:
    def test_missing_model_is_501_not_an_empty_transcript(self, tmp_path) -> None:
        """The whole point of the endpoint's failure design.

        An empty word list is indistinguishable from a video with no speech, and the two
        send a user to completely different places: one to look for a subtitle file, the
        other to look for a bug.
        """
        media = tmp_path / "clip.mp4"
        media.write_bytes(b"not really an mp4")

        response = client.post(
            "/transcribe", json={"media_path": str(media), "language": "de"}
        )

        # 501 when faster-whisper is absent, 503 when it is present but the GPU is not.
        # Both are refusals; neither is a transcript.
        assert response.status_code in (501, 503)
        body = response.json()
        assert body["error"]["code"] == "ASR_UNAVAILABLE"
        assert "words" not in body

    def test_a_path_to_nothing_refuses(self, tmp_path) -> None:
        response = client.post(
            "/transcribe",
            json={"media_path": str(tmp_path / "gone.mp4"), "language": "de"},
        )
        assert response.status_code in (501, 503)
        assert response.json()["error"]["code"] == "ASR_UNAVAILABLE"

    def test_error_message_never_leaks_the_containing_directory(self, tmp_path) -> None:
        """The API resolved this path; the sidecar must not echo it back up.

        A message carrying the absolute path would put the media root into a job record,
        which ``03-api.md`` requires to be free of filesystem paths.
        """
        media = tmp_path / "secret-library" / "clip.mp4"
        media.parent.mkdir()

        response = client.post(
            "/transcribe", json={"media_path": str(media), "language": "de"}
        )

        assert "secret-library" not in response.json()["error"]["message"]


class TestDeviceGuard:
    """CPU fallback is the failure that looks like success for forty minutes."""

    def test_refuses_when_cuda_is_requested_and_unavailable(self, monkeypatch) -> None:
        fake = type("T", (), {"cuda": type("C", (), {"is_available": staticmethod(lambda: False)})})
        monkeypatch.setitem(__import__("sys").modules, "torch", fake)

        with pytest.raises(asr.AsrUnavailable) as exc:
            asr.assert_device(_settings())

        assert "twenty times slower" in str(exc.value)
        # Retryable: the GPU is usually back after a driver reload or another job finishes.
        assert exc.value.retryable is True

    def test_cpu_is_allowed_when_asked_for_deliberately(self) -> None:
        # No exception. Opting in is fine; being silently downgraded is not.
        asr.assert_device(_settings(require_gpu=False))
        asr.assert_device(_settings(device="cpu"))


class TestLanguageGuard:
    """A German profile fed an English video would otherwise get a plausible transcript
    and a curriculum of the wrong language."""

    def test_confident_disagreement_is_an_error(self) -> None:
        result = asr.Result(detected_language="en", language_probability=0.98)

        with pytest.raises(asr.AsrLanguageMismatch) as exc:
            asr._assert_language("de", result, _settings())

        # Both languages named, because either one could be the mistake.
        assert "en" in str(exc.value) and "de" in str(exc.value)

    def test_uncertain_disagreement_is_a_warning_not_an_error(self) -> None:
        result = asr.Result(detected_language="en", language_probability=0.31)

        asr._assert_language("de", result, _settings())

        assert [w.kind for w in result.warnings] == ["low_asr_confidence"]

    def test_regional_variants_agree(self) -> None:
        result = asr.Result(detected_language="de", language_probability=0.99)
        asr._assert_language("de-AT", result, _settings())
        assert result.warnings == []


class TestHealth:
    def test_capabilities_are_reported_separately(self) -> None:
        body = client.get("/health").json()

        assert body["status"] == "ok"
        # Two capabilities, two flags. They arrive at different stages and fail
        # independently, so one flag would let a caller infer the wrong thing.
        assert "annotate_available" in body
        assert "transcribe_available" in body
        assert body["annotate_available"] is False

    def test_asr_model_id_is_absent_when_asr_is(self) -> None:
        body = client.get("/health").json()
        if not body["transcribe_available"]:
            assert body["asr_model_id"] is None


class TestWarningsNeverCarryTranscriptText:
    """ADR 0014: the warning message is persisted forever and re-served on every read,
    which makes it a render surface even though nothing about it looks like one."""

    def test_boilerplate_warning_names_the_pattern_not_the_cue(self) -> None:
        seg = _segment(text="Thanks for watching! Subscribe now.", words=[])

        _words, warnings = asr._collect([seg])

        kinds = [w.kind for w in warnings]
        assert "subtitle_boilerplate" in kinds
        for w in warnings:
            assert "Thanks for watching" not in w.message

    def test_unaligned_words_are_counted_not_dropped_silently(self) -> None:
        seg = _segment(
            text="Ich fange an.",
            words=[_word("Ich", 0.0, 0.2), _word("fange", None, None)],
        )

        words, warnings = asr._collect([seg])

        assert [w.text for w in words] == ["Ich"]
        unaligned = [w for w in warnings if w.kind == "unaligned_words"]
        assert len(unaligned) == 1
        assert "1 words" in unaligned[0].message


def _segment(*, text: str, words: list, no_speech: float = 0.0, logprob: float = 0.0):
    return type(
        "Segment",
        (),
        {
            "text": text,
            "words": words,
            "no_speech_prob": no_speech,
            "avg_logprob": logprob,
        },
    )()


def _word(word: str, start: float | None, end: float | None, probability: float = 0.9):
    return type(
        "Word",
        (),
        {"word": word, "start": start, "end": end, "probability": probability},
    )()
