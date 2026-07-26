import { describe, expect, it } from "vitest";

import type { LinkableConcept } from "../src/lib/concept-links.js";
import { linkConcepts, linkConceptsAcrossFragments } from "../src/lib/concept-links.js";

const FEM: LinkableConcept = {
  slug: "finite-element-method",
  name: "Finite element method",
  aliases: ["FEM", "finite elements"],
};
const DUAL: LinkableConcept = {
  slug: "dual-space",
  name: "Dual space",
  aliases: ["dual spaces"],
};

describe("linkConcepts", () => {
  it("links the first mention only", () => {
    const html = "<p>The finite element method rules. I love the finite element method.</p>";
    const out = linkConcepts(html, [FEM]);
    expect(out).toBe(
      '<p>The <a class="concept-link" href="/graph/finite-element-method">finite element method</a> rules. ' +
        "I love the finite element method.</p>",
    );
  });

  it("matches aliases case-insensitively but acronyms case-sensitively", () => {
    expect(linkConcepts("<p>Using Finite Elements here.</p>", [FEM])).toContain("concept-link");
    expect(linkConcepts("<p>a femur bone</p>", [FEM])).not.toContain("concept-link");
    expect(linkConcepts("<p>Classic FEM solver.</p>", [FEM])).toContain(">FEM</a>");
  });

  it("never links inside anchors, code, headings, or KaTeX output", () => {
    const html =
      "<h2>Finite element method</h2>" +
      '<p><a href="/x/">finite elements</a> and <code>FEM</code></p>' +
      '<span class="katex"><span>FEM</span></span>';
    expect(linkConcepts(html, [FEM])).toBe(html);
  });

  it("links multiple concepts in one text node", () => {
    const out = linkConcepts("<p>Dual spaces meet the finite element method.</p>", [FEM, DUAL]);
    expect(out).toContain('href="/graph/dual-space">Dual spaces</a>');
    expect(out).toContain('href="/graph/finite-element-method">finite element method</a>');
  });

  it("requires word boundaries", () => {
    expect(linkConcepts("<p>nonfinite elements</p>", [FEM])).not.toContain("concept-link");
  });

  it("links each concept once across ordered thread fragments", () => {
    const out = linkConceptsAcrossFragments(
      ["<p>FEM starts the thread.</p>", "<p>FEM meets dual spaces later.</p>"],
      [FEM, DUAL],
    );

    expect(out[0]).toContain('href="/graph/finite-element-method">FEM</a>');
    expect(out[1]).not.toContain('href="/graph/finite-element-method"');
    expect(out[1]).toContain('href="/graph/dual-space">dual spaces</a>');
  });

  it("leaves implicit concepts unlinked when no name or alias appears", () => {
    const html = "<p>The solver gets a useful answer without naming the underlying method.</p>";
    expect(linkConcepts(html, [FEM])).toBe(html);
  });
});

it("links a later occurrence when the first is inside an overlapping longer link", () => {
  const [html] = linkConceptsAcrossFragments(
    ["Inference Performance matters and inference is hard"],
    [
      { slug: "inference-performance", name: "Inference Performance", aliases: [] },
      { slug: "inference", name: "inference", aliases: [] },
    ],
  );
  expect(html).toContain('href="/graph/inference-performance"');
  expect(html).toMatch(/and <a class="concept-link" href="\/graph\/inference">inference<\/a>/);
});
