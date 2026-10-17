const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");

const RELATIVE_MODULE_PATH = path.join(
  "node_modules", "expo-ocr-kit", "android", "src", "main", "java",
  "expo", "modules", "ocrkit", "ExpoOcrKitModule.kt"
);
const START_MARKER = "  private fun mapRecognitionResult(result: Text, scaleFactor: Int): Map<String, Any> {";
const END_MARKER = "\n  private fun createInputImage";

module.exports = function withOcrWordBoxes(config) {
  return withDangerousMod(config, ["android", async (modConfig) => {
    const modulePath = path.join(modConfig.modRequest.projectRoot, RELATIVE_MODULE_PATH);
    let source;
    try {
      source = await fs.promises.readFile(modulePath, "utf8");
    } catch (error) {
      throw new Error("OCR word-box patch could not locate expo-ocr-kit Android source at " + modulePath + ". " + String(error));
    }
    if (source.includes('"text" to element.text') && source.includes("block.lines.flatMap")) {
      return modConfig;
    }

    const start = source.indexOf(START_MARKER);
    const end = source.indexOf(END_MARKER, start);
    if (start < 0 || end < 0) {
      throw new Error("OCR word-box patch could not find the expected expo-ocr-kit mapRecognitionResult implementation.");
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