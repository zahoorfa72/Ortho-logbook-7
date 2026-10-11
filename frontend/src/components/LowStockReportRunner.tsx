import { useEffect } from "react";
import { AppState } from "react-native";
import { useAuth } from "@/src/auth/AuthContext";
import { attemptDueLowStockReport, loadLowStockReportConfig } from "@/src/utils/low-stock-auto-report";

export function LowStockReportRunner() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user || user.role !== "admin") return;
    let running = false;
    const run = async (fromOpenEvent = false) => {
      if (running || AppState.currentState !== "active") return;
      running = true;
      try {
        const config = await loadLowStockReportConfig();
        if (config?.schedule === "onOpen" && !fromOpenEvent) return;
        await attemptDueLowStockReport();
      } catch {}
      finally { running = false; }
    };
    void run(true);
    const timer = setInterval(() => { void run(); }, 60_000);
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void run(true); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [user?.id, user?.role]);
  return null;
}
