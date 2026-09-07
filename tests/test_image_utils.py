import base64
import io

import pytest
from PIL import Image

import image_utils
from image_utils import ImageValidationError, decode_image


@pytest.fixture
def png_data_url():
    output = io.BytesIO()
    Image.new("RGB", (128, 96), color=(45, 80, 120)).save(output, format="PNG")
    payload = base64.b64encode(output.getvalue()).decode("ascii")
    return f"data:image/png;base64,{payload}"


def make_data_url(image_format, size=(128, 96)):
    output = io.BytesIO()
    Image.new("RGB", size, color=(45, 80, 120)).save(output, format=image_format)
    data = output.getvalue()
    return (
        f"data:{Image.MIME[image_format]};base64,{base64.b64encode(data).decode('ascii')}",
        data,
    )


def test_decode_image_preserves_png_mime(png_data_url):
    image = decode_image(png_data_url, field_name="reference")
    assert (image.mime_type, image.width, image.height) == ("image/png", 128, 96)


@pytest.mark.parametrize("image_format", ["JPEG", "WEBP"])
def test_decode_image_accepts_allowed_formats_and_preserves_bytes(image_format):
    data_url, original = make_data_url(image_format)
    image = decode_image(data_url, field_name="painting")
    assert image.mime_type == Image.MIME[image_format]
    assert image.data == original


@pytest.mark.parametrize("value", ["%%%%", "data:image/jpeg;base64,%%%%", ""])
def test_decode_image_rejects_invalid_base64(value):
    with pytest.raises(ImageValidationError):
        decode_image(value, field_name="painting")


def test_decode_image_rejects_mismatched_declared_mime(png_data_url):
    jpeg_claim = png_data_url.replace("data:image/png", "data:image/jpeg", 1)
    with pytest.raises(ImageValidationError, match="declared MIME"):
        decode_image(jpeg_claim, field_name="reference")


def test_decode_image_rejects_images_smaller_than_96_pixels_on_one_side():
    output = io.BytesIO()
    Image.new("RGB", (95, 128)).save(output, format="PNG")
    payload = base64.b64encode(output.getvalue()).decode("ascii")
    with pytest.raises(ImageValidationError, match="too small"):
        decode_image(f"data:image/png;base64,{payload}", field_name="painting")


def test_decode_image_rejects_base64_that_is_not_an_image():
    payload = base64.b64encode(b"this is not an image").decode("ascii")
    with pytest.raises(ImageValidationError, match="invalid image bytes"):
        decode_image(f"data:image/png;base64,{payload}", field_name="painting")


def test_decode_image_rejects_a_valid_but_unsupported_format():
    data_url, _ = make_data_url("GIF")
    with pytest.raises(ImageValidationError, match="unsupported"):
        decode_image(data_url, field_name="painting")


def test_decode_image_respects_the_decoded_byte_limit(monkeypatch, png_data_url):
    monkeypatch.setattr(image_utils, "MAX_IMAGE_BYTES", 1)
    with pytest.raises(ImageValidationError, match="invalid decoded size"):
        decode_image(png_data_url, field_name="painting")


def test_decode_image_respects_the_pixel_limit(monkeypatch, png_data_url):
    monkeypatch.setattr(image_utils, "MAX_IMAGE_PIXELS", 100)
    with pytest.raises(ImageValidationError, match="dimensions are too large"):
        decode_image(png_data_url, field_name="painting")
