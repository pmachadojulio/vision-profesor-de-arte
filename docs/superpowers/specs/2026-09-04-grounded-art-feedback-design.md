# Grounded Art Feedback — Design

## Goal

Turn the current snapshot-based art critic into a reliable workshop assistant whose feedback is visibly grounded in the submitted painting, appropriate to the painting stage, actionable in one short painting step, and verifiable on the next capture.

The real-time experience must remain concise. Depth comes from a stronger internal analysis and a structured contract, not from showing the painter a long essay.

## Product modes

The app exposes two explicit modes:

- **Next brushstroke:** one priority, at most 90 spoken words, designed for use while painting.
- **Deep critique:** a broader review of the major artistic dimensions, followed by the same single next priority.

Both modes use the same grounded analysis pipeline. Deep critique reveals more of the analysis; next-brushstroke mode only presents the highest-leverage action.

## Session context

Before analysis, the user can specify:

- medium;
- stage: sketch, block-in, modelling, edges/detail, or finish;
- current intention or focal point;
- selected stylistic direction;
- optional reference and what to borrow from it: composition, value, color, edges, or handling.

These fields are compact controls with sensible defaults. Free-text questions remain available.

## Capture and image quality

The exact snapshot sent to the model is shown in the interface.

When the user defines four canvas corners, the captured quadrilateral is perspective-corrected to a canonical rectangle rather than reduced to its bounding box. Display coordinates are mapped correctly to source-video coordinates even when `object-fit: cover` crops the preview.

Each request includes capture metadata and quality signals:

- dimensions and MIME type;
- crop source and crop confidence;
- blur estimate;
- clipped-dark and clipped-light percentages;
- canvas coverage;
- global value distribution, explicitly described as a camera estimate rather than truth.

An unusable frame produces only a recapture instruction. Auxiliary images are validated; malformed B/W or reference images are never silently discarded.

## Grounded critique pipeline

The backend sends clearly interleaved labels and media parts in this order:

1. current color painting;
2. current B/W painting;
3. previous color painting, when comparison is requested;
4. optional reference;
5. structured session context and user request.

The model is instructed to perform this sequence:

1. Check whether the frame is usable.
2. Establish stage, intention, and relevant use of the reference.
3. Scan drawing/perspective, composition/focal hierarchy, shape design, values, color/temperature/chroma, edges/depth, and material handling.
4. Form candidate issues based only on visible evidence.
5. Rank candidates by impact, structural dependency, stage suitability, confidence, and reversibility.
6. Return one primary action and at most one immediately dependent follow-up.

Value metrics corroborate localized visual observations but never override the image or an intentional high-key/low-key design. The model must not name an ambiguous object as fact. It must not claim that something changed unless a previous image is present.

## Response contract

Gemini returns JSON validated by Pydantic. The contract contains:

- frame usability, capture problems, and overall confidence;
- inferred stage and whether clarification is needed;
- one strength worth preserving;
- dimension observations for deep mode;
- one or two prioritized corrections, each with:
  - stable issue identifier;
  - dimension;
  - visible evidence;
  - normalized region and human-readable location;
  - perceptual consequence;
  - exact action;
  - optional mixture/tool guidance;
  - amount or target relationship;
  - a 30–60 second verification test;
  - confidence;
- a concise spoken summary.

Invalid, empty, or superficial responses are not accepted as successful. The backend retries once with a repair instruction and returns a clear upstream-response error if validation still fails.

## Continuity

The frontend maintains a bounded pedagogical session separate from UI notifications. A session stores:

- prior image and prior value metrics;
- prior structured critique;
- active issue and expected result;
- issue status: pending, improved, persistent, or resolved.

Only user/model conversation enters model history. Toasts, quota messages, and controls never do. Automatic requests are serialized, carry request IDs, and discard stale responses.

When no prior frame exists, the app asks for a baseline instead of claiming visual change.

## Interface

The mobile-first interface emphasizes:

- current feedback and next action;
- the exact submitted snapshot;
- compact stage, medium, critique-mode, and reference-purpose controls;
- structured cards for Read / Act / Check;
- optional normalized location marker over the snapshot;
- capture/model/latency metadata in a collapsible diagnostics area;
- useful / not useful feedback and a short reason.

Advanced grid, histogram, detection, and API settings are collapsible. Interactive targets meet a 44-pixel minimum and status changes use accessible live regions.

## Backend boundaries

The Python code is split conceptually into independently testable units:

- request and response models;
- image decoding/validation;
- prompt construction;
- Gemini invocation and response repair;
- endpoint orchestration.

The current provider remains configurable. Model switching is not the first quality intervention. A fast model can serve next-brushstroke mode; a higher-reasoning configured model may serve deep critique later.

## Security and reliability

- Bind to loopback by default; LAN mode is explicit.
- Restrict CORS to configured local origins.
- Prefer the server-side environment key. If a browser key is used, describe accurately that it is sent to the local backend and then to Google.
- Validate Base64 strictly, MIME signatures, decoded size, and image dimensions.
- Type and bound conversation history.
- Add request timeout, in-flight protection, request IDs, latency, finish-reason, and token metadata where available.
- Remove private global `httpx` monkey patches and dead fallback branches.
- Pin compatible dependency ranges and keep runtime documentation generated from configuration rather than hard-coded quota claims.

## Evaluation and tests

Automated tests cover request validation, image MIME/signature handling, prompt construction, structured-output validation/repair, history filtering, unknown styles, and API error mapping.

Browser-level logic is separated into testable functions for source/display coordinate mapping, perspective crop, histogram percentiles, stale-detection expiry, and request serialization.

A versioned evaluation set contains fixed packages for:

- unusable captures;
- sketch, block-in, and finished versions of the same motif;
- intentional high-key and low-key paintings;
- dominant drawing, composition, edge, color, and value problems;
- abstract ambiguity;
- useful, partially useful, and unrelated references;
- unchanged and known before/after sequences.

Each response is scored on evidence grounding, localization, technical defensibility, priority, action completeness, verification criterion, uncertainty handling, temporal honesty, oral concision, and non-repetition. Hard failures include invented objects, change claims without a prior frame, histogram-only diagnoses, and successful HTTP responses for invalid model output.

## Delivery sequence

1. Add tests and typed backend contracts.
2. Replace the prompt and add structured-output handling.
3. Repair capture, history, request serialization, and continuity.
4. Redesign the feedback presentation and session controls.
5. Add evaluation fixtures, diagnostics, and documentation.
6. Run the complete automated suite and a local smoke test without consuming a real API key.
