/** Parse bounded JSON without silently accepting duplicate object keys. */
export function strictJson(text: string, maxLength: number): unknown {
  if (typeof text !== 'string' || text.length > maxLength) throw new Error('Invalid JSON size.');
  const value: unknown = JSON.parse(text);
  let cursor = 0;
  const whitespace = () => { while (/\s/u.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '\\') cursor++;
      else if (char === '"') break;
    }
    return JSON.parse(text.slice(start, cursor)) as string;
  };
  const visit = (depth: number): void => {
    if (depth > 24) throw new Error('JSON is too deeply nested.');
    whitespace();
    if (text[cursor] === '{') {
      cursor++; whitespace();
      const keys = new Set<string>();
      while (text[cursor] !== '}') {
        const key = string();
        if (keys.has(key)) throw new Error('Duplicate JSON property.');
        keys.add(key); whitespace(); cursor++; visit(depth + 1); whitespace();
        if (text[cursor] !== ',') break;
        cursor++; whitespace();
      }
      cursor++;
    } else if (text[cursor] === '[') {
      cursor++; whitespace();
      while (text[cursor] !== ']') {
        visit(depth + 1); whitespace();
        if (text[cursor] !== ',') break;
        cursor++; whitespace();
      }
      cursor++;
    } else if (text[cursor] === '"') string();
    else while (cursor < text.length && !/[\s,}\]]/u.test(text[cursor]!)) cursor++;
  };
  visit(0);
  return value;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

export function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function boundedString(value: unknown, max: number, nonempty = true): value is string {
  return typeof value === 'string' && value.length <= max && (!nonempty || value.trim().length > 0);
}
