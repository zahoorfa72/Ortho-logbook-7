import { useEffect } from "react";
import { AppState } from "react-native";
import { useAuth } from "@/src/auth/AuthContext";
import { attemptDueLowStockReport } from "@/src/utils/low-stock-auto-report";

export function LowStockReportRunner() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user || user.role !== "admin") return;
    let running = false;
    const run = async () => {
      if (running || AppState.currentState !== "active") return;
      running = true;
      try { await attemptDueLowStockReport(); } catch {}
      finally { running = false; }
    };
    void run();
    const timer = setInterval(() => { void run(); }, 60_000);
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void run(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [user?.id, user?.role]);
  return null;
}
