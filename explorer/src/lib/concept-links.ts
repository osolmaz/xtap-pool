/**
 * Obsidian-style inline concept links.
 *
 * Given a tweet's rendered (escaped) HTML and the concept vocabulary, links
 * the first textual mention of each concept to its /graph/<slug> page.
 * Applied after tweet text rendering, so it sees final HTML.
 *
 * Ported from local-frontier's src/lib/concept-links.ts (itself ported from
 * solmaz.io); only the vocabulary type changed to the pool API shape.
 */

export type LinkableConcept = {
  slug: string;
  name: string;
  aliases: readonly string[];
};

/** Elements whose text must never gain links (nav, code, math, existing links...). */
const SKIP_TAGS = new Set([
  "a",
  "code",
  "pre",
  "script",
  "style",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const TAG_RE = /<[^>]*>/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary pattern for an alias. Short all-caps aliases (GGUF, MoE)
 * match case-sensitively so they never hit ordinary words; everything else
 * matches case-insensitively.
 */
function aliasPattern(alias: string): RegExp {
  const caseSensitive = alias.length <= 5 && alias === alias.toUpperCase() && /[A-Z]/.test(alias);
  return new RegExp(`(?<![\\w-])${escapeRegExp(alias)}(?![\\w-])`, caseSensitive ? "" : "i");
}

type Candidate = { slug: string; patterns: RegExp[] };

type Match = { slug: string; index: number; length: number };

function buildCandidates(concepts: readonly LinkableConcept[]): Candidate[] {
  return concepts.map((concept) => ({
    slug: concept.slug,
    patterns: [...new Set([concept.name, ...concept.aliases])]
      .filter((alias) => alias.length >= 3)
      .sort((a, b) => b.length - a.length)
      .map(aliasPattern),
  }));
}

function insideInsertedAnchor(text: string, index: number): boolean {
  const open = text.lastIndexOf('<a class="concept-link"', index);
  if (open === -1) return false;
  return text.indexOf("</a>", open) > index;
}

/**
 * First usable match for one concept: patterns are longest-first, and the
 * first pattern that hits outside an already-inserted anchor wins.
 */
function firstMatchFor(
  candidate: Candidate,
  text: string,
): { index: number; length: number } | null {
  for (const pattern of candidate.patterns) {
    // scan past matches that landed inside already-inserted anchors (an
    // overlapping longer concept) so a later occurrence can still link
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    for (let match = global.exec(text); match !== null; match = global.exec(text)) {
      if (insideInsertedAnchor(text, match.index)) {
        if (global.lastIndex === match.index) global.lastIndex += 1;
        continue;
      }
      return { index: match.index, length: match[0].length };
    }
  }
  return null;
}

function betterMatch(best: Match | null, next: Match): boolean {
  if (!best) return true;
  if (next.index < best.index) return true;
  return next.index === best.index && next.length > best.length;
}

/** Earliest (then longest) pending concept match in this text node. */
function findBest(candidates: Candidate[], pending: Set<string>, text: string): Match | null {
  let best: Match | null = null;
  for (const candidate of candidates) {
    if (!pending.has(candidate.slug)) continue;
    const hit = firstMatchFor(candidate, text);
    if (!hit) continue;
    const next = { slug: candidate.slug, ...hit };
    if (betterMatch(best, next)) best = next;
  }
  return best;
}

/**
 * Repeatedly takes the earliest pending match in this text node until none
 * remain, so multiple concepts can link in one paragraph.
 */
function linkTextNode(text: string, candidates: Candidate[], pending: Set<string>): string {
  let result = text;
  for (;;) {
    const best = findBest(candidates, pending, result);
    if (!best) return result;
    pending.delete(best.slug);
    const target = result.slice(best.index, best.index + best.length);
    result =
      result.slice(0, best.index) +
      `<a class="concept-link" href="/graph/${best.slug}">${target}</a>` +
      result.slice(best.index + best.length);
  }
}

/** Pop to the matching open tag; tolerate minor imbalance. */
function popTo(stack: string[], name: string): void {
  const at = stack.lastIndexOf(name);
  if (at !== -1) stack.length = at;
}

/** Tracks the open-element stack so text inside SKIP_TAGS stays untouched. */
function updateStack(stack: string[], tag: string): void {
  const name = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1]?.toLowerCase();
  if (name === undefined) return;
  if (tag.startsWith("</")) {
    popTo(stack, name);
    return;
  }
  if (VOID_TAGS.has(name) || tag.endsWith("/>")) return;
  // Treat KaTeX containers as skip regions like <code>.
  stack.push(/class="[^"]*katex/.test(tag) ? "code" : name);
}

/** Build a linker that remembers which concepts it has already linked. */
function createConceptLinker(concepts: readonly LinkableConcept[]): (html: string) => string {
  const candidates = buildCandidates(concepts);
  const pending = new Set(candidates.map((candidate) => candidate.slug));

  return (html: string): string => {
    if (pending.size === 0 || html === "") return html;
    const stack: string[] = [];
    const processText = (text: string): string => {
      const skip = stack.some((tag) => SKIP_TAGS.has(tag));
      if (pending.size === 0 || skip || text.trim() === "") return text;
      return linkTextNode(text, candidates, pending);
    };

    let out = "";
    let last = 0;
    for (const match of html.matchAll(TAG_RE)) {
      const tag = match[0];
      out += processText(html.slice(last, match.index));
      last = match.index + tag.length;
      updateStack(stack, tag);
      out += tag;
    }
    return out + processText(html.slice(last));
  };
}

/**
 * Links the first mention of each concept in `html` to its concept page.
 * Longer aliases win when two concepts could match the same span; each
 * concept is linked at most once per document.
 */
export function linkConcepts(html: string, concepts: readonly LinkableConcept[]): string {
  return createConceptLinker(concepts)(html);
}

/**
 * Links concepts across ordered HTML fragments while treating them as one
 * document. This keeps a concept to one link across a multi-post thread.
 */
export function linkConceptsAcrossFragments(
  fragments: readonly string[],
  concepts: readonly LinkableConcept[],
): string[] {
  const link = createConceptLinker(concepts);
  return fragments.map((fragment) => link(fragment));
}
