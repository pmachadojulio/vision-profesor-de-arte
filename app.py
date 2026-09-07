"""FastAPI entry point for the grounded art critique service."""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from critique_models import AnalyzeRequest, AnalyzeResponse
from critique_service import PROMPT_VERSION, InvalidModelResponse, generate_critique
from image_utils import ImageValidationError, decode_image

try:
    from google.genai import types as genai_types
except ImportError:  # pragma: no cover
    genai_types = None  # type: ignore[assignment]


load_dotenv()

try:
    from google import genai

    HAS_GENAI = True
except ImportError:  # pragma: no cover - exercised only in minimal installs
    genai = None
    HAS_GENAI = False


MODEL_DEFAULT = "gemini-3-flash-preview"
BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(exist_ok=True)

# The UI consumes this endpoint; the service applies only short directional
# principles after its evidence-first diagnosis.
STYLE_PROMPTS = {
    "andrew_cadima": "Atmospheric depth, restrained earth palette, soft-to-controlled edges.",
    "rembrandt": "Value-led chiaroscuro, selective impasto in light, lost edges in shadow.",
    "sorolla": "Vibrant Mediterranean light, warm whites, temperature shifts in brushwork.",
    "zorn": "Limited warm palette, decisive drawing, economical value-led marks.",
    "libre": "Fundamentals: drawing, value, color, edges, composition, and handling.",
}


def _allowed_origins() -> list[str]:
    configured = os.getenv("APP_ALLOWED_ORIGINS", "")
    origins = [item.strip() for item in configured.split(",") if item.strip()]
    return origins or ["http://127.0.0.1:8000", "http://localhost:8000"]


app = FastAPI(title="Vision Profesor de Arte")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ── #5 Total body size limit (80 MB) ─────────────────────────────────
MAX_TOTAL_BODY_BYTES = 80 * 1024 * 1024


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    cl_header = request.headers.get("content-length")
    if cl_header is not None:
        try:
            cl = int(cl_header)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header")
        if cl > MAX_TOTAL_BODY_BYTES:
            raise HTTPException(status_code=413, detail="Request body too large")
    else:
        body_preview = await request.body()
        if len(body_preview) > MAX_TOTAL_BODY_BYTES:
            raise HTTPException(status_code=413, detail="Request body too large")
    return await call_next(request)


# ── #3 Rate limiter (sliding window, per IP) ─────────────────────────
_RATE_WINDOW = 60  # seconds
_RATE_MAX = 6  # requests per window
_rate_hits: dict[str, list[float]] = defaultdict(list)
_RATE_NEXT_PRUNE = 0.0  # monotonic time for next sweep


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_prune() -> None:
    """Remove stale entries periodically to avoid unbounded growth."""
    global _RATE_NEXT_PRUNE
    now = time.monotonic()
    if now < _RATE_NEXT_PRUNE:
        return
    _RATE_NEXT_PRUNE = now + _RATE_WINDOW
    window_start = now - _RATE_WINDOW
    stale = [k for k, v in _rate_hits.items() if not v or v[-1] <= window_start]
    for k in stale:
        del _rate_hits[k]


def _check_rate_limit(ip: str) -> None:
    now = time.monotonic()
    window_start = now - _RATE_WINDOW
    _rate_hits[ip] = [t for t in _rate_hits[ip] if t > window_start]
    if len(_rate_hits[ip]) >= _RATE_MAX:
        raise HTTPException(status_code=429, detail="Too many requests; try again in a moment")
    _rate_hits[ip].append(now)


def get_client(api_key: str | None) -> Any:
    key = api_key or os.getenv("GEMINI_API_KEY")
    if not key:
        raise HTTPException(status_code=401, detail="GEMINI_API_KEY is required")
    if not HAS_GENAI or genai is None:
        raise HTTPException(status_code=500, detail="google-genai is not installed")
    return genai.Client(api_key=key)


def _decode_images(request: AnalyzeRequest) -> dict[str, Any]:
    supplied = {
        "current": request.image_base64,
        "bw": request.image_bw_base64,
        "previous": request.previous_image_base64,
        "reference": request.image_ref_base64,
    }
    images: dict[str, Any] = {}
    for field, data in supplied.items():
        if data is None:
            continue
        images[field] = decode_image(data, field_name=field)
    return images


def _verify_capture_metadata(request: AnalyzeRequest, current_image: Any) -> None:
    """Ensure capture claims describe the exact decoded current image."""

    metadata = request.capture_metadata
    if metadata is None:
        return
    if metadata.width != current_image.width:
        raise HTTPException(
            status_code=422,
            detail={
                "field": "capture_metadata",
                "reason": "declared width does not match decoded current image",
            },
        )
    if metadata.height != current_image.height:
        raise HTTPException(
            status_code=422,
            detail={
                "field": "capture_metadata",
                "reason": "declared height does not match decoded current image",
            },
        )
    if metadata.mime_type != current_image.mime_type:
        raise HTTPException(
            status_code=422,
            detail={
                "field": "capture_metadata",
                "reason": "declared MIME does not match decoded current image",
            },
        )


def _provider_http_error(error: Exception) -> HTTPException:
    lowered = str(error).lower()
    error_name = type(error).__name__.lower()
    if any(token in lowered for token in ("api_key_invalid", "api key", "unauthenticated", "authentication")) or any(
        token in error_name for token in ("auth", "permission", "unauthenticated")
    ):
        return HTTPException(status_code=401, detail="Gemini authentication failed")
    if any(token in lowered for token in ("quota", "resource_exhausted", "429")) or "quota" in error_name:
        return HTTPException(status_code=429, detail="Gemini quota is unavailable")
    if any(token in lowered for token in ("503", "unavailable", "high demand", "busy")) or any(
        token in error_name for token in ("busy", "unavailable")
    ):
        return HTTPException(status_code=503, detail="Gemini is temporarily unavailable")
    return HTTPException(status_code=502, detail="Gemini returned an upstream error")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/styles")
def list_styles() -> dict[str, str]:
    return STYLE_PROMPTS


@app.get("/api/health")
async def health() -> dict[str, Any]:
    base = {
        "ok": True,
        "has_genai": HAS_GENAI,
        "has_env_key": bool(os.getenv("GEMINI_API_KEY")),
        "model": os.getenv("GEMINI_MODEL", MODEL_DEFAULT),
    }
    # Quick Gemini connectivity probe when the env key is present.
    env_key = os.getenv("GEMINI_API_KEY")
    if env_key and HAS_GENAI and genai is not None:
        try:
            client = genai.Client(api_key=env_key)
            model = os.getenv("GEMINI_MODEL", MODEL_DEFAULT)
            await asyncio.wait_for(
                asyncio.to_thread(
                    lambda: client.models.generate_content(
                        model=model,
                        contents=[genai_types.Part.from_text(text="ping")],
                    )
                ),
                timeout=10,
            )
            base["gemini_reachable"] = True
        except Exception:
            base["gemini_reachable"] = False
    else:
        base["gemini_reachable"] = None
    return base


@app.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze(request: AnalyzeRequest, raw: Request) -> AnalyzeResponse:
    request_id = str(uuid.uuid4())
    started = time.perf_counter()
    _rate_prune()
    _check_rate_limit(_client_ip(raw))

    try:
        images = _decode_images(request)
    except ImageValidationError as error:
        raise HTTPException(
            status_code=422,
            detail={"field": error.field_name, "reason": error.reason},
        ) from error

    _verify_capture_metadata(request, images["current"])

    if request.style not in STYLE_PROMPTS:
        request = request.model_copy(update={"style": "libre"})

    model = os.getenv("GEMINI_MODEL", MODEL_DEFAULT)
    try:
        client = get_client(request.api_key)
        result = await asyncio.wait_for(
            asyncio.to_thread(generate_critique, client, model, request, images),
            timeout=45,
        )
        result.critique.validate_for_request(request)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Gemini request timed out")
    except InvalidModelResponse as error:
        raise HTTPException(status_code=502, detail="Gemini returned invalid critique JSON") from error
    except ValueError as error:
        raise HTTPException(status_code=502, detail="Gemini returned an incomplete critique") from error
    except HTTPException:
        raise
    except Exception as error:
        raise _provider_http_error(error) from error

    dimensions = {
        name: (image.width, image.height)
        for name, image in images.items()
    }
    auxiliary = [name for name in ("bw", "previous", "reference") if name in images]
    latency_ms = max(0, round((time.perf_counter() - started) * 1000))
    return AnalyzeResponse(
        critique=result.critique,
        request_id=request_id,
        model=model,
        prompt_version=PROMPT_VERSION,
        latency_ms=latency_ms,
        finish_reason=result.finish_reason,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        image_dimensions=dimensions,
        auxiliary_images_used=auxiliary,
    )


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
