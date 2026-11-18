# On-device orthopaedic AI: deployment and safety plan

## Product requirements

- Inference runs on the Android device. No image, patient identifier, tensor, or prediction is sent to a remote inference endpoint.
- Internet is permitted only for app/model catalogue and model artifact downloads. The downloaded artifact is verified locally before activation.
- Pixel 7a (Tensor G2, 8 GB RAM) is the first performance target. Other Android devices are supported through runtime capability checks and model profiles, not by assuming all devices can run the same model.
- AI work is scheduled away from the UI thread, bounded in memory, cancellable, and must not change patient records or inventory as a side effect.
- Existing patient, image, inventory, backup, and Intelligence workflows remain unchanged unless separately approved.

## Runtime choice

Use LiteRT 2.x CompiledModel as the preferred Android runtime. It is the current Android API intended to use CPU/GPU/NPU acceleration. Select a supported accelerator at runtime and fall back safely to CPU. Do not assume that every device exposes a usable NPU or that every model operator is supported by every delegate.

Official implementation references:
- https://developers.google.com/edge/litert/android
- https://developers.google.com/edge/litert/overview
- https://developer.android.com/ai/custom

The current Expo app is managed and has no checked-in native Android project. Native inference therefore requires a local Expo native module/config plugin and a development/EAS build; Expo Go or web export cannot validate it.

## Model portfolio

Use specialist models rather than one generic model:
1. X-ray quality / view adequacy and image-type triage.
2. Anatomy and laterality localization.
3. Fracture detection with localization.
4. Region-specific fracture classification (separate validated models for supported anatomy).
5. Optional segmentation where the model has external validation and useful clinical performance.

Do not deploy a paper's reported metric as if it were app performance. Every candidate must pass local acceptance testing with the exact converted artifact and preprocessing pipeline.

## Model registry and artifact security

The TypeScript contract in frontend/src/services/orthopaedic-ai/model-contract.ts defines the minimum manifest and result schema. Each downloadable artifact must have:
- HTTPS artifact URL (download only; never an inference endpoint)
- exact SHA-256 and byte length
- pinned version, input tensor specification, output schema and runtime requirements
- model licence, source, intended use, training cohort, external validation and limitations documented in the model card before release

A downloaded model must be written to a temporary file, size-checked, SHA-256 verified, smoke-tested, then atomically activated. A failed or interrupted download must leave the previous active model intact. No unsigned or unverified model may be loaded.

No real model weights are bundled by this change. Do not publish placeholder weights, fabricated metrics, or a manifest claiming clinical approval.

## Clinical validation gates

Before any model can be called clinically validated:
- obtain a licence-compatible model and training/validation provenance;
- validate on independent, representative X-rays from intended hospitals, devices, views, ages and patient groups;
- report sensitivity, specificity, AUROC, calibration, confidence intervals, subgroup performance and false-negative analysis;
- validate image preprocessing, original-resolution handling, rotation, exposure, projection and image-quality failure modes;
- establish an explicit supported-anatomy list and out-of-distribution rejection;
- perform clinician reader studies and documented clinical governance review.

Until these gates pass, results are research/decision-support only and every result must be marked for clinician review. A low-confidence or unsupported image must return an explicit needs_review / unsupported_image state, not a guessed diagnosis.

## Implant matching boundary

Implant matching is a separate deterministic rules layer. It may filter the local inventory by clinician-approved attributes (anatomy, fracture pattern, fixation method, side, size, system compatibility and stock). It must not infer unrecorded implant specifications or decrement stock. A clinician must confirm implant suitability and final stock use follows the existing patient workflow.

## Performance and reliability gates

- Never run inference on the UI thread.
- Limit concurrent model loads and inference jobs; cancel obsolete jobs when patient context changes.
- Use device profile plus measured latency/memory to choose a model tier. Do not choose solely from device marketing specs.
- Keep original images immutable; create derived working copies only.
- Do not load all patient images into memory at once; process bounded batches.
- Persist an inference result only after image hash, patient association and model version are rechecked.
- Inference failures must not modify patient, inventory, backup or existing Intelligence data.
- Benchmark sustained thermal performance and battery impact on Pixel 7a and representative low/mid/high-tier Android devices.

## Current implementation status

This change adds the typed manifest/result contract and deployment/validation requirements only. It does not add a LiteRT native module, trained model weights, model download manager, automatic X-ray scanning, fracture inference, or implant recommendations. Those require licensed model artifacts and native Android implementation/testing. The existing app's documented X-ray review remains clinician-entered until those components are integrated and validated.
