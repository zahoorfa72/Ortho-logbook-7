const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const { FileStore } = require("metro-cache");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

const cacheRoot =
  process.env.METRO_CACHE_ROOT || path.join(projectRoot, ".metro-cache");

config.cacheStores = [
  new FileStore({ root: path.join(cacheRoot, "cache") }),
];

config.maxWorkers = 2;

module.exports = config;
