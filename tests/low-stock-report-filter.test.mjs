import test from "node:test";
import assert from "node:assert/strict";
import { filterCurrentlyLowStockEvents } from "../frontend/src/utils/low-stock-report-filter.ts";

const event = (id, extra = {}) => ({
  id, name: `Item ${id}`, category: "Plate", size: "5-hole", unit: "pcs",
  quantity: 0, minimumStock: 1,
  lowStockEventAt: "2026-11-05T10:00:00.000Z",
  lowStockEventType: "OUT OF STOCK",
  ...extra,
});

test("excludes an item restocked above minimum before scheduled send", () => {
  const result = filterCurrentlyLowStockEvents(
    [event("recovered")],
    [{ id: "recovered", quantity: 4, minimumStock: 1 }],
  );
  assert.deepEqual(result, []);
});

test("includes an item restocked but still below minimum using current quantity", () => {
  const [result] = filterCurrentlyLowStockEvents(
    [event("still-low")],
    [{ id: "still-low", name: "Updated item name", quantity: 1, minimumStock: 3, unit: "pcs" }],
  );
  assert.equal(result.quantity, 1);
  assert.equal(result.minimumStock, 3);
  assert.equal(result.name, "Updated item name");
  assert.equal(result.lowStockEventAt, "2026-11-05T10:00:00.000Z");
  assert.equal(result.lowStockEventType, "OUT OF STOCK");
});

test("includes items that remain out of stock when minimum is zero", () => {
  const [result] = filterCurrentlyLowStockEvents(
    [event("zero-min", { minimumStock: 0 })],
    [{ id: "zero-min", quantity: 0, minimum_stock: 0 }],
  );
  assert.equal(result.quantity, 0);
  assert.equal(result.minimumStock, 0);
});

test("excludes deleted items and invalid current balances", () => {
  const result = filterCurrentlyLowStockEvents(
    [event("deleted"), event("invalid")],
    [{ id: "invalid", quantity: "unknown", minimum_stock: 1 }],
  );
  assert.deepEqual(result, []);
});

test("uses the current minimum when the configured threshold changes", () => {
  const result = filterCurrentlyLowStockEvents(
    [event("threshold-changed")],
    [{ id: "threshold-changed", quantity: 2, minimumStock: 1 }],
  );
  assert.deepEqual(result, []);
});
