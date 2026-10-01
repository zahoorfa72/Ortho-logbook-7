export function uniqueDisplayParts(...parts: unknown[]): string[] {
  const seen = new Set<string>();
  return parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function formatInventoryLabel(category?: unknown, name?: unknown, size?: unknown, separator = " · "): string {
  return uniqueDisplayParts(category, name, size).join(separator);
}
