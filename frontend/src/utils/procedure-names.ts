const normalizeProcedureName = (value: string) =>
  String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

const ignoredAcronymWords = new Set(["and", "of", "for", "with", "the", "to", "in", "on"]);

function explicitProcedureAcronym(fullName: string): string {
  const match = /^(.*?)\s*\(([A-Za-z][A-Za-z0-9-]{1,9})\)\s*$/.exec(String(fullName || "").trim());
  if (!match) return "";
  const words = (match[1].match(/[A-Za-z0-9]+/g) || [])
    .filter(word => !ignoredAcronymWords.has(word.toLowerCase()));
  const acronym = words.map(word => word[0]).join("");
  return normalizeProcedureName(acronym) === normalizeProcedureName(match[2])
    ? normalizeProcedureName(match[2])
    : "";
}

/**
 * Hide only a standalone abbreviation when a full procedure name explicitly
 * includes the same abbreviation in parentheses, e.g. DCP vs
 * Dynamic Compression plate (DCP). Caller-owned patient records are untouched.
 */
export function removeDuplicateProcedureAliases(names: string[]): string[] {
  const aliases = new Set(
    (Array.isArray(names) ? names : [])
      .map(explicitProcedureAcronym)
      .filter(Boolean),
  );
  return (Array.isArray(names) ? names : []).filter(name =>
    !aliases.has(normalizeProcedureName(name)),
  );
}