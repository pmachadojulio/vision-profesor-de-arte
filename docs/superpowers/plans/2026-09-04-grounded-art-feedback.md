# Grounded Art Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a grounded, stateful art-teaching pipeline that validates what it sees, returns one evidence-based action, compares real before/after frames, and presents the result clearly beside the exact submitted snapshot.

**Architecture:** Extract typed models, strict image handling, and Gemini orchestration from the FastAPI entry point. Keep browser-only camera and OpenCV work in the frontend, but move deterministic geometry, metrics, and request-state logic into a dependency-free ES module tested with Node. Use one structured critique contract across quick and deep modes.

**Tech Stack:** Python 3.10+, FastAPI, Pydantic 2, google-genai, Pillow, pytest, vanilla HTML/CSS/ES modules, OpenCV.js, Node built-in test runner.

## Global Constraints

- Next-brushstroke responses show one priority and at most 90 spoken words.
- Deep critique may expose the dimension scan but still ends with one primary action.
- Global value metrics are camera estimates and never authoritative truth.
- Never claim visual change without a prior image.
- Never accept empty, unstructured, or evidence-free model output as HTTP 200.
- UI events never enter pedagogical conversation history.
- The exact submitted image must remain visible with its feedback.
- Default server bind is `127.0.0.1`; LAN mode is explicit.
- This directory has no Git repository, so commit steps are recorded as file checkpoints rather than executed commits.

---

### Task 1: Typed Contracts and Strict Image Validation

**Files:**
- Create: `critique_models.py`
- Create: `image_utils.py`
- Create: `tests/test_models.py`
- Create: `tests/test_image_utils.py`
- Modify: `requirements.txt`

**Interfaces:**
- Produces: `AnalyzeRequest`, `Critique`, `Correction`, `AnalyzeResponse`, `ValueMetrics`, `HistoryMessage`.
- Produces: `decode_image(data_url: str, *, field_name: str) -> DecodedImage`.
- `DecodedImage` exposes `data`, `mime_type`, `width`, `height`.

- [ ] **Step 1: Write failing contract tests**

```python
def test_history_rejects_unknown_roles():
    with pytest.raises(ValidationError):
        HistoryMessage(role="assistant", text="hola")

def test_quick_critique_requires_grounded_correction():
    with pytest.raises(ValidationError):
        Critique(frame_usable=True, confidence="high", corrections=[])
```

- [ ] **Step 2: Run contract tests and confirm missing modules**

Run: `pytest -q tests/test_models.py`

Expected: collection fails because `critique_models` does not exist.

- [ ] **Step 3: Implement bounded Pydantic models**

```python
Confidence = Literal["low", "medium", "high"]
CritiqueMode = Literal["next_brushstroke", "deep"]

class Region(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)

class HistoryMessage(BaseModel):
    role: Literal["user", "model"]
    text: str = Field(min_length=1, max_length=4000)

class Correction(BaseModel):
    issue_id: str = Field(pattern=r"^[a-z0-9_-]{3,64}$")
    dimension: Literal["drawing", "composition", "shape", "value", "color", "edges", "handling", "capture"]
    location: str = Field(min_length=3, max_length=180)
    region: Region | None = None
    evidence: str = Field(min_length=12, max_length=500)
    consequence: str = Field(min_length=8, max_length=400)
    action: str = Field(min_length=12, max_length=600)
    amount: str = Field(min_length=3, max_length=240)
    verification: str = Field(min_length=12, max_length=400)
    mixture: str | None = Field(default=None, max_length=300)
    confidence: Confidence
```

Add a model validator requiring no corrections when `frame_usable=False` and one or two corrections when `frame_usable=True`.

- [ ] **Step 4: Write failing image tests**

```python
def test_decode_image_preserves_png_mime(png_data_url):
    image = decode_image(png_data_url, field_name="reference")
    assert (image.mime_type, image.width, image.height) == ("image/png", 128, 96)

@pytest.mark.parametrize("value", ["%%%%", "data:image/jpeg;base64,%%%%", ""])
def test_decode_image_rejects_invalid_base64(value):
    with pytest.raises(ImageValidationError):
        decode_image(value, field_name="painting")
```

- [ ] **Step 5: Implement strict image decoding**

```python
@dataclass(frozen=True)
class DecodedImage:
    data: bytes
    mime_type: str
    width: int
    height: int

def decode_image(data_url: str, *, field_name: str) -> DecodedImage:
    declared_mime, payload = split_data_url(data_url)
    raw = base64.b64decode(payload, validate=True)
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ImageValidationError(field_name, "invalid decoded size")
    with Image.open(io.BytesIO(raw)) as image:
        image.verify()
    with Image.open(io.BytesIO(raw)) as image:
        width, height = image.size
        actual_mime = Image.MIME.get(image.format)
    if actual_mime not in ALLOWED_IMAGE_MIMES or min(width, height) < 96:
        raise ImageValidationError(field_name, "unsupported or too small")
    if declared_mime and declared_mime != actual_mime:
        raise ImageValidationError(field_name, "declared MIME does not match bytes")
    return DecodedImage(raw, actual_mime, width, height)
```

- [ ] **Step 6: Pin compatible dependency ranges and run tests**

Set `requirements.txt` to explicit compatible ranges including `Pillow>=11,<13` and `pytest>=8,<10`. Run `pytest -q tests/test_models.py tests/test_image_utils.py`; expected: all pass.

- [ ] **Step 7: Record checkpoint**

Run: `git rev-parse --is-inside-work-tree`

Expected: `fatal: not a git repository`. Record Task 1 files in the final handoff instead of committing.

---

### Task 2: Grounded Prompt, Structured Gemini Service, and API

**Files:**
- Create: `critique_service.py`
- Rewrite: `app.py`
- Create: `tests/test_critique_service.py`
- Create: `tests/test_api.py`

**Interfaces:**
- Consumes: models and `DecodedImage` from Task 1.
- Produces: `build_contents(request, images) -> list[types.Content]`.
- Produces: `generate_critique(client, model, request, images) -> GenerationResult`.
- API `POST /api/analyze` returns `AnalyzeResponse`.

- [ ] **Step 1: Write failing prompt tests**

```python
def test_prompt_labels_media_in_order(make_request, make_images):
    contents = build_contents(make_request(previous=True, reference=True), make_images())
    current = contents[-1].parts
    assert [text_of(part) for part in current if has_text(part)][:4] == [
        "CURRENT PAINTING — COLOR",
        "CURRENT PAINTING — BLACK AND WHITE",
        "PREVIOUS PAINTING — COLOR",
        "REFERENCE IMAGE",
    ]

def test_prompt_forbids_temporal_claim_without_previous(make_request, make_images):
    prompt = serialized_prompt(build_contents(make_request(previous=False), make_images(previous=False)))
    assert "Do not claim that the painting changed" in prompt
```

- [ ] **Step 2: Implement the evidence-first system instruction**

Create `SYSTEM_INSTRUCTION` that requires the quality gate, full dimension scan, evidence before diagnosis, priority ranking, temporal honesty, camera-metric caveats, ambiguity handling, and the shared response contract. Replace artist recipes with short directional principles applied only after the foundational diagnosis.

- [ ] **Step 3: Write failing structured-response tests**

```python
def test_invalid_first_response_is_repaired(fake_client, valid_critique_json, request, images):
    fake_client.queue("Bien.", valid_critique_json)
    result = generate_critique(fake_client, "test-model", request, images)
    assert result.attempts == 2
    assert result.critique.corrections[0].evidence

def test_two_invalid_responses_raise_upstream_error(fake_client, request, images):
    fake_client.queue("", "{}")
    with pytest.raises(InvalidModelResponse):
        generate_critique(fake_client, "test-model", request, images)
```

- [ ] **Step 4: Implement Gemini invocation and repair**

```python
config = types.GenerateContentConfig(
    system_instruction=SYSTEM_INSTRUCTION,
    response_mime_type="application/json",
    response_schema=Critique,
    max_output_tokens=2400 if request.critique_mode == "deep" else 1400,
)
```

Parse with `Critique.model_validate_json(response.text)`. On failure, retry once with a repair message that quotes only the validation errors, never the API key or binary content. Extract finish reason and usage metadata defensively.

- [ ] **Step 5: Write failing API tests**

```python
def test_api_rejects_bad_auxiliary_image(client, valid_request):
    valid_request["image_ref_base64"] = "%%%%"
    response = client.post("/api/analyze", json=valid_request)
    assert response.status_code == 422
    assert response.json()["detail"]["field"] == "reference"

def test_api_returns_502_for_invalid_model_output(client, monkeypatch, valid_request):
    monkeypatch.setattr("app.generate_critique", raise_invalid_model_response)
    assert client.post("/api/analyze", json=valid_request).status_code == 502
```

- [ ] **Step 6: Rewrite endpoint orchestration**

Decode all supplied images, normalize unknown styles to `libre`, invoke the service, and return critique plus `request_id`, `model`, prompt version, latency, finish reason, token usage, image dimensions, and which auxiliary images were actually used. Map authentication, quota, busy, invalid-output, and validation errors once each.

- [ ] **Step 7: Restrict CORS and remove dead/private patches**

Parse `APP_ALLOWED_ORIGINS`, defaulting to `http://127.0.0.1:8000,http://localhost:8000`; remove the global private `httpx` header patch, duplicated error branches, and inactive Ollama fallback claims.

- [ ] **Step 8: Run backend suite**

Run: `pytest -q`

Expected: Task 1 and Task 2 tests pass without network access or a real Gemini key.

---

### Task 3: Deterministic Browser Core and True Capture Continuity

**Files:**
- Create: `static/vision-core.mjs`
- Create: `tests/js/vision-core.test.mjs`
- Create: `static/app.js`
- Modify: `static/index.html`

**Interfaces:**
- Produces: `coverMapping`, `displayPointToSource`, `calculateValueMetrics`, `DetectionTracker`, `RequestCoordinator`, and `formatCritique`.
- `app.js` consumes those functions and the backend contract from Task 2.

- [ ] **Step 1: Write failing geometry and state tests**

```javascript
test('maps a covered 16:9 video into a 4:3 preview', () => {
  const p = displayPointToSource({x: 0, y: .5}, {sourceWidth: 1920, sourceHeight: 1080, displayWidth: 800, displayHeight: 600});
  assert.ok(Math.abs(p.x - .125) < .001);
  assert.equal(p.y, .5);
});

test('expires a stale detected quad after misses', () => {
  const tracker = new DetectionTracker({maxMisses: 3});
  tracker.hit(quad); tracker.miss(); tracker.miss(); tracker.miss();
  assert.equal(tracker.current(), null);
});
```

- [ ] **Step 2: Implement the pure browser core**

Implement cover-crop mapping, clamped normalized regions, percentile-based luminance metrics, stale detection expiry, one-request-at-a-time coordination with `AbortController`, and plain-text critique formatting. Do not access DOM globals from this module.

- [ ] **Step 3: Run JS core tests**

Run: `node --test tests/js/vision-core.test.mjs`

Expected: all tests pass with no browser or package installation.

- [ ] **Step 4: Implement exact capture and perspective correction**

In `app.js`, map manual/display points through `displayPointToSource`. When a quad exists and OpenCV is ready, call `cv.getPerspectiveTransform` and `cv.warpPerspective` into a canonical canvas whose orientation follows the quad. Fall back to a correctly mapped axis-aligned crop only when OpenCV is unavailable, and label that fallback in capture metadata.

- [ ] **Step 5: Implement real continuity and serialized Auto**

Keep `previousImageBase64`, `previousValueMetrics`, and `previousCritique` only after a successful response. Send them on the next request. Use `RequestCoordinator` to prevent overlap and discard responses whose request ID is no longer current. Never add control prompts, toasts, or errors to `conversationHistory`.

- [ ] **Step 6: Add capture quality signals and snapshot preview**

Compute blur proxy, clipped dark/light percentages, coverage, crop mode, and value percentiles from the same rectified canvas. Display and retain the exact image Data URL sent in the request.

- [ ] **Step 7: Run JS tests and static import smoke check**

Run: `node --test tests/js/vision-core.test.mjs`

Run: `python3 -m http.server 8765 --directory static` only during manual browser verification, then stop it. Expected: `index.html` imports `app.js` and `vision-core.mjs` without syntax errors.

---

### Task 4: Workshop-Focused Accessible Interface

**Files:**
- Rewrite: `static/index.html`
- Create: `static/styles.css`
- Modify: `static/app.js`

**Interfaces:**
- Consumes: structured `AnalyzeResponse` and frontend core from Tasks 2–3.
- Produces: DOM controls with stable IDs documented in `app.js` and feedback cards generated by `renderCritique(response)`.

- [ ] **Step 1: Build semantic UI structure**

Create a mobile-first shell with a sticky Current Action panel, camera/snapshot panel, stage/medium/mode controls, reference-purpose control, collapsible capture tools, and collapsible connection settings. Use labels for every input, `aria-live="polite"` for status and response regions, and 44-pixel controls.

- [ ] **Step 2: Render structured feedback**

`renderCritique` must display capture problems alone when `frame_usable=false`; otherwise display Preserve, Read, Act, Check, confidence, and deep observations when present. Overlay the primary correction region on the submitted snapshot and expose diagnostics in a `<details>` element.

- [ ] **Step 3: Add useful/not-useful feedback**

Store an opt-in local JSONL-compatible array in localStorage containing request ID, prompt version, issue dimension, rating, and selected reason, never images or API keys. Offer export as a local JSON download for future evaluation.

- [ ] **Step 4: Verify keyboard and small-screen behavior**

At 390px width, Current Action appears before advanced tools, nothing scrolls horizontally, and all functions are keyboard reachable. Camera denial, missing camera, pending analysis, retryable 429/503, and invalid capture each produce actionable visible status.

---

### Task 5: Evaluation Fixtures, Startup Safety, and Documentation

**Files:**
- Create: `evals/cases.json`
- Create: `evals/README.md`
- Create: `tests/test_eval_contract.py`
- Modify: `start.sh`
- Rewrite: `README.md`
- Modify: `.env.example`
- Update: `art-vision-critique/SKILL.md`

**Interfaces:**
- Evaluation cases contain `id`, `stage`, `intent`, `reference_purpose`, `required_behaviors`, and `forbidden_behaviors`.
- `start.sh` accepts optional `--lan`; no argument binds loopback.

- [ ] **Step 1: Write failing fixture-contract test**

```python
def test_eval_set_covers_hard_failures():
    cases = json.loads(Path("evals/cases.json").read_text())
    tags = {tag for case in cases for tag in case["tags"]}
    assert {"unusable", "high_key", "abstract", "no_previous", "before_after", "unrelated_reference"} <= tags
```

- [ ] **Step 2: Add versioned evaluation cases**

Add at least twelve metadata fixtures covering the required tags, with concrete required and forbidden behaviors. Document how to attach private local images without committing them and how to compare prompt versions blind with the same configured model.

- [ ] **Step 3: Make startup loopback-safe**

Implement `start.sh` so default host is `127.0.0.1`; `./start.sh --lan` selects `0.0.0.0` and prints a warning that HTTPS and a trusted network are required. Reject any other argument with usage and non-zero exit.

- [ ] **Step 4: Rewrite documentation from actual behavior**

Document setup, modes, capture confirmation, previous-frame continuity, local key flow, configurable model without fixed quota claims, loopback/LAN modes, tests, evaluation workflow, and known camera limitations. Remove “Gemini Live” and inactive Ollama fallback claims.

- [ ] **Step 5: Run all verification commands**

Run: `pytest -q`

Run: `node --test tests/js/vision-core.test.mjs`

Run: `python3 -m compileall -q app.py critique_models.py critique_service.py image_utils.py`

Expected: all commands exit 0.

- [ ] **Step 6: Local API and UI smoke test**

Launch on `127.0.0.1` with a temporary invalid API key only for health/static checks. Verify `/api/health`, `/`, CSS, JS, and module assets return 200. Exercise `/api/analyze` with an invalid auxiliary image and confirm 422 without contacting Google. Stop the server.

- [ ] **Step 7: Record final non-Git checkpoint**

List all created/modified files, test counts, and unresolved limitations. Do not claim a commit or clean working tree because the project has no `.git` directory.
