import pytest
from pydantic import ValidationError

from critique_models import (
    AnalyzeRequest,
    AnalyzeResponse,
    CaptureMetadata,
    Critique,
    Correction,
    HistoryMessage,
    Region,
    ValueMetrics,
)


def grounded_correction(**overrides):
    values = {
        "issue_id": "value-separation",
        "dimension": "value",
        "location": "centro del lienzo",
        "evidence": "El plano central se confunde con el fondo por su valor similar.",
        "consequence": "La forma principal pierde presencia a distancia.",
        "action": "Oscurece el fondo inmediato alrededor de la forma central.",
        "amount": "Un paso de valor",
        "verification": "Entrecierra los ojos y comprueba que la silueta se separa.",
        "confidence": "high",
    }
    values.update(overrides)
    return Correction(**values)


def test_history_rejects_unknown_roles():
    with pytest.raises(ValidationError):
        HistoryMessage(role="assistant", text="hola")


def test_history_rejects_blank_or_oversized_text():
    with pytest.raises(ValidationError):
        HistoryMessage(role="user", text="")
    with pytest.raises(ValidationError):
        HistoryMessage(role="model", text="x" * 4001)


def test_quick_critique_requires_grounded_correction():
    with pytest.raises(ValidationError):
        Critique(frame_usable=True, confidence="high", corrections=[])


def test_usable_critique_allows_one_or_two_corrections_only():
    correction = grounded_correction()
    assert len(
        Critique(frame_usable=True, confidence="high", corrections=[correction]).corrections
    ) == 1
    with pytest.raises(ValidationError):
        Critique(
            frame_usable=True,
            confidence="high",
            corrections=[correction, correction, correction],
        )


def test_unusable_critique_rejects_corrections():
    with pytest.raises(ValidationError):
        Critique(
            frame_usable=False,
            confidence="low",
            corrections=[grounded_correction()],
        )


def test_correction_and_region_enforce_grounding_bounds():
    with pytest.raises(ValidationError):
        grounded_correction(issue_id="Bad id")
    with pytest.raises(ValidationError):
        Region(x=0.9, y=0.5, width=0, height=0.2)
    region = Region(x=0.1, y=0.2, width=0.3, height=0.4)
    assert grounded_correction(region=region).region == region


def test_analyze_request_types_history_and_value_metrics():
    request = AnalyzeRequest(
        image_base64="data:image/png;base64,AAAA",
        critique_mode="next_brushstroke",
        history=[{"role": "user", "text": "Revisa el foco"}],
        value_metrics={"median": 0.48, "clipped_dark_pct": 0.02},
    )
    assert request.history[0].role == "user"
    assert request.value_metrics.median == 0.48

    with pytest.raises(ValidationError):
        AnalyzeRequest(image_base64="x", history=[{"role": "assistant", "text": "no"}])


def test_value_metrics_rejects_percentages_outside_unit_interval():
    with pytest.raises(ValidationError):
        ValueMetrics(clipped_light_pct=1.01)


def test_value_metrics_blur_estimate_is_a_normalized_zero_to_one_scale():
    assert ValueMetrics(blur_estimate=0.0).blur_estimate == 0.0
    assert ValueMetrics(blur_estimate=1.0).blur_estimate == 1.0
    with pytest.raises(ValidationError):
        ValueMetrics(blur_estimate=1.01)

    schema = ValueMetrics.model_json_schema()["properties"]["blur_estimate"]
    assert "normalized" in schema["description"].lower()
    assert "more blur" in schema["description"].lower()


def test_capture_metadata_uses_bounded_stable_capture_enums():
    metadata = CaptureMetadata(
        crop_mode="perspective_rectified",
        crop_source="detected",
        crop_confidence="high",
        width=128,
        height=96,
        mime_type="image/png",
    )

    assert metadata.crop_mode == "perspective_rectified"
    assert metadata.mime_type == "image/png"
    with pytest.raises(ValidationError):
        CaptureMetadata(
            crop_mode="rotated",
            crop_source="detected",
            crop_confidence="high",
            width=128,
            height=96,
            mime_type="image/png",
        )
    with pytest.raises(ValidationError):
        CaptureMetadata(
            crop_mode="full_frame",
            crop_source="none",
            crop_confidence="low",
            width=0,
            height=96,
            mime_type="image/png",
        )
    with pytest.raises(ValidationError, match="24,000,000"):
        CaptureMetadata(
            crop_mode="full_frame",
            crop_source="none",
            crop_confidence="low",
            width=5_000,
            height=5_000,
            mime_type="image/png",
        )


def test_temporal_context_requires_a_previous_image_and_reference_purpose_requires_reference():
    prior = Critique(
        frame_usable=True,
        confidence="high",
        corrections=[grounded_correction()],
    )
    with pytest.raises(ValidationError, match="previous_image_base64"):
        AnalyzeRequest(image_base64="x", previous_value_metrics={"median": 0.3})
    with pytest.raises(ValidationError, match="previous_image_base64"):
        AnalyzeRequest(image_base64="x", previous_critique=prior)
    with pytest.raises(ValidationError, match="image_ref_base64"):
        AnalyzeRequest(image_base64="x", reference_purpose="value")


def test_request_accepts_legacy_payloads_and_bound_temporal_context():
    legacy = AnalyzeRequest(image_base64="x")
    assert legacy.capture_metadata is None
    assert legacy.previous_value_metrics is None
    assert legacy.previous_critique is None

    request = AnalyzeRequest(
        image_base64="x",
        previous_image_base64="previous",
        previous_value_metrics={"median": 0.3},
        previous_critique={
            "frame_usable": True,
            "confidence": "medium",
            "corrections": [grounded_correction().model_dump()],
        },
    )
    assert request.previous_value_metrics.median == 0.3
    assert request.previous_critique.confidence == "medium"


@pytest.mark.parametrize(
    "region",
    [
        {"x": 0.8, "y": 0.1, "width": 0.3, "height": 0.2},
        {"x": 0.1, "y": 0.8, "width": 0.2, "height": 0.3},
    ],
)
def test_region_rejects_bounds_that_extend_beyond_the_normalized_canvas(region):
    with pytest.raises(ValidationError):
        Region(**region)


def test_unusable_critique_requires_capture_problem_and_explanatory_summary():
    with pytest.raises(ValidationError):
        Critique(frame_usable=False, confidence="low", spoken_summary="Reencuadra la foto.")
    with pytest.raises(ValidationError):
        Critique(
            frame_usable=False,
            confidence="low",
            capture_problems=["   "],
            spoken_summary="Reencuadra la foto para que el lienzo completo quede visible.",
        )
    with pytest.raises(ValidationError):
        Critique(
            frame_usable=False,
            confidence="low",
            capture_problems=["La foto está desenfocada."],
            spoken_summary="Corto",
        )


def test_spoken_summary_is_limited_to_90_words():
    with pytest.raises(ValidationError):
        Critique(
            frame_usable=True,
            confidence="high",
            corrections=[grounded_correction()],
            spoken_summary="palabra " * 91,
        )


def test_critique_validates_the_correction_count_for_the_requested_mode():
    deep_request = AnalyzeRequest(image_base64="x", critique_mode="deep")
    quick_request = AnalyzeRequest(image_base64="x", critique_mode="next_brushstroke")
    critique = Critique(
        frame_usable=True,
        confidence="high",
        observations={
            "drawing": "La dirección del dibujo es legible.",
            "composition": "El foco está concentrado.",
            "shape": "La masa principal se sostiene.",
            "value": "La forma se separa del fondo.",
            "color": "La temperatura crea contraste.",
            "edges": "Los bordes tienen jerarquía.",
            "handling": "La pincelada mantiene dirección.",
        },
        corrections=[grounded_correction(), grounded_correction(issue_id="edge-contrast")],
    )

    with pytest.raises(ValueError, match="exactly one"):
        critique.validate_for_request(quick_request)
    assert critique.validate_for_request(deep_request) is critique


def test_quick_critique_requires_a_spoken_summary():
    request = AnalyzeRequest(image_base64="x", critique_mode="next_brushstroke")
    critique = Critique(
        frame_usable=True,
        confidence="high",
        corrections=[grounded_correction()],
    )

    with pytest.raises(ValueError, match="spoken_summary"):
        critique.validate_for_request(request)


def test_capture_problems_and_observations_reject_empty_strings():
    with pytest.raises(ValidationError):
        Critique(
            frame_usable=False,
            confidence="low",
            capture_problems=[""],
            spoken_summary="Reencuadra la foto y enfoca bien todo el lienzo antes de enviarla.",
        )
    with pytest.raises(ValidationError):
        Critique(
            frame_usable=True,
            confidence="high",
            corrections=[grounded_correction()],
            observations={"value": " "},
        )


def test_response_rejects_negative_image_dimensions():
    critique = Critique(
        frame_usable=True, confidence="high", corrections=[grounded_correction()]
    )
    with pytest.raises(ValidationError):
        AnalyzeResponse(
            critique=critique,
            request_id="request-1",
            model="test-model",
            prompt_version="v1",
            latency_ms=0,
            image_dimensions={"current": (-1, 96)},
        )
