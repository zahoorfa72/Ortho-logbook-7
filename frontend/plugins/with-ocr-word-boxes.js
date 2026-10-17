const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");

const MODULE_RELATIVE_PATH = path.join(
  "android", "src", "main", "java", "expo", "modules", "ocrkit", "ExpoOcrKitModule.kt"
);
const START_MARKER = "  private fun mapRecognitionResult(result: Text, scaleFactor: Int): Map<String, Any> {";
const END_MARKER = "\n  private fun createInputImage";

async function findOcrModule(projectRoot) {
  // Yarn may hoist native dependencies to repository-root node_modules rather
  // than frontend/node_modules. Check both package roots before failing.
  const moduleRoots = [
    path.join(projectRoot, "node_modules", "expo-ocr-kit"),
    path.join(projectRoot, "..", "node_modules", "expo-ocr-kit"),
    path.join(process.cwd(), "node_modules", "expo-ocr-kit")
  ].map(candidate => path.resolve(candidate));

  const seen = new Set();
  for (const moduleRoot of moduleRoots) {
    if (seen.has(moduleRoot)) continue;
    seen.add(moduleRoot);
    const candidate = path.join(moduleRoot, MODULE_RELATIVE_PATH);
    try {
      await fs.promises.access(candidate, fs.constants.R_OK | fs.constants.W_OK);
      return candidate;
    } catch {}
  }

  // Last-resort search inside only the named package folders. This accommodates
  // package layouts that move the Kotlin file while keeping its filename stable.
  for (const moduleRoot of moduleRoots) {
    try {
      const found = await findFileRecursive(moduleRoot, "ExpoOcrKitModule.kt");
      if (found) return found;
    } catch {}
  }

  throw new Error(
    "OCR word-box patch could not find ExpoOcrKitModule.kt. Checked package roots: " +
    moduleRoots.join(", ")
  );
}

async function findFileRecursive(directory, filename) {
  let entries;
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return fullPath;
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".gradle") {
      const found = await findFileRecursive(fullPath, filename);
      if (found) return found;
    }
  }
  return null;
}

module.exports = function withOcrWordBoxes(config) {
  return withDangerousMod(config, ["android", async (modConfig) => {
    const modulePath = await findOcrModule(modConfig.modRequest.projectRoot);
    let source = await fs.promises.readFile(modulePath, "utf8");

    // Idempotent when expo prebuild is run more than once.
    if (source.includes('"text" to element.text') && source.includes("block.lines.flatMap")) {
      return modConfig;
    }

    const start = source.indexOf(START_MARKER);
    const end = source.indexOf(END_MARKER, start);
    if (start < 0 || end < 0) {
      throw new Error(
        "OCR word-box patch found " + modulePath +
        " but could not find the expected mapRecognitionResult function markers."
      );
    }

    const replacement = [
      "  private fun mapRecognitionResult(result: Text, scaleFactor: Int): Map<String, Any> {",
      "    // TextBlock rectangles cover paragraphs; line elements preserve word positions.",
      "    val wordBoxes = result.textBlocks.flatMap { block ->",
      "      block.lines.flatMap { line ->",
      "        line.elements.map { element ->",
      "          mapOf(",
      '            "text" to element.text,',
      '            "boundingBox" to rectToMap(element.boundingBox, scaleFactor)',
      "          )",
      "        }",
      "      }",
      "    }",
      '    return mapOf("text" to result.text, "blocks" to wordBoxes)',
      "  }"
    ].join("\n");

    source = source.slice(0, start) + replacement + source.slice(end);
    await fs.promises.writeFile(modulePath, source, "utf8");
    return modConfig;
  }]);
};