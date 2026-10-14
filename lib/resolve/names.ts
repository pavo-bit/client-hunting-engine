// Name normalization for candidate generation ONLY (T-004).
// Names are supporting evidence, never proof: exact normalized-name matches
// enter the human-review queue; they NEVER trigger automatic merges.
// Suffix stripping is a documented heuristic, not a legal determination.

const LEGAL_SUFFIXES = [
  "private limited",
  "pvt ltd",
  "limited",
  "incorporated",
  "corporation",
  "ltd",
  "llc",
  "inc",
  "corp",
  "gmbh",
  "ug",
  "sarl",
  "sas",
  "bv",
  "pty",
  "plc",
  "co",
];

export function normalizeName(input: string): string {
  let s = input.toLowerCase().trim();
  s = s.replace(/[.,&'"’`\-_/()]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  for (const suffix of LEGAL_SUFFIXES) {
    if (s.endsWith(" " + suffix)) {
      s = s.slice(0, -(suffix.length + 1)).trim();
      break;
    }
  }
  return s;
}
