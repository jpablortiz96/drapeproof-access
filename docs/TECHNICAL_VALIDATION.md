# Technical validation

DrapeProof separates fashion generation from its own deterministic verification and preservation layers. This document summarizes the current production behavior without treating visual checks as real-world guarantees.

## Real provider integration

The production pipeline integrates Perfect Corp. YouCam Clothes Virtual Try-On V4 and Bag Virtual Try-On V2 through server-only clients. Uploads are normalized, stored privately, and submitted once behind idempotency and daily-unit controls. Provider task identifiers remain server-side and are persisted so polling can resume across requests.

Skin Analysis V2.1 is an optional face-appearance signal. Its outputs are treated as image-analysis values, not medical findings or biometric identity evidence.

## Global Continuity Gate

The continuity layer evaluates independent evidence before any local claim:

- frame and aspect-ratio compatibility;
- MediaPipe pose-landmark availability and displacement;
- classical feature matching and geometric inliers;
- mappability of user-selected protected regions.

A failed or unavailable signal produces a blocked/unavailable outcome. Protected-region verification and Preserve Mode do not run when local mapping is not defensible.

## Protected-region verification

User polygons are stored in normalized image coordinates and evaluated under a versioned policy. Measurements include mean absolute difference, changed-pixel ratio, global grayscale SSIM within the region, and Sobel edge difference. The implementation is deterministic for identical normalized inputs and policy files.

## Preserve Mode

Preserve Mode is explicit and source-derived. Eligibility checks continuity, the intended upper-body transformation footprint, the full restoration footprint, and surrounding photometric context. Accepted restoration:

1. starts from the immutable provider result;
2. maps pixels from the original source;
3. feathers only a bounded edge band;
4. records an independently versioned derivative;
5. runs the protected-region verifier again;
6. records zero additional provider calls and zero additional YouCam units.

If prerequisites are missing or overlap is unsafe, the engine blocks instead of attempting a repair.

## Production verification worker

Continuity computation runs in a secret-gated Python Vercel Function with pinned dependencies and a pinned MediaPipe Pose Landmarker model. Inputs have explicit size limits, each request uses an isolated temporary workspace, and cleanup runs in a `finally` boundary. The worker does not receive database, Blob, or YouCam credentials.

## Determinism and regression coverage

The public suite covers provider response parsing, upload validation, continuity policy boundaries, protected-region measurements, repair eligibility, deterministic compositing, ownership isolation, private-object deletion, resumable provider state, budget controls, telemetry allowlists, and security headers/contracts.

```bash
npm test
npm run typecheck
npm run build
```

## Safety and refusal boundaries

DrapeProof does not verify physical fit, sizing, product safety, assistive-device operation, accessibility compatibility, medical condition, or biometric identity. Its policies are experimental and not statistically validated. A blocked result means the system declined to make a local visual claim; it is not evidence that the generated image is safe or unsafe.
