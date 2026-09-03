import { createHash } from "node:crypto";
import type { DocChunk } from "./store.js";

export interface DocumentCitation {
  source: string;
  title: string;
  section: string;
  paragraphStart: number;
  paragraphEnd: number;
  excerpt: string;
}

export interface DocumentList {
  ordered: boolean;
  items: string[];
  paragraphStart: number;
  paragraphEnd: number;
}

/** A source section is retained separately from retrieval chunks. */
export interface DocumentSection {
  id: string;
  source: string;
  title: string;
  heading: string;
  level: number;
  ordinal: number;
  text: string;
  paragraphs: string[];
  lists: DocumentList[];
  trust: DocChunk["trust"];
  freshness: string;
}

export interface StructuredChunk extends Omit<DocChunk, "id" | "embedding"> {
  structure: {
    sectionId: string;
    paragraphStart: number;
    paragraphEnd: number;
    containsOrderedProcedure: boolean;
  };
}

export function documentJourneyPlanningEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.DOCUMENT_JOURNEY_PLANNING ?? "false");
}

function idFor(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function normaliseLines(raw: string): string[] {
  return raw.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
}

function paragraphsOf(lines: string[]): string[] {
  const paragraphs: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    const text = prose.join(" ").replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(text);
    prose = [];
  };
  for (const line of lines) {
    const clean = line.trim();
    if (!clean) { flush(); continue; }
    if (/^(?:\d+[.)]|[-*+])\s+/.test(clean)) {
      flush();
      paragraphs.push(clean);
    } else prose.push(clean);
  }
  flush();
  return paragraphs;
}

function listsOf(paragraphs: string[]): DocumentList[] {
  const lists: DocumentList[] = [];
  for (let i = 0; i < paragraphs.length;) {
    const first = paragraphs[i].match(/^(\d+)[.)]\s+(.+)$/) ?? paragraphs[i].match(/^([-*+])\s+(.+)$/);
    if (!first) { i++; continue; }
    const ordered = /^\d+$/.test(first[1]);
    const items: string[] = [];
    const start = i + 1;
    while (i < paragraphs.length) {
      const match = ordered
        ? paragraphs[i].match(/^\d+[.)]\s+(.+)$/)
        : paragraphs[i].match(/^[-*+]\s+(.+)$/);
      if (!match) break;
      items.push(match[1].trim());
      i++;
    }
    lists.push({ ordered, items, paragraphStart: start, paragraphEnd: i });
  }
  return lists;
}

/** Parse markdown/plain text while retaining heading and ordered-list boundaries. */
export function parseDocumentSections(
  raw: string,
  meta: { source: string; title: string; trust: DocChunk["trust"]; freshness?: string },
): DocumentSection[] {
  const freshness = meta.freshness ?? new Date().toISOString();
  const lines = normaliseLines(raw);
  const sections: { heading: string; level: number; lines: string[] }[] = [];
  let current = { heading: meta.title, level: 1, lines: [] as string[] };
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!heading) { current.lines.push(line); continue; }
    if (current.lines.some((item) => item.trim())) sections.push(current);
    current = { heading: heading[2].trim(), level: heading[1].length, lines: [] };
  }
  if (current.lines.some((item) => item.trim()) || !sections.length) sections.push(current);

  return sections.map((section, ordinal) => {
    const paragraphs = paragraphsOf(section.lines);
    const text = paragraphs.join("\n\n");
    return {
      id: `section-${idFor(`${meta.source}:${ordinal}:${section.heading}`)}`,
      source: meta.source,
      title: meta.title,
      heading: section.heading,
      level: section.level,
      ordinal,
      text,
      paragraphs,
      lists: listsOf(paragraphs),
      trust: meta.trust,
      freshness,
    };
  }).filter((section) => section.text.trim());
}

/**
 * Chunk for live retrieval without splitting numbered procedures. A list is an
 * atomic unit: a long procedure may exceed the target, but never loses steps.
 */
export function chunkStructuredSections(sections: DocumentSection[], target = 900): StructuredChunk[] {
  const out: StructuredChunk[] = [];
  for (const section of sections) {
    const listAt = new Map(section.lists.map((list) => [list.paragraphStart, list]));
    const units: { start: number; end: number; text: string; procedure: boolean }[] = [];
    for (let i = 1; i <= section.paragraphs.length;) {
      const list = listAt.get(i);
      if (list) {
        units.push({
          start: list.paragraphStart,
          end: list.paragraphEnd,
          text: list.items.map((item, n) => `${n + 1}. ${item}`).join("\n"),
          procedure: list.ordered,
        });
        i = list.paragraphEnd + 1;
      } else {
        units.push({ start: i, end: i, text: section.paragraphs[i - 1], procedure: false });
        i++;
      }
    }

    let group: typeof units = [];
    const flush = () => {
      if (!group.length) return;
      const body = group.map((unit) => unit.text).join("\n\n");
      out.push({
        text: `# ${section.heading}\n\n${body}`,
        source: section.source,
        title: section.title,
        section: section.heading,
        trust: section.trust,
        freshness: section.freshness,
        structure: {
          sectionId: section.id,
          paragraphStart: group[0].start,
          paragraphEnd: group[group.length - 1].end,
          containsOrderedProcedure: group.some((unit) => unit.procedure),
        },
      });
      group = [];
    };
    for (const unit of units) {
      const nextLength = group.reduce((sum, item) => sum + item.text.length + 2, 0) + unit.text.length;
      if (group.length && nextLength > target) flush();
      group.push(unit);
      if (unit.procedure || unit.text.length >= target) flush();
    }
    flush();
  }
  return out;
}

export function citationFor(section: DocumentSection, start = 1, end = section.paragraphs.length): DocumentCitation {
  const paragraphStart = Math.max(1, start);
  const paragraphEnd = Math.min(section.paragraphs.length, Math.max(paragraphStart, end));
  return {
    source: section.source,
    title: section.title,
    section: section.heading,
    paragraphStart,
    paragraphEnd,
    excerpt: section.paragraphs.slice(paragraphStart - 1, paragraphEnd).join("\n"),
  };
}
