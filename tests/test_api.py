import base64
import io
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from critique_models import Critique, Correction


def image_data_url():
    output = io.BytesIO()
    Image.new("RGB", (128, 96), color=(45, 80, 120)).save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def response_critique():
    return Critique(
        frame_usable=True,
        confidence="high",
        spoken_summary="Separá la forma central del fondo con un valor más oscuro.",
        corrections=[
            Correction(
                issue_id="value-separation",
                dimension="value",
                location="centro del lienzo",
                evidence="El plano central se confunde con el fondo por su valor similar.",
                consequence="La forma principal pierde presencia a distancia.",
                action="Oscurece el fondo inmediato alrededor de la forma central.",
                amount="Un paso de valor",
                verification="Entrecierra los ojos y comprueba que la silueta se separa.",
                confidence="high",
            )
        ],
    )


@pytest.fixture
def valid_request():
    return {"image_base64": image_data_url(), "critique_mode": "next_brushstroke"}


@pytest.fixture
def client(monkeypatch):
    import app

    monkeypatch.setattr(app, "get_client", lambda api_key: SimpleNamespace())
    tc = TestClient(app.app)
    original_post = tc.post

    def _clearing_post(*args, **kwargs):
        app._rate_hits.clear()
        app._RATE_NEXT_PRUNE = 0.0
        return original_post(*args, **kwargs)

    tc.post = _clearing_post
    return tc


def test_api_rejects_bad_auxiliary_image(client, valid_request):
    valid_request["image_ref_base64"] = "%%%%"

    response = client.post("/api/analyze", json=valid_request)

    assert response.status_code == 422
    assert response.json()["detail"]["field"] == "reference"


def test_api_returns_502_for_invalid_model_output(client, monkeypatch, valid_request):
    import app
    from critique_service import InvalidModelResponse

    def raise_invalid_model_response(*args, **kwargs):
        raise InvalidModelResponse("model response did not match the critique contract")

    monkeypatch.setattr(app, "generate_critique", raise_invalid_model_response)

    assert client.post("/api/analyze", json=valid_request).status_code == 502


def test_api_returns_structured_response_and_image_metadata(client, monkeypatch, valid_request):
    import app
    from critique_service import GenerationResult

    monkeypatch.setattr(
        app,
        "generate_critique",
        lambda *args, **kwargs: GenerationResult(
            critique=response_critique(),
            attempts=1,
            finish_reason="STOP",
            input_tokens=101,
            output_tokens=202,
        ),
    )

    response = client.post("/api/analyze", json=valid_request)

    assert response.status_code == 200
    body = response.json()
    assert body["critique"]["corrections"][0]["issue_id"] == "value-separation"
    assert body["image_dimensions"] == {"current": [128, 96]}
    assert body["auxiliary_images_used"] == []


@pytest.mark.parametrize(
    ("metadata", "reason"),
    [
        (
            {
                "crop_mode": "full_frame",
                "crop_source": "none",
                "crop_confidence": "high",
                "width": 127,
                "height": 96,
                "mime_type": "image/png",
            },
            "width",
        ),
        (
            {
                "crop_mode": "full_frame",
                "crop_source": "none",
                "crop_confidence": "high",
                "width": 128,
                "height": 95,
                "mime_type": "image/png",
            },
            "height",
        ),
        (
            {
                "crop_mode": "full_frame",
                "crop_source": "none",
                "crop_confidence": "high",
                "width": 128,
                "height": 96,
                "mime_type": "image/jpeg",
            },
            "MIME",
        ),
    ],
)
def test_api_rejects_capture_metadata_that_does_not_match_decoded_current_image(
    client, valid_request, metadata, reason
):
    valid_request["capture_metadata"] = metadata

    response = client.post("/api/analyze", json=valid_request)

    assert response.status_code == 422
    assert response.json()["detail"]["field"] == "capture_metadata"
    assert reason.lower() in response.json()["detail"]["reason"].lower()


def test_api_rejects_deep_response_without_dimension_observations(client, monkeypatch, valid_request):
    import app
    from critique_service import GenerationResult

    valid_request["critique_mode"] = "deep"
    monkeypatch.setattr(
        app,
        "generate_critique",
        lambda *args, **kwargs: GenerationResult(
            critique=response_critique(), attempts=1
        ),
    )

    response = client.post("/api/analyze", json=valid_request)

    assert response.status_code == 502


def test_api_default_cors_allows_localhost_and_rejects_other_origins(client):
    allowed = client.options(
        "/api/analyze",
        headers={
            "Origin": "http://localhost:8000",
            "Access-Control-Request-Method": "POST",
        },
    )
    denied = client.options(
        "/api/analyze",
        headers={
            "Origin": "https://untrusted.example",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert allowed.headers.get("access-control-allow-origin") == "http://localhost:8000"
    assert "access-control-allow-origin" not in denied.headers


@pytest.mark.parametrize(
    ("message", "status"),
    [
        ("API_KEY_INVALID", 401),
        ("429 quota exceeded", 429),
        ("503 service unavailable", 503),
    ],
)
def test_api_maps_provider_failures(client, monkeypatch, valid_request, message, status):
    import app

    if status == 401:
        monkeypatch.setattr(app, "get_client", lambda api_key: (_ for _ in ()).throw(RuntimeError(message)))
    else:
        monkeypatch.setattr(
            app,
            "generate_critique",
            lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError(message)),
        )

    assert client.post("/api/analyze", json=valid_request).status_code == status
