// metro.config.js
const { getDefaultConfig } = require("expo/metro-config");
const path = require('path');
const { FileStore } = require('metro-cache');

const config = getDefaultConfig(__dirname);

// expo-sqlite's web worker imports its SQLite WebAssembly binary.
// Treat .wasm files as assets so Metro resolves and emits the binary correctly.
if (!config.resolver.assetExts.includes('wasm')) {
  config.resolver.assetExts.push('wasm');
}

// Preserve conditional package exports used by Expo's platform-specific modules.
config.resolver.unstable_enablePackageExports = true;

// Use a stable on-disk store (shared across web/android)
const root = process.env.METRO_CACHE_ROOT || path.join(__dirname, '.metro-cache');
config.cacheStores = [
  new FileStore({ root: path.join(root, 'cache') }),
];

// // Exclude unnecessary directories from file watching
// config.watchFolders = [__dirname];
// config.resolver.blacklistRE = /(.*)\\/(__tests__|android|ios|build|dist|.git|node_modules\\/.*\\/android|node_modules\\/.*\\/ios|node_modules\\/.*\\/windows|node_modules\\/.*\\/macos)(\\/.*)?$/;

// // Alternative: use a more aggressive exclusion pattern
// config.resolver.blacklistRE = /node_modules\\/.*\\/(android|ios|windows|macos|__tests__|\\.git|.*\\.android\\.js|.*\\.ios\\.js)$/;

// Reduce the number of workers to decrease resource usage
config.maxWorkers = 2;

module.exports = config;
