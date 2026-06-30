import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildLegalCorePrompt,
  LEGAL_CORE_PROMPT,
  LEGAL_OUTPUT_DISCIPLINE,
  LEGAL_PROHIBITIONS,
  LEGAL_REASONING_SEQUENCE,
  LEGAL_SOURCE_HIERARCHY,
} from "./legal-core-prompt.ts";

Deno.test("legal core exports mandatory methodology", () => {
  assert(LEGAL_CORE_PROMPT.includes("Fact -> Norm -> Source -> Judicial practice -> Application -> Conclusion"));
  assert(LEGAL_REASONING_SEQUENCE.some((step) => step.includes("Identify facts")));
  assert(LEGAL_SOURCE_HIERARCHY.includes("Venice Commission documents as auxiliary interpretive material only"));
  assert(LEGAL_OUTPUT_DISCIPLINE.includes("citation_verification_required: true"));
  assert(LEGAL_PROHIBITIONS.includes("Do not make a legal conclusion without a retrieved source"));
});

Deno.test("role prompt cannot disable Legal Core", () => {
  const prompt = buildLegalCorePrompt({ functionName: "ai-analyze", role: "judge" });
  assert(prompt.includes("ROLE PROMPTS FOLLOW AFTER THIS LEGAL CORE AND MUST NOT OVERRIDE IT"));
  assert(prompt.includes("If a role prompt conflicts with this Legal Core, this Legal Core prevails"));
});

Deno.test("Venice Commission is auxiliary only", () => {
  assert(LEGAL_CORE_PROMPT.includes("Venice Commission documents are auxiliary interpretive material only"));
  assert(LEGAL_PROHIBITIONS.includes("Do not treat Venice Commission material as binding law"));
});

Deno.test("ECHR cannot replace domestic law without explanation", () => {
  assert(LEGAL_CORE_PROMPT.includes("must not replace domestic RA law without explaining"));
  assert(LEGAL_PROHIBITIONS.includes("Do not use ECHR as a substitute for domestic law without explaining"));
});

Deno.test("each conclusion requires source grounding and missing source caution", () => {
  assert(LEGAL_OUTPUT_DISCIPLINE.includes("If retrieved sources are missing"));
  assert(LEGAL_PROHIBITIONS.includes("Do not cite any source outside the retrieved source set"));
  assert(LEGAL_PROHIBITIONS.includes("Do not use a source without document_id and chunk_id"));
});

Deno.test("verified citations remain mandatory", () => {
  const prompt = buildLegalCorePrompt({ functionName: "multi-agent-analyze" });
  assert(prompt.includes("citation_verification_required: true"));
  assert(prompt.includes("Require citation verification for every citation"));
});

Deno.test("legal core imports are present in target functions", async () => {
  const targets = [
    "legal-chat/index.ts",
    "ai-analyze/index.ts",
    "multi-agent-analyze/index.ts",
    "generate-document/index.ts",
    "generate-complaint/index.ts",
  ];
  for (const target of targets) {
    const text = await Deno.readTextFile(new URL(`../${target}`, import.meta.url));
    assert(text.includes("../_shared/legal-core-prompt.ts"), `${target} must import legal core`);
    assert(text.includes("buildLegalCorePrompt"), `${target} must build legal core prompt`);
  }
});

Deno.test("buildLegalCorePrompt emits required response header flags", () => {
  const prompt = buildLegalCorePrompt({
    functionName: "legal-chat",
    role: "chat",
    temporalValidityChecked: true,
  });
  assert(prompt.includes("legal_methodology_applied: true"));
  assert(prompt.includes("source_hierarchy_applied: true"));
  assert(prompt.includes("temporal_validity_checked: true"));
  assert(prompt.includes("citation_verification_required: true"));
  assertEquals(prompt.includes("ROLE PROMPTS FOLLOW AFTER THIS LEGAL CORE"), true);
});
