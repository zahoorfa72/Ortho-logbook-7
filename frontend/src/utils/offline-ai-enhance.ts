import { Buffer } from "buffer";
// Some native inference dependencies still read Buffer from the global scope.
// Install the React Native polyfill before loading or running ONNX inference.
const runtime = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
runtime.Buffer = runtime.Buffer || Buffer;
import * as jpeg from "jpeg-js";
import * as FileSystem from "expo-file-system/legacy";
import { InferenceSession, Tensor } from "onnxruntime-react-native";

const MODEL_URL = "https://huggingface.co/opencv/deblurring_nafnet/resolve/main/deblurring_nafnet_2025may.onnx";
const MODEL_NAME = "deblurring_nafnet_2025may.onnx";
// Real-ESRGAN is a trained super-resolution model: unlike sharpening, it learns
// to reconstruct plausible high-frequency detail and upscale photographs.
const SUPER_RES_MODEL_URL = "https://huggingface.co/Heliosoph/realesrgan-onnx/resolve/main/realesr-general-x4v3.onnx";
const SUPER_RES_MODEL_NAME = "realesr-general-x4v3.onnx";
const SUPER_RES_MIN_BYTES = 3 * 1024 * 1024;
const SUPER_RES_TILE = 128;
const SUPER_RES_CONTEXT = 16;
// Optional higher-detail SwinIR transformer model. It is larger and slower,
// so users explicitly select it rather than downloading it during every edit.
const SWINIR_MODEL_URL = "https://huggingface.co/Heliosoph/swinir-onnx/resolve/main/swinir_realsr_x4.onnx";
const SWINIR_MODEL_NAME = "swinir_realsr_x4.onnx";
const SWINIR_MIN_BYTES = 90 * 1024 * 1024;
const SWINIR_TILE = 64;
const TILE_SIZE = 512;
const MAX_IMAGE_SIDE = 1536;
const MIN_MODEL_BYTES = 80 * 1024 * 1024;

let sessionPromise: Promise<InferenceSession> | null = null;
let superResolutionSessionPromise: Promise<InferenceSession> | null = null;
let swinirSessionPromise: Promise<InferenceSession> | null = null;

function localModelUri(): string {
  const root = FileSystem.documentDirectory || FileSystem.cacheDirectory;
  if (!root) throw new Error("Private app storage is unavailable.");
  return root + "ai-models/" + MODEL_NAME;
}

export async function getOfflineAIModelStatus(): Promise<{ installed: boolean; sizeBytes: number }> {
  try {
    const [deblurInfo, superResInfo] = await Promise.all([
      FileSystem.getInfoAsync(localModelUri()),
      FileSystem.getInfoAsync(superResolutionModelUri()),
    ]);
    const deblurBytes = deblurInfo.exists ? Number(deblurInfo.size || 0) : 0;
    const superResBytes = superResInfo.exists ? Number(superResInfo.size || 0) : 0;
    const installed = deblurBytes >= MIN_MODEL_BYTES && superResBytes >= SUPER_RES_MIN_BYTES;
    return { installed, sizeBytes: deblurBytes + superResBytes };
  } catch {
    return { installed: false, sizeBytes: 0 };
  }
}

async function ensureModel(onStatus?: (message: string) => void): Promise<string> {
  const uri = localModelUri();
  const current = await FileSystem.getInfoAsync(uri);
  if (current.exists && (current.size || 0) >= MIN_MODEL_BYTES) return uri;

  onStatus?.("Preparing AI model download…");
  const directory = uri.slice(0, uri.lastIndexOf("/") + 1);
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  try { if (current.exists) await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
  const downloadTask = FileSystem.createDownloadResumable(MODEL_URL, uri, {}, progress => {
    const received = Number(progress.totalBytesWritten || 0);
    const total = Number(progress.totalBytesExpectedToWrite || 0);
    if (total > 0) {
      const percent = Math.max(0, Math.min(100, Math.floor(received / total * 100)));
      onStatus?.("Downloading AI model: " + percent + "% (" + (received / (1024 * 1024)).toFixed(1) + " / " + (total / (1024 * 1024)).toFixed(1) + " MB). Keep internet connected.");
    } else {
      onStatus?.("Downloading AI model: " + (received / (1024 * 1024)).toFixed(1) + " MB received…");
    }
  });
  const downloaded = await downloadTask.downloadAsync();
  if (!downloaded) throw new Error("The AI model download was cancelled. Tap AI Enhance to try again.");
  const info = await FileSystem.getInfoAsync(downloaded.uri);
  if (downloaded.status < 200 || downloaded.status >= 300 || !info.exists || (info.size || 0) < MIN_MODEL_BYTES) {
    try { await FileSystem.deleteAsync(downloaded.uri, { idempotent: true }); } catch {}
    throw new Error("The AI model download was incomplete. Connect to the internet and try again.");
  }
  return downloaded.uri;
}

function superResolutionModelUri(): string {
  const root = FileSystem.documentDirectory || FileSystem.cacheDirectory;
  if (!root) throw new Error("Private app storage is unavailable.");
  return root + "ai-models/" + SUPER_RES_MODEL_NAME;
}

function swinirModelUri(): string {
  const root = FileSystem.documentDirectory || FileSystem.cacheDirectory;
  if (!root) throw new Error("Private app storage is unavailable.");
  return root + "ai-models/" + SWINIR_MODEL_NAME;
}

async function getSwinIRSession(onStatus?: (message: string) => void): Promise<InferenceSession> {
  if (!swinirSessionPromise) {
    swinirSessionPromise = (async () => {
      const uri = swinirModelUri();
      const current = await FileSystem.getInfoAsync(uri);
      let modelUri = uri;
      if (!current.exists || Number(current.size || 0) < SWINIR_MIN_BYTES) {
        onStatus?.("Downloading SwinIR high-detail model (~110 MB)…");
        const directory = uri.slice(0, uri.lastIndexOf("/") + 1);
        await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
        try { if (current.exists) await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
        const task = FileSystem.createDownloadResumable(SWINIR_MODEL_URL, uri, {}, progress => {
          const received = Number(progress.totalBytesWritten || 0);
          const total = Number(progress.totalBytesExpectedToWrite || 0);
          if (total > 0) {
            const percent = Math.max(0, Math.min(100, Math.floor(received / total * 100)));
            onStatus?.("Downloading SwinIR: " + percent + "% (" + (received / (1024 * 1024)).toFixed(1) + " / " + (total / (1024 * 1024)).toFixed(1) + " MB).");
          } else {
            onStatus?.("Downloading SwinIR: " + (received / (1024 * 1024)).toFixed(1) + " MB received…");
          }
        });
        const downloaded = await task.downloadAsync();
        if (!downloaded) throw new Error("SwinIR download was cancelled. Connect to the internet and try again.");
        const info = await FileSystem.getInfoAsync(downloaded.uri);
        if (downloaded.status < 200 || downloaded.status >= 300 || !info.exists || Number(info.size || 0) < SWINIR_MIN_BYTES) {
          try { await FileSystem.deleteAsync(downloaded.uri, { idempotent: true }); } catch {}
          throw new Error("SwinIR download was incomplete. Connect to the internet and try again.");
        }
        modelUri = downloaded.uri;
      }
      onStatus?.("Loading SwinIR transformer model on this phone…");
      const session = await InferenceSession.create(modelUri.replace(/^file:\/\//, ""));
      if (!session.inputNames.includes("image") || !session.outputNames.includes("upscaled")) {
        throw new Error("The SwinIR model input/output did not match the expected model format.");
      }
      return session;
    })().catch(error => {
      swinirSessionPromise = null;
      throw error;
    });
  }
  return swinirSessionPromise;
}

/**
 * SwinIR real-world super-resolution uses fixed 64x64 RGB tiles and returns
 * 4x output. Downsample to 2x for manageable patient-photo size and memory.
 */
async function runSwinIRSuperResolution(
  pixels: Uint8Array,
  width: number,
  height: number,
  onStatus?: (message: string) => void,
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const session = await getSwinIRSession(onStatus);
  const outputWidth = width * 2;
  const outputHeight = height * 2;
  const output = new Uint8Array(outputWidth * outputHeight * 4);
  const tile = SWINIR_TILE;
  const planeSize = tile * tile;
  const tilesX = Math.ceil(width / tile);
  const tilesY = Math.ceil(height / tile);
  let completed = 0;

  for (let top = 0; top < height; top += tile) {
    for (let left = 0; left < width; left += tile) {
      const input = new Float32Array(3 * planeSize);
      for (let y = 0; y < tile; y++) {
        const sy = Math.min(height - 1, top + y);
        for (let x = 0; x < tile; x++) {
          const sx = Math.min(width - 1, left + x);
          const sourceIndex = (sy * width + sx) * 4;
          const p = y * tile + x;
          input[p] = pixels[sourceIndex] / 255;
          input[planeSize + p] = pixels[sourceIndex + 1] / 255;
          input[2 * planeSize + p] = pixels[sourceIndex + 2] / 255;
        }
      }
      const feeds: Record<string, Tensor> = {
        image: new Tensor("float32", input, [1, 3, tile, tile]),
      };
      const resultMap = await session.run(feeds, ["upscaled"]);
      const resultTensor = resultMap.upscaled;
      const superWidth = tile * 4;
      const superPlaneSize = superWidth * superWidth;
      if (!resultTensor || !resultTensor.data || resultTensor.data.length < 3 * superPlaneSize) {
        throw new Error("SwinIR returned an unexpected output size.");
      }
      const restored = resultTensor.data as Float32Array;
      const copyWidth = Math.min(tile, width - left);
      const copyHeight = Math.min(tile, height - top);
      for (let y = 0; y < copyHeight * 2; y++) {
        for (let x = 0; x < copyWidth * 2; x++) {
          const oy = y * 2, ox = x * 2;
          const dest = (((top * 2 + y) * outputWidth) + left * 2 + x) * 4;
          for (let channel = 0; channel < 3; channel++) {
            const base = channel * superPlaneSize;
            const v = (
              restored[base + oy * superWidth + ox] +
              restored[base + oy * superWidth + ox + 1] +
              restored[base + (oy + 1) * superWidth + ox] +
              restored[base + (oy + 1) * superWidth + ox + 1]
            ) * 63.75;
            output[dest + channel] = Math.max(0, Math.min(255, Math.round(v)));
          }
          output[dest + 3] = 255;
        }
      }
      completed++;
      // Batch progress/yields to reduce per-tile scheduling overhead.
      if (completed % 4 === 0 || completed === tilesX * tilesY) {
        onStatus?.("SwinIR high-detail reconstruction " + completed + "/" + (tilesX * tilesY) + "…");
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
  }
  return { pixels: output, width: outputWidth, height: outputHeight };
}

async function getSuperResolutionSession(onStatus?: (message: string) => void): Promise<InferenceSession> {
  if (!superResolutionSessionPromise) {
    superResolutionSessionPromise = (async () => {
      const uri = superResolutionModelUri();
      const current = await FileSystem.getInfoAsync(uri);
      let modelUri = uri;
      if (!current.exists || Number(current.size || 0) < SUPER_RES_MIN_BYTES) {
        onStatus?.("Downloading trained photo-restoration AI model…");
        const directory = uri.slice(0, uri.lastIndexOf("/") + 1);
        await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
        try { if (current.exists) await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
        const task = FileSystem.createDownloadResumable(SUPER_RES_MODEL_URL, uri, {}, progress => {
          const received = Number(progress.totalBytesWritten || 0);
          const total = Number(progress.totalBytesExpectedToWrite || 0);
          if (total > 0) {
            const percent = Math.max(0, Math.min(100, Math.floor(received / total * 100)));
            onStatus?.("Downloading restoration AI: " + percent + "% (" + (received / (1024 * 1024)).toFixed(1) + " / " + (total / (1024 * 1024)).toFixed(1) + " MB).");
          } else {
            onStatus?.("Downloading restoration AI: " + (received / (1024 * 1024)).toFixed(1) + " MB received…");
          }
        });
        const downloaded = await task.downloadAsync();
        if (!downloaded) throw new Error("The photo-restoration model download was cancelled. Connect to the internet and try AI Enhance again.");
        const info = await FileSystem.getInfoAsync(downloaded.uri);
        if (downloaded.status < 200 || downloaded.status >= 300 || !info.exists || Number(info.size || 0) < SUPER_RES_MIN_BYTES) {
          try { await FileSystem.deleteAsync(downloaded.uri, { idempotent: true }); } catch {}
          throw new Error("The photo-restoration model download was incomplete. Connect to the internet and try again.");
        }
        modelUri = downloaded.uri;
      }
      onStatus?.("Loading trained super-resolution model on this phone…");
      const session = await InferenceSession.create(modelUri.replace(/^file:\/\//, ""));
      const input = session.inputNames[0];
      const output = session.outputNames[0];
      if (!input || !output) throw new Error("The photo-restoration model has no usable input or output.");
      return session;
    })().catch(error => {
      superResolutionSessionPromise = null;
      throw error;
    });
  }
  return superResolutionSessionPromise;
}

/**
 * Run a learned Real-ESRGAN model in overlapping context tiles. The model
 * produces 4x detail; 2x output is retained to keep phone memory and photo
 * storage practical. Context is cropped before stitching to reduce tile seams.
 */
async function runLearnedSuperResolution(
  pixels: Uint8Array,
  width: number,
  height: number,
  onStatus?: (message: string) => void,
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const session = await getSuperResolutionSession(onStatus);
  const outputWidth = width * 2;
  const outputHeight = height * 2;
  const output = new Uint8Array(outputWidth * outputHeight * 4);
  const tile = SUPER_RES_TILE;
  const context = SUPER_RES_CONTEXT;
  const patchSize = tile + context * 2;
  const planeSize = patchSize * patchSize;
  const tilesX = Math.ceil(width / tile);
  const tilesY = Math.ceil(height / tile);
  let completed = 0;

  for (let top = 0; top < height; top += tile) {
    for (let left = 0; left < width; left += tile) {
      const input = new Float32Array(3 * planeSize);
      for (let y = 0; y < patchSize; y++) {
        const sy = Math.max(0, Math.min(height - 1, top + y - context));
        for (let x = 0; x < patchSize; x++) {
          const sx = Math.max(0, Math.min(width - 1, left + x - context));
          const sourceIndex = (sy * width + sx) * 4;
          const p = y * patchSize + x;
          input[p] = pixels[sourceIndex] / 255;
          input[planeSize + p] = pixels[sourceIndex + 1] / 255;
          input[2 * planeSize + p] = pixels[sourceIndex + 2] / 255;
        }
      }

      const feeds: Record<string, Tensor> = {};
      feeds[session.inputNames[0]] = new Tensor("float32", input, [1, 3, patchSize, patchSize]);
      const resultMap = await session.run(feeds, [session.outputNames[0]]);
      const resultTensor = resultMap[session.outputNames[0]];
      const superWidth = patchSize * 4;
      const superPlaneSize = superWidth * superWidth;
      if (!resultTensor || !resultTensor.data || resultTensor.data.length < 3 * superPlaneSize) {
        throw new Error("The photo-restoration model returned an unexpected output size.");
      }
      const restored = resultTensor.data as Float32Array;
      const copyWidth = Math.min(tile, width - left);
      const copyHeight = Math.min(tile, height - top);
      for (let y = 0; y < copyHeight * 2; y++) {
        const oy = (context * 4) + y * 2;
        for (let x = 0; x < copyWidth * 2; x++) {
          const ox = (context * 4) + x * 2;
          const dest = (((top * 2 + y) * outputWidth) + left * 2 + x) * 4;
          for (let channel = 0; channel < 3; channel++) {
            const base = channel * superPlaneSize;
            const v = (
              restored[base + oy * superWidth + ox] +
              restored[base + oy * superWidth + ox + 1] +
              restored[base + (oy + 1) * superWidth + ox] +
              restored[base + (oy + 1) * superWidth + ox + 1]
            ) * 63.75;
            output[dest + channel] = Math.max(0, Math.min(255, Math.round(v)));
          }
          output[dest + 3] = 255;
        }
      }
      completed++;
      onStatus?.("AI detail reconstruction " + completed + "/" + (tilesX * tilesY) + "…");
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  return { pixels: output, width: outputWidth, height: outputHeight };
}

async function getSession(onStatus?: (message: string) => void): Promise<InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const uri = await ensureModel(onStatus);
      onStatus?.("Loading on-device AI…");
      return InferenceSession.create(uri.replace(/^file:\/\//, ""));
    })().catch(error => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

/**
 * Apply a conservative local contrast and luminance-sharpening pass after NAFNet.
 * The deblurring model can legitimately return nearly identical pixels for a
 * sharp input; this pass makes document text and edges clearer without relying
 * on the model alone. Processing stays entirely on-device.
 */
function sharpenAndImproveContrast(pixels: Uint8Array, width: number, height: number): Uint8Array {
  // Work from a copy so every pixel is processed from the same source frame.
  // This adaptive multi-pass is intentionally conservative around flat/noisy
  // regions and stronger on edges, where document text and faded photo detail live.
  const source = pixels.slice();
  const result = pixels;
  const luma = new Float32Array(width * height);
  for (let i = 0, p = 0; i < source.length; i += 4, p++) {
    luma[p] = 0.2126 * source[i] + 0.7152 * source[i + 1] + 0.0722 * source[i + 2];
  }
  const at = (x: number, y: number) => y * width + x;
  for (let y = 0; y < height; y++) {
    const ym = Math.max(0, y - 1), yp = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(width - 1, x + 1);
      const center = luma[at(x, y)];
      // Gaussian-like 3x3 neighborhood; avoids the harsher halos of a simple
      // high-radius sharpen and remains cheap enough for mid-range phones.
      const blur = (
        luma[at(xm, ym)] + 2 * luma[at(x, ym)] + luma[at(xp, ym)] +
        2 * luma[at(xm, y)] + 4 * center + 2 * luma[at(xp, y)] +
        luma[at(xm, yp)] + 2 * luma[at(x, yp)] + luma[at(xp, yp)]
      ) / 16;
      const edge = center - blur;
      const localMin = Math.min(center, luma[at(xm, y)], luma[at(xp, y)], luma[at(x, ym)], luma[at(x, yp)]);
      const localMax = Math.max(center, luma[at(xm, y)], luma[at(xp, y)], luma[at(x, ym)], luma[at(x, yp)]);
      const localRange = localMax - localMin;
      // Boost local contrast more on faded/low-contrast areas, but avoid
      // exaggerating already crisp edges or amplifying grain in flat shadows.
      const contrastGain = localRange < 24 ? 1.22 : localRange < 60 ? 1.12 : 1.045;
      const edgeGain = localRange < 8 ? 0.35 : localRange < 24 ? 1.65 : 1.25;
      const i = (y * width + x) * 4;
      const oldR = source[i], oldG = source[i + 1], oldB = source[i + 2];
      const oldY = 0.2126 * oldR + 0.7152 * oldG + 0.0722 * oldB;
      const contrastY = (oldY - 127.5) * contrastGain + 127.5;
      const targetY = Math.max(0, Math.min(255, contrastY + edge * edgeGain));
      // Apply luminance changes proportionally to preserve the photo's original
      // color balance and skin tones rather than turning old photos grayscale.
      const delta = targetY - oldY;
      for (let channel = 0; channel < 3; channel++) {
        const value = source[i + channel] + delta;
        result[i + channel] = Math.max(0, Math.min(255, Math.round(value)));
      }
      result[i + 3] = source[i + 3];
    }
  }
  return result;
}

/**
 * NAFNet runs entirely on this device. Only public model weights are downloaded;
 * image bytes are decoded and inferred locally and never uploaded. The output
 * is a new JPEG preview; the caller keeps the original until explicitly saved.
 */
export async function enhanceImageWithOfflineAI(
  dataUrl: string,
  onStatus?: (message: string) => void,
  mode: "balanced" | "high-detail" = "balanced",
): Promise<string> {
  const match = String(dataUrl || "").match(/^data:image\/(?:jpeg|jpg);base64,([\s\S]+)$/i);
  if (!match?.[1]) throw new Error("The selected image was not a supported JPEG.");
  const encodedInput = Buffer.from(match[1], "base64");
  const decoded = jpeg.decode(encodedInput, { useTArray: true, formatAsRGBA: true });
  const width = decoded.width;
  const height = decoded.height;
  const maxSideForMode = mode === "high-detail" ? 1024 : MAX_IMAGE_SIDE;
  if (!width || !height || width > maxSideForMode || height > maxSideForMode || width * height > maxSideForMode * maxSideForMode) {
    throw new Error(mode === "high-detail"
      ? "SwinIR high-detail mode is limited to 1024 pixels on the longest side to protect phone memory. Choose Balanced mode for larger photos."
      : "The AI image is too large to process safely. Please reopen the photo and try again; AI processing is limited to 1536 pixels on the longest side to prevent the app from freezing.");
  }

  const source = decoded.data;
  let output: Uint8Array;
  if (mode === "balanced") {
    const source = decoded.data;
  let output: Uint8Array;
  if (mode === "balanced") {
  const session = await getSession(onStatus);
  if (!session.inputNames.length || !session.outputNames.length) {
    throw new Error("The AI model did not expose a valid input and output.");
  }
  onStatus?.("AI is restoring image tiles locally…");

  output = new Uint8Array(width * height * 4);
  const planeSize = TILE_SIZE * TILE_SIZE;
  const tileCount = Math.ceil(width / TILE_SIZE) * Math.ceil(height / TILE_SIZE);
  let completed = 0;

  for (let top = 0; top < height; top += TILE_SIZE) {
    for (let left = 0; left < width; left += TILE_SIZE) {
      const input = new Float32Array(3 * planeSize);
      for (let y = 0; y < TILE_SIZE; y++) {
        if (y > 0 && y % 32 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
        const sy = Math.min(height - 1, top + y);
        for (let x = 0; x < TILE_SIZE; x++) {
          const sx = Math.min(width - 1, left + x);
          const sourceIndex = (sy * width + sx) * 4;
          const pixel = y * TILE_SIZE + x;
          input[pixel] = source[sourceIndex] / 255;
          input[planeSize + pixel] = source[sourceIndex + 1] / 255;
          input[2 * planeSize + pixel] = source[sourceIndex + 2] / 255;
        }
      }

      const feeds: Record<string, Tensor> = {};
      feeds[session.inputNames[0]] = new Tensor("float32", input, [1, 3, TILE_SIZE, TILE_SIZE]);
      const resultMap = await session.run(feeds, [session.outputNames[0]]);
      const resultTensor = resultMap[session.outputNames[0]];
      if (!resultTensor || !resultTensor.data || resultTensor.data.length < 3 * planeSize) {
        throw new Error("The AI model returned an unexpected image shape.");
      }
      const pixels = resultTensor.data as Float32Array;
      const tileWidth = Math.min(TILE_SIZE, width - left);
      const tileHeight = Math.min(TILE_SIZE, height - top);
      for (let y = 0; y < tileHeight; y++) {
        if (y > 0 && y % 32 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
        for (let x = 0; x < tileWidth; x++) {
          const p = y * TILE_SIZE + x;
          const destination = ((top + y) * width + left + x) * 4;
          output[destination] = Math.max(0, Math.min(255, Math.round(pixels[p] * 255)));
          output[destination + 1] = Math.max(0, Math.min(255, Math.round(pixels[planeSize + p] * 255)));
          output[destination + 2] = Math.max(0, Math.min(255, Math.round(pixels[2 * planeSize + p] * 255)));
          output[destination + 3] = 255;
        }
      }
      completed++;
      onStatus?.("AI restoring tiles " + completed + "/" + tileCount + "…");
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  } else {
    // SwinIR is itself a learned restoration model. Skip the separate NAFNet
    // inference pass in high-detail mode to avoid doing two full model passes.
    onStatus?.("Preparing image for SwinIR transformer AI…");
    output = new Uint8Array(source);
  }
  onStatus?.("Deblurring and recovering contrast locally…");
  const enhancedPixels = sharpenAndImproveContrast(output, width, height);
  onStatus?.(mode === "high-detail" ? "Reconstructing detail with SwinIR transformer AI…" : "Reconstructing photo detail with Real-ESRGAN AI…");
  const restored = mode === "high-detail"
    ? await runSwinIRSuperResolution(enhancedPixels, width, height, onStatus)
    : await runLearnedSuperResolution(enhancedPixels, width, height, onStatus);
  onStatus?.("Encoding higher-resolution AI result…");
  const encoded = jpeg.encode({ data: restored.pixels, width: restored.width, height: restored.height }, 92);
  return "data:image/jpeg;base64," + Buffer.from(encoded.data).toString("base64");
}
