/**
 * Contracts for the on-device orthopaedic AI pipeline.
 * No predictions are manufactured here. Native inference must verify model
 * signature/hash, runtime compatibility, preprocessing and output schema.
 */
export type OrthopaedicModelTask =
  | "xray_quality" | "anatomy_localization" | "fracture_detection"
  | "fracture_classification" | "bone_segmentation";
export type ModelPrecision = "float32" | "float16" | "int8";
export type ModelInputSpec = {
  width: number; height: number; channels: 1 | 3;
  layout: "NHWC" | "NCHW"; colorSpace: "GRAYSCALE" | "RGB";
  normalization: "zero_to_one" | "minus_one_to_one" | "mean_std";
  mean?: number[]; std?: number[];
};
export type ModelArtifact = {
  /** HTTPS model download URL only; never an inference/API endpoint. */
  url: string; sha256: string; bytes: number; format: "tflite";
};
export type OrthopaedicModelManifest = {
  schemaVersion: 1; modelId: string; version: string;
  task: OrthopaedicModelTask; architecture: string; precision: ModelPrecision;
  artifact: ModelArtifact; input: ModelInputSpec; outputSchema: string;
  minimumAndroidApi: number; minimumRamMb: number;
  supportedAccelerators: Array<"cpu" | "gpu" | "npu">;
  supportedAnatomy: string[];
  validation: {
    status: "research_only" | "externally_validated" | "clinically_approved";
    datasetDescription: string; externalValidation: boolean;
    sensitivity?: number; specificity?: number; auroc?: number;
    calibrationDocumentUrl?: string; intendedUse: string; limitations: string[];
  };
};
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const positiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const tasks: OrthopaedicModelTask[] = [
  "xray_quality", "anatomy_localization", "fracture_detection",
  "fracture_classification", "bone_segmentation",
];

/** Strictly validate a remotely downloaded model manifest before use. */
export function validateOrthopaedicModelManifest(value: unknown): value is OrthopaedicModelManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.modelId !== "string" || !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(value.modelId) ||
      typeof value.version !== "string" || !value.version.trim() ||
      typeof value.architecture !== "string" || !value.architecture.trim() ||
      !tasks.includes(value.task as OrthopaedicModelTask) ||
      !["float32", "float16", "int8"].includes(String(value.precision))) return false;
  if (!isRecord(value.artifact) || !isRecord(value.input) || !isRecord(value.validation)) return false;
  let url: URL;
  try { url = new URL(String(value.artifact.url)); } catch { return false; }
  if (url.protocol !== "https:" || typeof value.artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.artifact.sha256) ||
      !positiveInt(value.artifact.bytes) || value.artifact.format !== "tflite") return false;
  const input = value.input;
  if (!positiveInt(input.width) || !positiveInt(input.height) ||
      ![1, 3].includes(Number(input.channels)) ||
      !["NHWC", "NCHW"].includes(String(input.layout)) ||
      !["GRAYSCALE", "RGB"].includes(String(input.colorSpace)) ||
      !["zero_to_one", "minus_one_to_one", "mean_std"].includes(String(input.normalization))) return false;
  if (input.normalization === "mean_std" &&
      (!Array.isArray(input.mean) || !Array.isArray(input.std) ||
       input.mean.length !== input.channels || input.std.length !== input.channels ||
       !input.mean.every(n => typeof n === "number" && Number.isFinite(n)) ||
       !input.std.every(n => typeof n === "number" && Number.isFinite(n) && n > 0))) return false;
  const v = value.validation;
  if (!["research_only", "externally_validated", "clinically_approved"].includes(String(v.status)) ||
      typeof v.datasetDescription !== "string" || typeof v.externalValidation !== "boolean" ||
      typeof v.intendedUse !== "string" || !Array.isArray(v.limitations) ||
      !v.limitations.every(x => typeof x === "string")) return false;
  for (const metric of ["sensitivity", "specificity", "auroc"] as const) {
    const score = v[metric];
    if (score !== undefined && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1)) return false;
  }
  return positiveInt(value.minimumAndroidApi) && positiveInt(value.minimumRamMb) &&
    Array.isArray(value.supportedAccelerators) && value.supportedAccelerators.length > 0 &&
    value.supportedAccelerators.every(x => ["cpu", "gpu", "npu"].includes(String(x))) &&
    Array.isArray(value.supportedAnatomy) && value.supportedAnatomy.length > 0 &&
    value.supportedAnatomy.every(x => typeof x === "string" && x.trim().length > 0) &&
    typeof value.outputSchema === "string" && !!value.outputSchema.trim();
}
export type OrthopaedicInferenceStatus =
  | "queued" | "checking_model" | "preparing_image" | "running" | "completed"
  | "needs_review" | "unsupported_image" | "model_unavailable" | "failed";
export type OrthopaedicInferenceResult = {
  status: "completed" | "needs_review"; modelId: string; modelVersion: string;
  imageSha256: string; createdAt: string;
  findings: Array<{
    task: OrthopaedicModelTask; label: string; confidence: number;
    anatomy?: string; laterality?: "left" | "right" | "unknown";
    boundingBox?: { x: number; y: number; width: number; height: number };
    maskReference?: string;
  }>;
  limitations: string[]; clinicianReviewRequired: true;
};
/** Reject malformed outputs, scores and normalized bounding-box geometry. */
export function validateInferenceResult(value: unknown): value is OrthopaedicInferenceResult {
  if (!isRecord(value) || !["completed", "needs_review"].includes(String(value.status)) ||
      typeof value.modelId !== "string" || typeof value.modelVersion !== "string" ||
      typeof value.imageSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.imageSha256) ||
      typeof value.createdAt !== "string" || value.clinicianReviewRequired !== true ||
      !Array.isArray(value.findings) || !Array.isArray(value.limitations) ||
      !value.limitations.every(x => typeof x === "string")) return false;
  return value.findings.every(f => {
    if (!isRecord(f) || !tasks.includes(f.task as OrthopaedicModelTask) ||
        typeof f.label !== "string" || typeof f.confidence !== "number" ||
        !Number.isFinite(f.confidence) || f.confidence < 0 || f.confidence > 1) return false;
    if (f.laterality !== undefined && !["left", "right", "unknown"].includes(String(f.laterality))) return false;
    if (f.boundingBox !== undefined) {
      if (!isRecord(f.boundingBox)) return false;
      const { x, y, width, height } = f.boundingBox;
      if (![x, y, width, height].every(n => typeof n === "number" && Number.isFinite(n)) ||
          Number(x) < 0 || Number(y) < 0 || Number(width) <= 0 || Number(height) <= 0 ||
          Number(x) + Number(width) > 1 || Number(y) + Number(height) > 1) return false;
    }
    return true;
  });
}
