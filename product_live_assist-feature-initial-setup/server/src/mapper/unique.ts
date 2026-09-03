/**
 * Run-unique values, so a journey that CREATES something can be replayed.
 *
 * The problem this solves is structural, not product-specific. A creation
 * journey records the value it typed — "TESTBANK01" — and its proof is usually
 * that value appearing somewhere. Replay it and one of two things happens:
 *
 *   · the record from the first run is still there, so the proof text is
 *     ALREADY on screen and the differential gate correctly refuses it; or
 *   · the product rejects the duplicate outright.
 *
 * `resetState()` cannot help — it clears cookies and local storage, never the
 * server's data. So verification replays into a world its own exploration
 * polluted. We hit this on all three real products tried: Dolibarr
 * ("TESTBANK01" already on screen), OrangeHRM ("Employee Id already exists"),
 * and it is a strong candidate for HubSpot's creation failures too.
 *
 * The fix is to make the value a TEMPLATE. A journey stores `Acme {{unique}}`
 * and every execution expands it to something fresh, so each replay creates a
 * genuinely new record whose proof was genuinely absent beforehand. The stored
 * journey stays stable while its effect is new each time.
 *
 * Deliberately not a timestamp: those are long, get reformatted by date fields,
 * and two runs in the same second collide. A short alphanumeric tag is safe in
 * names, emails, codes and references across every product we have tried.
 */

export const UNIQUE_TOKEN = "{{unique}}";

/** Short, lowercase-safe, no ambiguous characters — it gets typed into forms. */
export function newRunTag(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no i/l/o/0/1
  let out = "";
  for (let i = 0; i < 5; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export function hasUnique(s: string | undefined): boolean {
  return !!s && s.includes(UNIQUE_TOKEN);
}

/** `Acme {{unique}}` → `Acme k7q2m` */
export function expand(s: string | undefined, tag: string): string {
  if (!s) return s ?? "";
  return s.split(UNIQUE_TOKEN).join(tag);
}

/**
 * `Acme k7q2m` → `Acme {{unique}}`
 *
 * Needed when a proof is chosen from OBSERVED page text: what we saw contains
 * the expanded value, but what we store must contain the token, or the stored
 * proof pins the journey to the one record the exploration happened to make.
 */
export function collapse(s: string | undefined, tag: string): string {
  if (!s || !tag) return s ?? "";
  return s.split(tag).join(UNIQUE_TOKEN);
}

/** Expand every templated value in a program for one execution. */
export function expandProgram<T extends { value?: string; name?: string; url?: string }>(steps: T[], tag: string): T[] {
  return steps.map((s) => ({
    ...s,
    // Only `value` is templated. Names and URLs address existing UI, and
    // substituting into them would break the selector rather than freshen data.
    ...(s.value !== undefined ? { value: expand(s.value, tag) } : {}),
  }));
}
