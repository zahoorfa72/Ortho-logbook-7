#!/usr/bin/env node
"use strict";

/**
 * Work around an Android native crash in expo-sqlite 57.
 *
 * On Android, expo-sqlite 57 destroys native statement/database bindings from
 * sharedObjectDidRelease(). A GC release can race with an in-flight SQLite
 * call and free the binding while JNI is using it. Keep this patch limited to
 * Android source; iOS keeps the upstream implementation.
 *
 * expo-sqlite's Android precompiled AAR is bypassed by the app config
 * (android.enableFTS=true), so these patched Kotlin files are compiled into
 * the APK. Fail the install if the expected upstream source changes so a
 * future dependency update cannot silently ship an unpatched build.
 */

const fs = require("node:fs");
const path = require("node:path");

// Yarn Classic may hoist expo-sqlite to the repository-level node_modules
// when the frontend is installed from a workspace/root lockfile. Check both
// locations rather than assuming the dependency is nested under frontend.
const sqliteAndroidCandidates = [
  path.resolve(__dirname, "../node_modules/expo-sqlite/android/src/main/java/expo/modules/sqlite"),
  path.resolve(__dirname, "../../node_modules/expo-sqlite/android/src/main/java/expo/modules/sqlite"),
];
const sqliteAndroid = sqliteAndroidCandidates.find((candidate) =>
  fs.existsSync(path.join(candidate, "NativeDatabase.kt"))
);

if (!sqliteAndroid) {
  throw new Error(
    "[patch-expo-sqlite-android] Could not find NativeDatabase.kt. Checked: " +
    sqliteAndroidCandidates.join(", ") +
    ". Check the installed expo-sqlite package location/version."
  );
}

function patchFile(fileName, marker, original, replacement) {
  const filePath = path.join(sqliteAndroid, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      "[patch-expo-sqlite-android] Missing " + fileName +
      ". Check the installed expo-sqlite version and Android source layout."
    );
  }

  const source = fs.readFileSync(filePath, "utf8");
  if (source.includes(marker)) {
    console.log("[patch-expo-sqlite-android] Already patched: " + fileName);
    return;
  }
  if (!source.includes(original)) {
    throw new Error(
      "[patch-expo-sqlite-android] Expected release method not found in " +
      fileName + "; refusing to build an unpatched Android SQLite binary."
    );
  }
  fs.writeFileSync(filePath, source.replace(original, replacement), "utf8");
  console.log("[patch-expo-sqlite-android] Patched " + fileName);
}

patchFile(
  "NativeDatabase.kt",
  "ORTHO_SQLITE57_DATABASE_RELEASE_GUARD",
  `  override fun sharedObjectDidRelease() {
    super.sharedObjectDidRelease()
    this.ref.close()
  }`,
  `  override fun sharedObjectDidRelease() {
    super.sharedObjectDidRelease()
    // ORTHO_SQLITE57_DATABASE_RELEASE_GUARD
    // A cached native database may have multiple JS wrappers. Releasing one
    // wrapper must not destroy the native binding while another wrapper uses it.
    // The native binding is released after the database has explicitly closed.
    if (isClosed) {
      this.ref.close()
    }
  }`
);

patchFile(
  "NativeStatement.kt",
  "ORTHO_SQLITE57_STATEMENT_RELEASE_GUARD",
  `  override fun sharedObjectDidRelease() {
    super.sharedObjectDidRelease()
    this.ref.close()
  }`,
  `  override fun sharedObjectDidRelease() {
    super.sharedObjectDidRelease()
    // ORTHO_SQLITE57_STATEMENT_RELEASE_GUARD
    // Do not destroy a native statement binding from GC: its release can race
    // a SQLite call dispatched on Android's IO thread pool and cause a native
    // use-after-free. Explicit statement finalization / database close owns
    // the SQLite statement lifecycle, matching the iOS implementation.
  }`
);
