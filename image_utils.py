"""Strict decoding and validation for image data supplied to the API."""

from __future__ import annotations

import base64
import binascii
import io
import re
from dataclasses import dataclass

from PIL import Image, UnidentifiedImageError


ALLOWED_IMAGE_MIMES = frozenset({"image/jpeg", "image/png", "image/webp"})
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000
_DATA_URL_PATTERN = re.compile(r"data:([^;,]+);base64,(.*)", re.DOTALL)


class ImageValidationError(ValueError):
    """A client image failed validation, with its request field retained for APIs."""

    def __init__(self, field_name: str, reason: str) -> None:
        self.field_name = field_name
        self.reason = reason
        super().__init__(f"{field_name}: {reason}")


@dataclass(frozen=True)
class DecodedImage:
    data: bytes
    mime_type: str
    width: int
    height: int


def split_data_url(data_url: str) -> tuple[str | None, str]:
    """Return the optional declared MIME type and the raw Base64 payload."""

    if not isinstance(data_url, str) or not data_url:
        raise ValueError("missing image data")
    if not data_url.startswith("data:"):
        return None, data_url

    match = _DATA_URL_PATTERN.fullmatch(data_url)
    if not match:
        raise ValueError("malformed data URL")
    return match.group(1).lower(), match.group(2)


def decode_image(data_url: str, *, field_name: str) -> DecodedImage:
    """Decode an allowed image, checking Base64, bytes, MIME, and dimensions."""

    try:
        declared_mime, payload = split_data_url(data_url)
        raw = base64.b64decode(payload, validate=True)
    except (TypeError, ValueError, binascii.Error) as error:
        raise ImageValidationError(field_name, "invalid base64 image data") from error

    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ImageValidationError(field_name, "invalid decoded size")

    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.verify()
        with Image.open(io.BytesIO(raw)) as image:
            width, height = image.size
            actual_mime = Image.MIME.get(image.format)
    except (Image.DecompressionBombError, OSError, UnidentifiedImageError) as error:
        raise ImageValidationError(field_name, "invalid image bytes") from error

    if width * height > MAX_IMAGE_PIXELS:
        raise ImageValidationError(field_name, "image dimensions are too large")
    if actual_mime not in ALLOWED_IMAGE_MIMES or min(width, height) < 96:
        raise ImageValidationError(field_name, "unsupported or too small")
    if declared_mime and declared_mime != actual_mime:
        raise ImageValidationError(field_name, "declared MIME does not match bytes")

    return DecodedImage(raw, actual_mime, width, height)
