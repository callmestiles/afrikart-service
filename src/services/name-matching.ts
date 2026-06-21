// Name matching strategy for account verification
// Problem: banks return names in inconsistent formats
// e.g. "ADA LOVELACE", "Ada Lovelace", "Ada A. Lovelace", "LOVELACE ADA"
// A strict equality check would block legitimate payouts
// A completely loose check defeats the purpose of verification
//
// Strategy: normalize both names, then check if all tokens in the
// expected name appear in the verified name
// This handles: case differences, middle names, extra spaces
// It does NOT handle: completely different names, transposed names

export interface NameMatchResult {
  matched: boolean;
  confidence: "exact" | "normalized" | "partial" | "none";
  expectedName: string;
  verifiedName: string;
  detail: string;
}

export function matchAccountName(
  expectedName: string,
  verifiedName: string,
): NameMatchResult {
  const base = { expectedName, verifiedName };

  // Exact match first — fast path
  if (expectedName === verifiedName) {
    return {
      ...base,
      matched: true,
      confidence: "exact",
      detail: "Names match exactly",
    };
  }

  const normalizedExpected = normalize(expectedName);
  const normalizedVerified = normalize(verifiedName);

  // Normalized match — handles case and spacing differences
  if (normalizedExpected === normalizedVerified) {
    return {
      ...base,
      matched: true,
      confidence: "normalized",
      detail: "Names match after normalization",
    };
  }

  // Token match — handles middle names and word order differences
  // All tokens in expected must appear in verified
  const expectedTokens = normalizedExpected.split(" ").filter(Boolean);
  const verifiedTokens = normalizedVerified.split(" ").filter(Boolean);

  const allExpectedTokensPresent = expectedTokens.every((token) =>
    verifiedTokens.includes(token),
  );

  if (allExpectedTokensPresent) {
    return {
      ...base,
      matched: true,
      confidence: "partial",
      detail: `Names match partially — all expected tokens found in verified name`,
    };
  }

  // No match
  return {
    ...base,
    matched: false,
    confidence: "none",
    detail: `Name mismatch — expected "${expectedName}" but verified name is "${verifiedName}"`,
  };
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[-]/g, " ") // replace hyphens with space first
    .replace(/[^a-z\s]/g, "") // then remove remaining punctuation
    .replace(/\s+/g, " "); // collapse multiple spaces
}
