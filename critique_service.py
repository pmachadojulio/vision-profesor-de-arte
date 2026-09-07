"""Prompt construction and structured Gemini invocation for grounded critiques."""

from __future__ import annotations

from dataclasses import dataclass
import json
import time
from typing import Any, Mapping

from google.genai import types
from pydantic import ValidationError

from critique_models import AnalyzeRequest, Critique
from image_utils import DecodedImage
from professor_prompt import PROFESSOR_PROMPT


PROMPT_VERSION = "professor-v1"

TECHNICAL_CONTRACT = """You are running inside a backend API that returns structured JSON. Return only JSON
matching the supplied Critique schema. Keep technical JSON field names exactly as defined by the
Critique schema; do not translate or rename those fields.

QUALITY GATE: first decide whether the submitted current frame is usable. If it is blurry, too dark,
cropped, obstructed, or does not show enough of the canvas, set frame_usable=false, list the concrete
capture problems, provide no corrections, and give a clear recapture instruction. Do not invent what
cannot be seen.

OUTPUT FORMAT — map the realtime lesson onto the schema:
- evidence / consequence = DIAGNÓSTICO: what is happening and why it matters.
- location (+ region when the spot is precise) = UBICACIÓN.
- action = PRIORIDAD 1 + APLICACIÓN: the single next correction, concrete, ordered, directive, safe,
  and reversible. State explicitly what must NOT be touched (NO TOCAR) for the student to preserve.
- mixture = MEZCLA: the exact palette, tool, or technique ("tierra de sombra + un punto de índigo"),
  never a bare commercial color name.
- amount = VALOR: quantity using the mental 1-5 value ladder (1 = darkest, 5 = lightest) or a concrete
  step ("un paso de valor"), always with direction and pace.
- verification = DESPUÉS: a 30-to-60-second check the student performs after the stroke.
- strength = the strength on the canvas that already works and should be preserved.
- spoken_summary = the spoken verdict: the one thing the student does right now, under 90 words.

RULES OF THE PROFESSOR: establish the likely stage and the painter's intention before diagnosing. Write
visible evidence before each diagnosis. Rank candidate issues by impact, structural dependency,
suitability to the requested stage, confidence, and reversibility. Return one primary correction and at
most one immediately dependent follow-up. Count corrections according to the requested critique mode.
Name ambiguous objects as possibilities rather than facts. Use the requested style only as a short
directional principle after the foundational diagnosis; style must never replace evidence.

Global value metrics are camera estimates: use them to corroborate localized visual evidence, never to
override the image or an intentional high-key/low-key design. Explain uncertainty when evidence is weak.
blur_estimate is normalized from 0 to 1, where larger values mean more blur. Use it only as a camera
estimate, not as a substitute for visible focus evidence.
Only compare change across time when a previous painting image is supplied. Do not claim that the
painting changed when no previous image is present. When comparing, mark progress as + (avanzó),
− (retrocedió) or = (quedó igual) in value, color, drawing, and handling inside the diagnosis.

All user-facing critique text (spoken_summary, observations, strength, capture_problems, and correction
prose) must be natural español rioplatense, warm, direct, and demanding — never empty praise, never
vague abstraction. Respect the requested critique mode and its correction-count rules. Keep
spoken_summary concise (90 words or fewer), actionable, and complete.
"""

SYSTEM_INSTRUCTION = f"""{PROFESSOR_PROMPT}

{TECHNICAL_CONTRACT}"""


class InvalidModelResponse(RuntimeError):
    """The provider returned JSON that did not satisfy the critique contract."""


@dataclass(frozen=True)
class GenerationResult:
    critique: Critique
    attempts: int
    finish_reason: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None


STYLE_PRINCIPLES = {
    "andrew_cadima": "Use atmospheric depth, a restrained earth palette, and soft-to-controlled edges.",
    "rembrandt": "Use value-led chiaroscuro, selective impasto in light, and lost edges in shadow.",
    "sorolla": "Use vibrant Mediterranean light, warm whites, and temperature shifts in the brushwork.",
    "zorn": "Use a limited warm palette, decisive drawing, and economical value-led marks.",
    "libre": "Stay with fundamentals of drawing, value, color, edges, composition, and handling.",
}


def _text_part(text: str) -> types.Part:
    return types.Part.from_text(text=text)


def _image_part(image: DecodedImage) -> types.Part:
    return types.Part.from_bytes(data=image.data, mime_type=image.mime_type)


def _context_text(request: AnalyzeRequest, has_previous: bool) -> str:
    metrics = request.value_metrics.model_dump(exclude_none=True) if request.value_metrics else None
    capture_metadata = (
        request.capture_metadata.model_dump() if request.capture_metadata else None
    )
    previous_metrics = (
        request.previous_value_metrics.model_dump(exclude_none=True)
        if has_previous and request.previous_value_metrics
        else None
    )
    previous_critique = (
        request.previous_critique.model_dump(exclude_none=True)
        if has_previous and request.previous_critique
        else None
    )
    style = STYLE_PRINCIPLES.get(request.style, STYLE_PRINCIPLES["libre"])
    temporal = (
        "A previous painting is supplied; compare only visible differences between the two images."
        if has_previous
        else "No previous painting is supplied. Do not claim that the painting changed; discuss only the current frame."
    )
    prior_context = ""
    if has_previous:
        prior_context = (
            f"previous_camera_value_estimates (non-authoritative): {previous_metrics or '(none)'}\n"
            "prior_critique_pedagogical_context (not visual proof): "
            f"{previous_critique or '(none)'}\n"
        )
    return (
        "SESSION CONTEXT\n"
        f"medium: {request.medium}\n"
        f"stage: {request.stage}\n"
        f"intention: {request.intention or '(not specified)'}\n"
        f"critique_mode: {request.critique_mode}\n"
        f"reference_purpose: {request.reference_purpose or '(not specified)'}\n"
        f"style_direction: {style}\n"
        f"capture_metadata: {capture_metadata or '(none declared)'}\n"
        f"camera_value_estimates (non-authoritative): {metrics or '(none)'}\n"
        f"{prior_context}"
        f"{temporal}\n"
        f"user_request: {request.user_prompt or 'Give the next grounded correction.'}"
    )


def build_contents(
    request: AnalyzeRequest, images: Mapping[str, DecodedImage]
) -> list[types.Content]:
    """Build bounded history plus one labelled, interleaved multimodal user turn."""

    contents: list[types.Content] = []
    for message in request.history:
        contents.append(
            types.Content(role=message.role, parts=[_text_part(message.text)])
        )

    current_parts: list[types.Part] = []
    ordered_images = (
        ("current", "CURRENT PAINTING — COLOR"),
        ("bw", "CURRENT PAINTING — BLACK AND WHITE"),
        ("previous", "PREVIOUS PAINTING — COLOR"),
        ("reference", "REFERENCE IMAGE"),
    )
    for key, label in ordered_images:
        image = images.get(key)
        if image is None:
            continue
        current_parts.extend((_text_part(label), _image_part(image)))

    current_parts.append(_text_part(_context_text(request, "previous" in images)))
    contents.append(types.Content(role="user", parts=current_parts))
    return contents


def _metadata_value(obj: Any, *names: str) -> Any:
    if obj is None:
        return None
    for name in names:
        if isinstance(obj, Mapping) and name in obj:
            return obj[name]
        value = getattr(obj, name, None)
        if value is not None:
            return value
    return None


def _finish_reason(response: Any) -> str | None:
    candidates = _metadata_value(response, "candidates") or []
    candidate = candidates[0] if candidates else None
    reason = _metadata_value(candidate, "finish_reason", "finishReason")
    if reason is None:
        return None
    name = getattr(reason, "name", None)
    if name:
        return str(name)
    value = str(reason)
    return value.rsplit(".", 1)[-1]


def _usage(response: Any, *names: str) -> int | None:
    metadata = _metadata_value(response, "usage_metadata", "usageMetadata")
    value = _metadata_value(metadata, *names)
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _validation_text(error: Exception) -> str:
    if isinstance(error, ValidationError):
        errors = error.errors(include_url=False)
        return "; ".join(
            f"{'.'.join(str(part) for part in item.get('loc', ())) or 'response'}: {item.get('msg', 'invalid')}"
            for item in errors
        )[:2400]
    return str(error).replace("\n", " ")[:2400]


def _parse_response(response: Any, request: AnalyzeRequest) -> Critique:
    text = getattr(response, "text", None)
    if not isinstance(text, str) or not text.strip():
        raise ValueError("model response was empty")
    critique = Critique.model_validate_json(text)
    return critique.validate_for_request(request)


def _is_transient(error: Exception) -> bool:
    """Return True for errors worth retrying (429 quota, 503 busy)."""
    lowered = str(error).lower()
    error_name = type(error).__name__.lower()
    return any(t in lowered for t in ("quota", "resource_exhausted", "429", "503", "unavailable", "busy")) or any(
        t in error_name for t in ("busy", "unavailable")
    )


def generate_critique(
    client: Any,
    model: str,
    request: AnalyzeRequest,
    images: Mapping[str, DecodedImage],
) -> GenerationResult:
    """Generate and validate a critique, repairing one invalid provider response.

    Transient provider errors (429, 503) are retried once after a short delay.
    """

    contents = build_contents(request, images)
    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_INSTRUCTION,
        response_mime_type="application/json",
        response_schema=Critique,
        max_output_tokens=2400 if request.critique_mode == "deep" else 1400,
    )

    last_error: Exception | None = None
    # Phase 1: retry transient provider errors (quota / busy) once.
    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model=model,
                contents=contents,
                config=config,
            )
            break  # success — proceed to parse
        except Exception as exc:
            last_error = exc
            if attempt < 2 and _is_transient(exc):
                time.sleep(2 * (attempt + 1))  # 2s, 4s
                continue
            raise

    # Phase 2: parse + one repair pass if schema is invalid.
    attempts = 0
    for attempts in (1, 2):
        call_contents = contents
        if attempts == 2:
            repair = (
                "REPAIR THE LAST RESPONSE. Return only valid JSON matching the Critique schema. "
                "Fix these validation errors and preserve only evidence visible in the supplied images: "
                f"{_validation_text(last_error or ValueError('invalid response'))}"
            )
            current = contents[-1]
            repaired_current = types.Content(
                role=current.role,
                parts=[*current.parts, _text_part(repair)],
            )
            call_contents = [*contents[:-1], repaired_current]
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=call_contents,
                    config=config,
                )
            except Exception as exc:
                if _is_transient(exc):
                    raise
                last_error = exc
                continue
        try:
            critique = _parse_response(response, request)
        except (ValidationError, ValueError, TypeError, json.JSONDecodeError) as error:
            last_error = error
            if attempts == 1:
                continue
            raise InvalidModelResponse(
                "model response did not match the critique contract"
            ) from error
        return GenerationResult(
            critique=critique,
            attempts=attempts,
            finish_reason=_finish_reason(response),
            input_tokens=_usage(response, "prompt_token_count", "promptTokenCount"),
            output_tokens=_usage(response, "candidates_token_count", "candidatesTokenCount"),
        )
    raise InvalidModelResponse("model response did not match the critique contract") from last_error
