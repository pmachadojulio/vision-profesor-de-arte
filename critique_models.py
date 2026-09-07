"""Bounded request and response contracts for grounded art critiques."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


Confidence = Literal["low", "medium", "high"]
CritiqueMode = Literal["next_brushstroke", "deep"]
Dimension = Literal[
    "drawing",
    "composition",
    "shape",
    "value",
    "color",
    "edges",
    "handling",
    "capture",
]
Stage = Literal["sketch", "block-in", "modelling", "edges-detail", "finish", "unknown"]
ReferencePurpose = Literal["composition", "value", "color", "edges", "handling"]
CropMode = Literal["perspective_rectified", "axis_aligned_fallback", "full_frame"]
CropSource = Literal["manual", "detected", "none"]
ImageMime = Literal["image/jpeg", "image/png", "image/webp"]
MAX_CAPTURE_PIXELS = 24_000_000

# Deep mode explicitly scans each foundational design dimension. Capture is a
# quality gate rather than an artistic observation, so it is intentionally not
# part of this set.
DEEP_OBSERVATION_DIMENSIONS = frozenset(
    {"drawing", "composition", "shape", "value", "color", "edges", "handling"}
)


class ContractModel(BaseModel):
    """Base configuration shared by all public API contracts."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Region(ContractModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def remain_inside_canvas(self) -> "Region":
        if self.x + self.width > 1 or self.y + self.height > 1:
            raise ValueError("region must remain inside the normalized canvas")
        return self


class HistoryMessage(ContractModel):
    role: Literal["user", "model"]
    text: str = Field(min_length=1, max_length=4000)


class ValueMetrics(ContractModel):
    """Non-authoritative camera estimates, normalized where applicable."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        title="Non-authoritative camera value estimates",
        json_schema_extra={
            "description": "Camera estimates that corroborate visual evidence; they are not authoritative artistic truth."
        },
    )

    p10: float | None = Field(default=None, ge=0, le=1)
    median: float | None = Field(default=None, ge=0, le=1)
    p90: float | None = Field(default=None, ge=0, le=1)
    mean: float | None = Field(default=None, ge=0, le=1)
    clipped_dark_pct: float | None = Field(default=None, ge=0, le=1)
    clipped_light_pct: float | None = Field(default=None, ge=0, le=1)
    canvas_coverage: float | None = Field(default=None, ge=0, le=1)
    blur_estimate: float | None = Field(
        default=None,
        ge=0,
        le=1,
        description="Normalized 0..1 blur estimate; larger values mean more blur.",
    )


class CaptureMetadata(ContractModel):
    """Declared properties of the processed current painting frame."""

    crop_mode: CropMode
    crop_source: CropSource
    crop_confidence: Confidence
    width: int = Field(ge=1, le=MAX_CAPTURE_PIXELS)
    height: int = Field(ge=1, le=MAX_CAPTURE_PIXELS)
    mime_type: ImageMime

    @model_validator(mode="after")
    def enforce_pixel_limit(self) -> "CaptureMetadata":
        if self.width * self.height > MAX_CAPTURE_PIXELS:
            raise ValueError("capture metadata must not exceed 24,000,000 pixels")
        return self


class Correction(ContractModel):
    issue_id: str = Field(pattern=r"^[a-z0-9_-]{3,64}$")
    dimension: Dimension
    location: str = Field(min_length=3, max_length=180)
    region: Region | None = None
    evidence: str = Field(min_length=12, max_length=500)
    consequence: str = Field(min_length=8, max_length=400)
    action: str = Field(min_length=12, max_length=600)
    amount: str = Field(min_length=3, max_length=240)
    verification: str = Field(min_length=12, max_length=400)
    mixture: str | None = Field(default=None, max_length=300)
    confidence: Confidence


CaptureProblem = Annotated[str, Field(min_length=1, max_length=300)]
Observation = Annotated[str, Field(min_length=1, max_length=500)]
ImageDimensions = tuple[Annotated[int, Field(ge=0)], Annotated[int, Field(ge=0)]]


class Critique(ContractModel):
    frame_usable: bool
    confidence: Confidence
    capture_problems: list[CaptureProblem] = Field(default_factory=list, max_length=4)
    inferred_stage: Stage = "unknown"
    clarification_needed: bool = False
    strength: str | None = Field(default=None, min_length=3, max_length=400)
    observations: dict[Dimension, Observation] = Field(default_factory=dict, max_length=8)
    corrections: list[Correction] = Field(default_factory=list, max_length=2)
    spoken_summary: str | None = Field(default=None, min_length=12, max_length=900)

    @model_validator(mode="after")
    def enforce_summary_word_limit(self) -> "Critique":
        if self.spoken_summary is not None and len(self.spoken_summary.split()) > 90:
            raise ValueError("spoken_summary must contain at most 90 words")
        return self

    @model_validator(mode="after")
    def enforce_correction_count(self) -> "Critique":
        count = len(self.corrections)
        if self.frame_usable and count not in (1, 2):
            raise ValueError("usable frames require one or two corrections")
        if not self.frame_usable and count:
            raise ValueError("unusable frames must not include corrections")
        if not self.frame_usable and not self.capture_problems:
            raise ValueError("unusable frames require at least one capture problem")
        if not self.frame_usable and self.spoken_summary is None:
            raise ValueError("unusable frames require an explanatory spoken summary")
        return self

    def validate_for_request(self, request: "AnalyzeRequest") -> "Critique":
        """Apply response rules that depend on the requested critique mode."""

        if not self.frame_usable:
            return self
        if request.critique_mode == "next_brushstroke":
            if len(self.corrections) != 1:
                raise ValueError("next_brushstroke requests require exactly one correction")
            if not self.spoken_summary:
                raise ValueError("next_brushstroke responses require spoken_summary")
        else:
            missing = DEEP_OBSERVATION_DIMENSIONS.difference(self.observations)
            if missing:
                missing_text = ", ".join(sorted(missing))
                raise ValueError(
                    f"deep responses require observations for: {missing_text}"
                )
        return self


class AnalyzeRequest(ContractModel):
    image_base64: str = Field(min_length=1, max_length=20_000_000)
    image_bw_base64: str | None = Field(default=None, min_length=1, max_length=20_000_000)
    previous_image_base64: str | None = Field(
        default=None, min_length=1, max_length=20_000_000
    )
    image_ref_base64: str | None = Field(default=None, min_length=1, max_length=20_000_000)
    value_metrics: ValueMetrics | None = None
    capture_metadata: CaptureMetadata | None = None
    previous_value_metrics: ValueMetrics | None = None
    previous_critique: Critique | None = None
    user_prompt: str = Field(default="", max_length=4000)
    medium: str = Field(default="unknown", min_length=1, max_length=100)
    stage: Stage = "unknown"
    intention: str = Field(default="", max_length=800)
    critique_mode: CritiqueMode = "next_brushstroke"
    style: str = Field(default="libre", min_length=1, max_length=80)
    reference_purpose: ReferencePurpose | None = None
    history: list[HistoryMessage] = Field(default_factory=list, max_length=12)
    api_key: str | None = Field(default=None, min_length=1, max_length=512)

    @model_validator(mode="after")
    def validate_auxiliary_context_dependencies(self) -> "AnalyzeRequest":
        if (
            self.previous_value_metrics is not None or self.previous_critique is not None
        ) and self.previous_image_base64 is None:
            raise ValueError(
                "previous_value_metrics and previous_critique require previous_image_base64"
            )
        if self.reference_purpose is not None and self.image_ref_base64 is None:
            raise ValueError("reference_purpose requires image_ref_base64")
        return self


class AnalyzeResponse(ContractModel):
    critique: Critique
    request_id: str = Field(min_length=1, max_length=128)
    model: str = Field(min_length=1, max_length=160)
    prompt_version: str = Field(min_length=1, max_length=80)
    latency_ms: int = Field(ge=0)
    finish_reason: str | None = Field(default=None, max_length=160)
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    image_dimensions: dict[str, ImageDimensions] = Field(default_factory=dict)
    auxiliary_images_used: list[str] = Field(default_factory=list, max_length=3)
