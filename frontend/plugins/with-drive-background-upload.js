const { withAndroidManifest, withMainApplication, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const packageName = (config) => config.android && config.android.package;
const withDriveBackgroundUpload = (config) => {
  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    manifest["uses-permission"] = manifest["uses-permission"] || [];
    const permissions = [
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
      "android.permission.INTERNET",
      "android.permission.POST_NOTIFICATIONS"
    ];
    for (const name of permissions) {
      if (!manifest["uses-permission"].some((item) => item.$["android:name"] === name)) {
        manifest["uses-permission"].push({ $: { "android:name": name } });
      }
    }
    const app = manifest.application && manifest.application[0];
    if (app) {
      app.service = app.service || [];
      const serviceName = packageName(mod) + ".DriveBackgroundUploadService";
      if (!app.service.some((item) => item.$ && item.$["android:name"] === serviceName)) {
        app.service.push({
          $: {
            "android:name": serviceName,
            "android:exported": "false",
            "android:foregroundServiceType": "dataSync"
          }
        });
      }
    }
    return mod;
  });

  config = withMainApplication(config, (mod) => {
    const pkg = packageName(mod);
    let source = mod.modResults.contents;
    const importLine = "import " + pkg + ".DriveBackgroundUploadPackage";
    if (!source.includes(importLine)) {
      const packageMatch = source.match(/^package [^\n]+\n/m);
      if (packageMatch) source = source.replace(packageMatch[0], packageMatch[0] + "\n" + importLine + "\n");
    }
    if (!source.includes("add(DriveBackgroundUploadPackage())")) {
      const marker = "PackageList(this).packages.apply {";
      if (source.includes(marker)) {
        source = source.replace(marker, marker + "\n              add(DriveBackgroundUploadPackage())");
      } else {
        throw new Error("Could not register DriveBackgroundUploadPackage in MainApplication.");
      }
    }
    mod.modResults.contents = source;
    return mod;
  });

  config = withDangerousMod(config, ["android", async (mod) => {
    const pkg = packageName(mod);
    if (!pkg) throw new Error("android.package is required for Drive background upload.");
    const javaDir = path.join(mod.modRequest.platformProjectRoot, "app", "src", "main", "java", ...pkg.split("."));
    await fs.promises.mkdir(javaDir, { recursive: true });
    const sourceDir = path.join(mod.modRequest.projectRoot, "plugins", "drive-background-upload-native");
    for (const file of ["DriveBackgroundUploadPackage.kt", "DriveBackgroundUploadModule.kt", "DriveBackgroundUploadService.kt"]) {
      const source = await fs.promises.readFile(path.join(sourceDir, file), "utf8");
      await fs.promises.writeFile(path.join(javaDir, file), source.replaceAll("__PACKAGE__", pkg));
    }
    return mod;
  }]);
  return config;
};
module.exports = withDriveBackgroundUpload;
