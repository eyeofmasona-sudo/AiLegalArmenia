import type { LegalReasoningOutput } from "./legal-reasoning-engine.ts";
import type { SourceHierarchyContext } from "./source-hierarchy-engine.ts";
import type { CourtPracticeContext } from "./court-practice-engine.ts";

const MAX_BRIEF_LENGTH = 4500;

export function serializeLegalReasoningBrief(engine: LegalReasoningOutput): string {
  const parts: string[] = [];

  parts.push("1. CASE CONTEXT");
  parts.push(`- Case Type: ${engine.normalized_input.case_type || "N/A"}`);
  parts.push(`- Legal Domain: ${engine.domains.join(", ") || "N/A"}`);
  parts.push(`- Procedural Stage: ${engine.procedural_stage || "unknown"}`);
  parts.push(`- Language: ${engine.normalized_input.language || "auto"}`);
  parts.push(`- Effective Date: ${engine.normalized_input.effective_at || "Reference date missing; apply temporal caution"}`);
  
  if (engine.facts.missing_facts.length > 0) {
    parts.push(`- Missing Facts: ${engine.facts.missing_facts.join("; ")}`);
  }

  parts.push("");
  parts.push("2. LEGAL ISSUES");
  parts.push(`- Primary Issues: ${engine.issues.legal_issues.join("; ") || "None identified"}`);
  if (engine.issues.procedural_issues.length > 0) {
    parts.push(`- Procedural Issues: ${engine.issues.procedural_issues.join("; ")}`);
  }
  if (engine.issues.evidentiary_issues.length > 0) {
    parts.push(`- Evidentiary Issues: ${engine.issues.evidentiary_issues.join("; ")}`);
  }
  if (engine.issues.human_rights_issues.length > 0) {
    parts.push(`- Human Rights Issues: ${engine.issues.human_rights_issues.join("; ")}`);
  }
  if (engine.issues.municipal_or_administrative_issues.length > 0) {
    parts.push(`- Municipal/Admin Issues: ${engine.issues.municipal_or_administrative_issues.join("; ")}`);
  }

  return parts.join("\n");
}

export function serializeSourceHierarchyBrief(hierarchy: SourceHierarchyContext | undefined): string {
  if (!hierarchy) return "3. CONTROLLING SOURCES\n- No sources ranked.";
  
  const parts: string[] = [];
  parts.push("3. CONTROLLING SOURCES");
  
  const b = hierarchy.binding_sources || [];
  const p = hierarchy.persuasive_sources || [];
  const a = hierarchy.auxiliary_sources || [];

  if (b.length > 0) {
    parts.push("- Binding Sources: " + b.map(s => String(s.source_level || s.source_name || s.id)).join(", "));
  } else {
    parts.push("- Binding Sources: None retrieved");
  }
  
  if (p.length > 0) {
    parts.push("- Persuasive Sources: " + p.map(s => String(s.source_level || s.source_name || s.id)).join(", "));
  }
  if (a.length > 0) {
    // Requirement: Venice Commission always auxiliary
    const venice = a.some(s => String(s.source_level || s.source_name || s.id).toLowerCase().includes("venice")) ? " (includes Venice Commission - auxiliary only)" : "";
    parts.push("- Auxiliary Sources: " + a.map(s => String(s.source_level || s.source_name || s.id)).join(", ") + venice);
  }
  
  if (hierarchy.conflicts && hierarchy.conflicts.length > 0) {
    parts.push("- Source Conflicts: " + hierarchy.conflicts.map(c => c.warning || c.type).join("; "));
  }
  
  return parts.join("\n");
}

export function serializeTemporalBrief(temporalContext: any): string {
  if (!temporalContext) return "4. TEMPORAL VALIDITY\n- No temporal data.";
  
  const parts: string[] = [];
  parts.push("4. TEMPORAL VALIDITY");
  
  const effAt = typeof temporalContext === "string" ? temporalContext : (temporalContext.effective_at || "Reference date missing; apply temporal caution");
  const warnings = typeof temporalContext === "string" ? [] : (temporalContext.temporal_warnings || []);
  const caution = typeof temporalContext === "string" ? false : temporalContext.cautious_output_required;
  
  parts.push(`- Reference Date: ${effAt}`);
  
  if (warnings.length > 0) {
    parts.push(`- Temporal Warnings: ${warnings.join("; ")}`);
  }
  
  if (caution) {
    parts.push("- Expired/Repealed Source Warning: Sources may be invalid for the reference date.");
  }
  
  return parts.join("\n");
}

export function serializeCourtPracticeBrief(courtPractice: CourtPracticeContext | undefined): string {
  if (!courtPractice || 
      ((courtPractice.ranked_practice?.length || 0) === 0 && 
       (courtPractice.binding_practice?.length || 0) === 0 && 
       (courtPractice.persuasive_practice?.length || 0) === 0 && 
       (courtPractice.weak_practice?.length || 0) === 0 && 
       (courtPractice.echr_practice?.length || 0) === 0)) {
    return "5. COURT PRACTICE\n- No controlling court practice retrieved.";
  }

  const parts: string[] = [];
  parts.push("5. COURT PRACTICE");
  
  if (courtPractice.binding_practice?.some(p => p.court_level === "constitutional_court")) {
    parts.push("- Constitutional Court: Controlling positions retrieved.");
  }
  if (courtPractice.binding_practice?.some(p => p.court_level === "cassation_court" || p.weight_class === "binding")) {
    parts.push("- Cassation Court: Controlling positions retrieved.");
  }
  if ((courtPractice.echr_practice?.length || 0) > 0) {
    parts.push("- ECHR Practice: Interpretive guidance only, cannot replace domestic law without explanation.");
  }
  if ((courtPractice.weak_practice?.length || 0) > 0 || courtPractice.persuasive_practice?.some(p => p.court_level === "appellate_court" || p.court_level === "first_instance_court")) {
    parts.push("- Appellate/First Instance: Weak/persuasive value only.");
  }
  
  if (courtPractice.warnings?.length > 0) {
    parts.push(`- Practice Warnings: ${courtPractice.warnings.join("; ")}`);
  }
  
  return parts.join("\n");
}

export function serializeCitationDisciplineBrief(options?: any): string {
  return `6. CITATION DISCIPLINE
- Only use retrieved sources provided in the context.
- Cite document_id/chunk_id where possible.
- No invented cases, articles, or facts.
- No unsupported certainty.`;
}

export function buildCuratedLegalPromptContext(engine: LegalReasoningOutput): string {
  const parts: string[] = [];
  
  parts.push("=== CURATED LEGAL BRIEF ===");
  parts.push(serializeLegalReasoningBrief(engine));
  parts.push("");
  parts.push(serializeSourceHierarchyBrief(engine.source_hierarchy));
  parts.push("");
  parts.push(serializeTemporalBrief(engine.temporal_validation));
  parts.push("");
  parts.push(serializeCourtPracticeBrief(engine.court_practice));
  parts.push("");
  parts.push(serializeCitationDisciplineBrief());
  parts.push("");
  
  const cautions: string[] = [];
  if (engine.facts.missing_facts.length > 0) cautions.push("missing facts");
  if (engine.reasoning_checklist.cautious_output_required) cautions.push("weak grounding");
  if (!engine.normalized_input.effective_at) cautions.push("temporal uncertainty");
  if (engine.source_hierarchy?.conflicts?.length > 0) cautions.push("conflicting sources");
  if (!engine.court_practice || 
      ((engine.court_practice.ranked_practice?.length || 0) === 0 && 
       (engine.court_practice.binding_practice?.length || 0) === 0 && 
       (engine.court_practice.persuasive_practice?.length || 0) === 0 && 
       (engine.court_practice.weak_practice?.length || 0) === 0 && 
       (engine.court_practice.echr_practice?.length || 0) === 0)) cautions.push("no controlling practice");
  
  parts.push("7. OUTPUT CAUTION");
  if (cautions.length > 0) {
    parts.push(`- CAUTION REQUIRED DUE TO: ${cautions.join(", ")}`);
  } else {
    parts.push("- All required context is present.");
  }
  parts.push("===========================");
  
  const fullBrief = parts.join("\n");
  
  if (fullBrief.length > MAX_BRIEF_LENGTH) {
    // We shouldn't drop critical warnings.
    // The structure ensures sections 6 and 7 are at the end, so truncating the middle is safer.
    // However, a simple substring for now is acceptable, as long as we append cautions.
    const cutoff = MAX_BRIEF_LENGTH - 500;
    return fullBrief.substring(0, cutoff) + "\n...[TRUNCATED]...\n" + serializeCitationDisciplineBrief() + "\n\n7. OUTPUT CAUTION\n- CAUTION REQUIRED DUE TO: " + cautions.join(", ");
  }
  
  return fullBrief;
}
