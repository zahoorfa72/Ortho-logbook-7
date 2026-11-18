export type LowStockEventCandidate = {
  id: string;
  name?: unknown;
  category?: unknown;
  size?: unknown;
  unit?: unknown;
  quantity?: unknown;
  minimumStock?: unknown;
  minimum_stock?: unknown;
  lowStockEventAt?: string;
  lowStockEventType?: string;
};

export type CurrentInventoryStock = {
  id: string;
  name?: unknown;
  category?: unknown;
  size?: unknown;
  unit?: unknown;
  quantity: unknown;
  minimumStock?: unknown;
  minimum_stock?: unknown;
};

export type CurrentLowStockReportItem = Omit<LowStockEventCandidate, "quantity" | "minimumStock" | "minimum_stock"> & {
  quantity: number;
  minimumStock: number;
  unit: string;
};

/**
 * Keep period-qualified low-stock events only while the item is still low at
 * report-generation time. Historical event date/type are preserved, while
 * displayed stock and minimum are refreshed from the current inventory row.
 */
export function filterCurrentlyLowStockEvents(
  events: LowStockEventCandidate[],
  currentInventory: CurrentInventoryStock[],
): CurrentLowStockReportItem[] {
  const currentById = new Map<string, CurrentInventoryStock>();
  for (const item of currentInventory) {
    const id = String(item?.id ?? "").trim();
    if (id) currentById.set(id, item);
  }

  const result: CurrentLowStockReportItem[] = [];
  for (const event of events) {
    const id = String(event?.id ?? "").trim();
    if (!id) continue;
    const current = currentById.get(id);
    if (!current) continue;

    const quantity = Number(current.quantity);
    const minimumStock = Number(current.minimumStock ?? current.minimum_stock);
    if (!Number.isFinite(quantity) || !Number.isFinite(minimumStock) || quantity > minimumStock) {
      continue;
    }

    result.push({
      ...event,
      id,
      name: String(current.name || event.name || "Inventory item").trim(),
      category: String(current.category || event.category || "").trim(),
      size: String(current.size || event.size || "").trim(),
      unit: String(current.unit || event.unit || "pcs").trim() || "pcs",
      quantity,
      minimumStock,
    });
  }
  return result;
}
