/**
 * RFC 8785 JSON Canonicalization Scheme serialization. The returned string
 * must be UTF-8 encoded before hashing or signing.
 *
 * The function accepts `unknown` so typed catalog interfaces can be passed
 * directly, but rejects every value that is not representable as strict JSON.
 */
export function canonicalizeJson(value: unknown): string {
  const assertUnicodeScalarString = (input: string, path: string): void => {
    for (let index = 0; index < input.length; index++) {
      const unit = input.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = input.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${path} contains an unpaired Unicode surrogate`);
        index++;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError(`${path} contains an unpaired Unicode surrogate`);
    }
  };
  const serialize = (input: unknown, path: string, depth: number): string => {
    if (depth > 100) throw new TypeError(`${path} exceeds the canonical JSON depth limit`);
    if (input === null) return "null";
    if (typeof input === "boolean") return JSON.stringify(input);
    if (typeof input === "string") {
      assertUnicodeScalarString(input, path);
      return JSON.stringify(input);
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new TypeError(`${path} contains a non-finite number`);
      return JSON.stringify(input);
    }
    if (Array.isArray(input)) return `[${input.map((item, index) => serialize(item, `${path}[${index}]`, depth + 1)).join(",")}]`;
    if (!input || typeof input !== "object") throw new TypeError(`${path} is not valid JSON`);
    const prototype = Object.getPrototypeOf(input) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain JSON object`);
    const object = input as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => {
        assertUnicodeScalarString(key, `${path} key`);
        return `${JSON.stringify(key)}:${serialize(object[key], `${path}.${key}`, depth + 1)}`;
      });
    return `{${entries.join(",")}}`;
  };
  return serialize(value, "$", 0);
}
