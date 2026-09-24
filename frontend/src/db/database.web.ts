// Web is not a supported runtime for this app (SQLite needs cross-origin
// isolation on web that our preview cannot supply). We ship a light stub so
// the bundle still loads and the app can show a "please open on Android"
// screen instead of crashing at import time.

const notSupported = () => {
  throw new Error(
    "Offline database is not available in the web preview. Open Ortho Logbook on your Android phone with Expo Go.",
  );
};

export const db = {
  execSync: notSupported,
  getAllSync: () => [] as any[],
  getFirstSync: () => null as any,
  runSync: notSupported,
  withTransactionSync: (fn: () => any) => fn(),
} as any;

export function initializeDatabase() {
  // no-op on web
}
