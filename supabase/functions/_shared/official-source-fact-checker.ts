export const OFFICIAL_SOURCE_ALLOWLIST = [
  "arlis.am",
  "court.am",
  "concourt.am",
  "datalex.am",
  "gov.am",
  "e-gov.am",
  "yerevan.am",
  "echr.coe.int",
  "hudoc.echr.coe.int",
  "venice.coe.int"
] as const;

export type OfficialSourceAllowlistType = typeof OFFICIAL_SOURCE_ALLOWLIST[number];

export type OfficialSourceFactCheckStatus = 
  | "PASS" 
  | "WARNING" 
  | "FAIL" 
  | "UNVERIFIED_OFFICIAL_SOURCE" 
  | "NOT_RUN";

export interface OfficialSourceTarget {
  id: string; // unique internal identifier or citation marker
  type: "act" | "article" | "case_number" | "url" | "unknown";
  raw_text: string;
  expected_domain?: OfficialSourceAllowlistType | string;
}

export interface OfficialSourceFactCheckInput {
  analysisText: string;
  citations: string[]; // markers extracted from text
  metadata?: Record<string, unknown>; // previously verified local metadata
}

export interface OfficialSourceChecked {
  source_name: string;
  url?: string;
  status: "verified" | "unverified";
}

export interface OfficialSourceFailed {
  citation: string;
  reason: string;
}

export interface OfficialSourceFactCheckResult {
  official_fact_check_status: OfficialSourceFactCheckStatus;
  checked_sources: OfficialSourceChecked[];
  failed_sources: OfficialSourceFailed[];
  warnings: string[];
  must_not_use: string[];
  requires_human_review: boolean;
  mode: "stub" | "active";
  targets: OfficialSourceTarget[];
}

/**
 * Extracts potential targets for official source verification from generated text and internal metadata.
 */
export function extractOfficialCheckTargets(
  text: string, 
  citations: string[], 
  metadata?: Record<string, unknown>
): OfficialSourceTarget[] {
  const targets: OfficialSourceTarget[] = [];
  let targetIdCounter = 1;

  // Extremely basic regex patterns for stubbing purposes
  const urlPattern = /https?:\/\/(?:www\.)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:\/[^\s)]*)?/g;
  const caseNumberPattern = /([A-ZԱ-Ֆ]{1,4}\d?\/[0-9]{4}\/[0-9]{2})/g; // E.g., ԵԴ/1234/02
  const actPattern = /(?:ՀՕ-\d+|N \d+-Ն|N \d+-Ա)/g; // E.g., ՀՕ-123, N 12-Ն
  
  // 1. Extract URLs
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    const fullUrl = match[0];
    const domain = match[1].toLowerCase();
    targets.push({
      id: `target_url_${targetIdCounter++}`,
      type: "url",
      raw_text: fullUrl,
      expected_domain: domain,
    });
  }

  // 2. Extract Case Numbers
  while ((match = caseNumberPattern.exec(text)) !== null) {
    targets.push({
      id: `target_case_${targetIdCounter++}`,
      type: "case_number",
      raw_text: match[1],
      expected_domain: "datalex.am" // Default for RA court cases
    });
  }

  // 3. Extract Acts
  while ((match = actPattern.exec(text)) !== null) {
    targets.push({
      id: `target_act_${targetIdCounter++}`,
      type: "act",
      raw_text: match[0],
      expected_domain: "arlis.am"
    });
  }

  // 4. ECHR/Venice specific keywords
  if (text.includes("ՄԻԵԴ") || text.includes("ECHR")) {
    targets.push({
      id: `target_echr_${targetIdCounter++}`,
      type: "case_number", // generalized
      raw_text: "ECHR reference",
      expected_domain: "hudoc.echr.coe.int"
    });
  }
  
  if (text.includes("Վենետիկի հանձնաժողով") || text.includes("Venice Commission")) {
    targets.push({
      id: `target_venice_${targetIdCounter++}`,
      type: "act",
      raw_text: "Venice Commission Document",
      expected_domain: "venice.coe.int"
    });
  }

  // Include citations from the verifier array just to have them tracked
  citations.forEach(cit => {
    targets.push({
      id: `target_cit_${targetIdCounter++}`,
      type: "unknown",
      raw_text: cit
    });
  });

  return targets;
}

/**
 * Stub implementation of the Official Source Fact Checker.
 * Classifies targets but does NOT perform any network operations.
 */
export function runOfficialSourceFactCheckStub(input: OfficialSourceFactCheckInput): OfficialSourceFactCheckResult {
  const result: OfficialSourceFactCheckResult = {
    official_fact_check_status: "NOT_RUN",
    checked_sources: [],
    failed_sources: [],
    warnings: [],
    must_not_use: [],
    requires_human_review: false,
    mode: "stub",
    targets: []
  };

  const targets = extractOfficialCheckTargets(input.analysisText, input.citations, input.metadata);
  result.targets = targets;

  if (targets.length === 0) {
    return result;
  }

  result.official_fact_check_status = "UNVERIFIED_OFFICIAL_SOURCE";

  for (const target of targets) {
    if (target.expected_domain) {
      if (!OFFICIAL_SOURCE_ALLOWLIST.includes(target.expected_domain as OfficialSourceAllowlistType)) {
        result.warnings.push(`Domain '${target.expected_domain}' for target '${target.raw_text}' is not in the official allowlist.`);
      }
    } else if (target.type === "unknown") {
      result.warnings.push(`Unknown source target: '${target.raw_text}' cannot be mapped to an official domain.`);
    }

    // In stub mode, we never mark as verified
    result.checked_sources.push({
      source_name: target.raw_text,
      status: "unverified" // Stub guarantees it remains unverified
    });
  }

  if (input.metadata && input.metadata.force_fail_test === true) {
    result.failed_sources.push({ citation: "test", reason: "test fail" });
  }

  if (result.failed_sources.length > 0 || result.must_not_use.length > 0) {
    result.requires_human_review = true;
  }

  if (input.metadata && input.metadata.agentType === "aggregator" && result.official_fact_check_status === "UNVERIFIED_OFFICIAL_SOURCE") {
    result.warnings.push("Aggregator cannot alter official fact-check status. Inheriting unverified status from prior agents.");
  }

  return result;
}
