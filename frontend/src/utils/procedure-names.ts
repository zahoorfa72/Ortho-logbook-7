const normalizeProcedureName = (value: string) =>
  String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

const ignoredAcronymWords = new Set(["and", "of", "for", "with", "the", "to", "in", "on"]);

function explicitProcedureAcronym(fullName: string): string {
  // Parentheses are an explicit alias declaration. Support punctuation such as
  // D.C.P. and trailing side/approach notes such as "(DCP) - Left".
  const matches = Array.from(String(fullName || "").matchAll(/\(([A-Za-z][A-Za-z0-9.-]{1,12})\)/g));
  const candidate = matches.find(match => /^[A-Za-z0-9.-]{2,12}$/.test(String(match[1] || "")));
  return candidate ? normalizeProcedureName(candidate[1]) : "";
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