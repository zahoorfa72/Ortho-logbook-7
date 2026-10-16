import { Buffer } from "buffer";
import * as jpeg from "jpeg-js";
import * as FileSystem from "expo-file-system/legacy";
import { InferenceSession, Tensor } from "onnxruntime-react-native";

const MODEL_URL = "https://huggingface.co/opencv/deblurring_nafnet/resolve/main/deblurring_nafnet_2025may.onnx";
const MODEL_NAME = "deblurring_nafnet_2025may.onnx";
const TILE_SIZE = 512;
const MAX_IMAGE_SIDE = 1536;
const MIN_MODEL_BYTES = 80 * 1024 * 1024;

let sessionPromise: Promise<InferenceSession> | null = null;

function localModelUri(): string {
  const root = FileSystem.documentDirectory || FileSystem.cacheDirectory;
  if (!root) throw new Error("Private app storage is unavailable.");
  return root + "ai-models/" + MODEL_NAME;
}

export async function getOfflineAIModelStatus(): Promise<{ installed: boolean; sizeBytes: number }> {
  try {
    const info = await FileSystem.getInfoAsync(localModelUri());
    const sizeBytes = info.exists ? Number(info.size || 0) : 0;
    return { installed: !!info.exists && sizeBytes >= MIN_MODEL_BYTES, sizeBytes };
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
 * NAFNet runs entirely on this device. Only public model weights are downloaded;
 * image bytes are decoded and inferred locally and never uploaded. The output
 * is a new JPEG preview; the caller keeps the original until explicitly saved.
 */
export async function enhanceImageWithOfflineAI(
  dataUrl: string,
  onStatus?: (message: string) => void,
): Promise<string> {
  const match = String(dataUrl || "").match(/^data:image\/(?:jpeg|jpg);base64,([\s\S]+)$/i);
  if (!match?.[1]) throw new Error("The selected image was not a supported JPEG.");
  const encodedInput = Buffer.from(match[1], "base64");
  const decoded = jpeg.decode(encodedInput, { useTArray: true, formatAsRGBA: true });
  const width = decoded.width;
  const height = decoded.height;
  if (!width || !height || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_SIDE * MAX_IMAGE_SIDE) {
    throw new Error("The AI image is too large to process safely. Please reopen the photo and try again; AI processing is limited to 1536 pixels on the longest side to prevent the app from freezing.");
  }

  const session = await getSession(onStatus);
  if (!session.inputNames.length || !session.outputNames.length) {
    throw new Error("The AI model did not expose a valid input and output.");
  }
  onStatus?.("AI is restoring image tiles locally…");

  const source = decoded.data;
  const output = new Uint8Array(width * height * 4);
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

  onStatus?.("Preparing enhanced preview…");
  const encoded = jpeg.encode({ data: output, width, height }, 94);
  return "data:image/jpeg;base64," + Buffer.from(encoded.data).toString("base64");
}
