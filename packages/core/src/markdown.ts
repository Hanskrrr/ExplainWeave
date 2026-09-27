import { CoreError } from "./types";

interface Line { start: number; end: number; text: string }
interface Fence { character: string; length: number }
interface ProtectedBlock { fence?: Fence; math?: boolean; htmlEnd?: RegExp; htmlTag?: string; htmlDepth?: number }
export interface ParsedMarkdown {
  prefix: string;
  chunks: { id?: string; markdown: string }[];
  markerCount: number;
  readOnlyReason?: string;
}

function getLines(text: string): Line[] {
  const lines: Line[] = [];
  const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) continue;
    lines.push({ start: match.index, end: match.index + match[0].length, text: match[0].replace(/(?:\r\n|\n|\r)$/, "") });
  }
  return lines;
}

function nextFence(line: string, fence?: Fence): Fence | undefined {
  if (fence) {
    const closer = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
    if (closer && closer[1]![0] === fence.character && closer[1]!.length >= fence.length) return undefined;
    return fence;
  }
  const opener = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!opener || (opener[1]![0] === "`" && opener[2]!.includes("`"))) return undefined;
  return { character: opener[1]![0]!, length: opener[1]!.length };
}

const markerPattern = /^<!-- explainweave:node ([A-Za-z0-9_-]{1,128}) -->[ \t]*$/;

function inProtectedBlock(block: ProtectedBlock): boolean {
  return Boolean(block.fence || block.math || block.htmlEnd || block.htmlTag);
}

function htmlDepthDelta(line: string, tag: string): number {
  let depth = 0;
  for (const match of line.matchAll(new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi"))) {
    if (match[1]) depth--;
    else if (!/\/\s*>$/.test(match[0])) depth++;
  }
  return depth;
}

function advanceBlock(line: string, block: ProtectedBlock): ProtectedBlock {
  if (block.fence) return { fence: nextFence(line, block.fence) };
  if (block.htmlEnd) return block.htmlEnd.test(line) ? {} : block;
  if (block.htmlTag) {
    const depth = (block.htmlDepth ?? 1) + htmlDepthDelta(line, block.htmlTag);
    return depth > 0 ? { htmlTag: block.htmlTag, htmlDepth: depth } : {};
  }
  const fence = nextFence(line);
  if (fence && !block.math) return { fence };
  const mathDelimiters = line.match(/(?<!\\)\$\$/g)?.length ?? 0;
  if (block.math) return mathDelimiters % 2 === 1 ? {} : block;
  if (/^ {0,3}\$\$/.test(line) && mathDelimiters % 2 === 1) return { math: true };
  if (/^ {0,3}<!--/.test(line) && !line.includes("-->")) return { htmlEnd: /-->/ };
  if (/^ {0,3}<!\[CDATA\[/.test(line) && !line.includes("]]>")) return { htmlEnd: /\]\]>/ };
  const html = line.match(/^ {0,3}<([A-Za-z][A-Za-z0-9-]*)(?:\s|>|\/)/);
  if (html && !/\/\s*>\s*$/.test(line) && !/^(?:br|hr|img|input|meta|link|source|area|base|embed|param|track|wbr)$/i.test(html[1]!)) {
    const depth = htmlDepthDelta(line, html[1]!);
    if (depth > 0) return { htmlTag: html[1]!, htmlDepth: depth };
  }
  return {};
}

export function parseMarkdown(source: string): ParsedMarkdown {
  const lines = getLines(source);
  let prefixEnd = 0;
  if (lines[0] && /^\uFEFF?---[ \t]*$/.test(lines[0].text)) {
    const closing = lines.slice(1).find(line => /^(?:---|\.\.\.)[ \t]*$/.test(line.text));
    if (!closing) {
      return { prefix: "", chunks: [{ markdown: source }], markerCount: 0,
        readOnlyReason: "Frontmatter starts with --- but has no closing delimiter; preserve the source and repair its boundary before editing nodes." };
    }
    prefixEnd = closing.end;
  }
  const chunks: ParsedMarkdown["chunks"] = [];
  const seen = new Set<string>();
  let block: ProtectedBlock = {};
  let segmentStart = prefixEnd;
  let segmentId: string | undefined;
  let markerCount = 0;
  for (const line of lines) {
    if (line.start < prefixEnd) continue;
    if (!inProtectedBlock(block)) {
      const marker = line.text.match(markerPattern);
      if (marker) {
        const id = marker[1]!;
        if (seen.has(id)) throw new CoreError("DUPLICATE_MARKER", `Node marker ${id} occurs more than once; no automatic rewrite is safe.`);
        seen.add(id);
        if (segmentId !== undefined || line.start > segmentStart) {
          chunks.push({ ...(segmentId ? { id: segmentId } : {}), markdown: source.slice(segmentStart, line.start) });
        }
        segmentId = id;
        segmentStart = line.end;
        markerCount++;
        continue;
      }
      if (/^<!--\s*explainweave:/.test(line.text)) {
        throw new CoreError("INVALID_MARKER", "An ExplainWeave marker is malformed; preserve the file and repair the marker before writing.");
      }
    }
    block = advanceBlock(line.text, block);
  }
  if (segmentId !== undefined || segmentStart < source.length) {
    chunks.push({ ...(segmentId ? { id: segmentId } : {}), markdown: source.slice(segmentStart) });
  }
  return { prefix: source.slice(0, prefixEnd), chunks, markerCount };
}

/** Reserved markers inside fenced code are literal examples, never node boundaries. */
export function assertNoMarkers(markdown: string): void {
  let block: ProtectedBlock = {};
  for (const line of getLines(markdown)) {
    if (!inProtectedBlock(block) && /^<!--\s*explainweave:/.test(line.text)) {
      throw new CoreError("RESERVED_MARKER", "Node text cannot insert hidden ExplainWeave markers; use a fenced code block for literal examples.");
    }
    block = advanceBlock(line.text, block);
  }
}

/** Conservative split: explicit blank-line boundary outside fenced code. */
export function isSafeSplit(markdown: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset <= 0 || offset >= markdown.length) return false;
  if (!hasBlankLineEnd(markdown.slice(0, offset))) return false;
  let block: ProtectedBlock = {};
  for (const line of getLines(markdown)) {
    if (line.start >= offset) break;
    if (line.end > offset) return false;
    block = advanceBlock(line.text, block);
  }
  if (inProtectedBlock(block)) return false;
  const nextLine = getLines(markdown.slice(offset)).find(line => line.text.trim().length > 0)?.text ?? "";
  // Indented continuations, block quotes and lists can remain one Markdown block
  // across a blank line. Refuse these ambiguous boundaries in the first version.
  if (/^(?:\s+|>|(?:[-+*]|\d+[.)])[ \t])/.test(nextLine)) return false;
  return true;
}

export function hasBlankLineEnd(text: string): boolean {
  return /(?:\r\n|\n|\r(?!\n))[ \t]*(?:\r\n|\n|\r(?!\n))$/.test(text);
}

export function lineEnding(text: string): string {
  return text.match(/\r\n|\n|\r/)?.[0] ?? "\n";
}
