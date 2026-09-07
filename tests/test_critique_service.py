import json
from types import SimpleNamespace

import pytest

from critique_models import AnalyzeRequest
from image_utils import DecodedImage


def make_request(**overrides):
    values = {
        "image_base64": "current",
        "critique_mode": "deep",
        "history": [{"role": "user", "text": "Mira el contraste."}],
    }
    if overrides.pop("previous", False):
        values["previous_image_base64"] = "previous"
    if overrides.pop("reference", False):
        values["image_ref_base64"] = "reference"
    values.update(overrides)
    return AnalyzeRequest(**values)


def make_images(*, previous=True, reference=True, bw=True):
    images = {"current": DecodedImage(b"current", "image/png", 128, 96)}
    if bw:
        images["bw"] = DecodedImage(b"bw", "image/png", 128, 96)
    if previous:
        images["previous"] = DecodedImage(b"previous", "image/jpeg", 128, 96)
    if reference:
        images["reference"] = DecodedImage(b"reference", "image/webp", 128, 96)
    return images


def valid_critique_json(**overrides):
    payload = {
        "frame_usable": True,
        "confidence": "high",
        "inferred_stage": "block-in",
        "observations": {
            "drawing": "La silueta principal mantiene una dirección legible en el plano.",
            "composition": "El centro de interés está concentrado en el área central.",
            "shape": "La forma dominante conserva una masa continua y reconocible.",
            "value": "La forma clara tiene un borde visible contra el fondo medio.",
            "color": "La temperatura cálida del plano central contrasta con el fondo.",
            "edges": "El borde central está más definido que los bordes periféricos.",
            "handling": "Las pinceladas del centro siguen una dirección coherente.",
        },
        "corrections": [
            {
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
        ],
        "spoken_summary": "Primero separa la forma central del fondo con un valor más oscuro alrededor.",
    }
    payload.update(overrides)
    return json.dumps(payload)


class FakeModels:
    def __init__(self):
        self.responses = []
        self.calls = []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        return self.responses.pop(0)


class FakeClient:
    def __init__(self):
        self.models = FakeModels()

    def queue(self, *texts):
        self.models.responses.extend(SimpleNamespace(text=text) for text in texts)


@pytest.fixture
def fake_client():
    return FakeClient()


def text_of(part):
    return part.text


def has_text(part):
    return bool(getattr(part, "text", None))


def serialized_prompt(contents):
    return "\n".join(
        part.text
        for content in contents
        for part in content.parts
        if has_text(part)
    )


def test_prompt_labels_media_in_order():
    from critique_service import build_contents

    contents = build_contents(make_request(previous=True, reference=True), make_images())
    current = contents[-1].parts

    assert [text_of(part) for part in current if has_text(part)][:4] == [
        "CURRENT PAINTING — COLOR",
        "CURRENT PAINTING — BLACK AND WHITE",
        "PREVIOUS PAINTING — COLOR",
        "REFERENCE IMAGE",
    ]


def test_prompt_forbids_temporal_claim_without_previous():
    from critique_service import build_contents

    prompt = serialized_prompt(
        build_contents(make_request(previous=False), make_images(previous=False))
    )

    assert "Do not claim that the painting changed" in prompt


def test_prompt_includes_declared_capture_and_prior_context_only_with_previous_image():
    from critique_service import build_contents

    request = make_request(
        previous=True,
        capture_metadata={
            "crop_mode": "perspective_rectified",
            "crop_source": "detected",
            "crop_confidence": "high",
            "width": 128,
            "height": 96,
            "mime_type": "image/png",
        },
        value_metrics={"blur_estimate": 0.2},
        previous_value_metrics={"blur_estimate": 0.7, "median": 0.2},
        previous_critique={
            "frame_usable": True,
            "confidence": "medium",
            "corrections": [json.loads(valid_critique_json())["corrections"][0]],
        },
    )

    prompt = serialized_prompt(build_contents(request, make_images()))

    assert "capture_metadata:" in prompt
    assert "perspective_rectified" in prompt
    assert "blur_estimate" in prompt
    assert "previous_camera_value_estimates" in prompt
    assert "prior_critique_pedagogical_context" in prompt
    assert "not visual proof" in prompt


def test_prompt_omits_prior_metrics_and_critique_labels_without_previous_image():
    from critique_service import build_contents

    prompt = serialized_prompt(
        build_contents(make_request(previous=False), make_images(previous=False))
    )

    assert "previous_camera_value_estimates" not in prompt
    assert "prior_critique_pedagogical_context" not in prompt


def test_prompt_does_not_duplicate_history_in_session_context():
    from critique_service import build_contents

    contents = build_contents(make_request(), make_images())
    prompt = serialized_prompt(contents)

    assert "conversation_history:" not in prompt
    assert prompt.count("Mira el contraste.") == 1


def test_prompt_requires_rioplatense_spanish_for_user_facing_text():
    from critique_service import SYSTEM_INSTRUCTION

    assert "español rioplatense" in SYSTEM_INSTRUCTION.lower()
    assert "JSON" in SYSTEM_INSTRUCTION


def test_invalid_first_response_is_repaired(fake_client):
    from critique_service import generate_critique

    fake_client.queue("Bien.", valid_critique_json())

    result = generate_critique(fake_client, "test-model", make_request(), make_images())

    assert result.attempts == 2
    assert result.critique.corrections[0].evidence
    second_contents = fake_client.models.calls[1]["contents"]
    first_contents = fake_client.models.calls[0]["contents"]
    assert len(second_contents) == len(first_contents)
    assert [content.role for content in second_contents] == [content.role for content in first_contents]
    repair_text = [part.text for part in second_contents[-1].parts if has_text(part)][-1]
    assert "validation errors" in repair_text
    assert "Bien." not in repair_text
    assert sum(not has_text(part) for part in second_contents[-1].parts) == sum(
        not has_text(part) for part in first_contents[-1].parts
    )


def test_two_invalid_responses_raise_upstream_error(fake_client):
    from critique_service import InvalidModelResponse, generate_critique

    fake_client.queue("", "{}")

    with pytest.raises(InvalidModelResponse):
        generate_critique(fake_client, "test-model", make_request(), make_images())


def test_service_applies_mode_specific_validation(fake_client):
    from critique_service import InvalidModelResponse, generate_critique

    two_corrections = json.loads(valid_critique_json())
    second = two_corrections["corrections"][0].copy()
    second["issue_id"] = "edge-contrast"
    two_corrections["corrections"].append(second)
    fake_client.queue(json.dumps(two_corrections), json.dumps(two_corrections))

    with pytest.raises(InvalidModelResponse):
        generate_critique(
            fake_client,
            "test-model",
            make_request(critique_mode="next_brushstroke"),
            make_images(),
        )


def test_deep_critique_requires_observations_across_design_dimensions(fake_client):
    from critique_service import InvalidModelResponse, generate_critique

    payload = json.loads(valid_critique_json())
    payload["observations"] = {"value": payload["observations"]["value"]}
    fake_client.queue(json.dumps(payload), json.dumps(payload))

    with pytest.raises(InvalidModelResponse):
        generate_critique(fake_client, "test-model", make_request(), make_images())


def test_quick_critique_requires_spoken_summary(fake_client):
    from critique_service import InvalidModelResponse, generate_critique

    payload = json.loads(valid_critique_json())
    payload["observations"] = {}
    payload["spoken_summary"] = None
    fake_client.queue(json.dumps(payload), json.dumps(payload))

    with pytest.raises(InvalidModelResponse):
        generate_critique(
            fake_client,
            "test-model",
            make_request(critique_mode="next_brushstroke"),
            make_images(),
        )
