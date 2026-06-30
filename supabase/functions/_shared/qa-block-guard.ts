/**
 * Phase 7.5A — QA Block Guard
 *
 * Hard-blocking utility for non-stream endpoints.
 * When Final Legal QA marks content as FAIL or safe_to_show_user=false,
 * endpoints must replace public content fields with this safe message.
 *
 * Blocking conditions (any one is sufficient):
 *   - final_legal_qa_status === "FAIL"
 *   - safe_to_show_user === false
 *
 * NOT blocked:
 *   - final_legal_qa_status === "WARNING"
 *   - final_legal_qa_status === "REQUIRES_HUMAN_REVIEW" with safe_to_show_user === true
 *   - final_legal_qa is null / undefined (QA not run)
 *
 * All QA metadata (final_legal_qa, citation verification, official_source_fact_check,
 * pipeline_metadata) is always preserved regardless of block status.
 */

export const QA_BLOCK_MESSAGE_HY =
  "Բովանդակությունը ստուգման պատճառով ժամանակավորապես անհասանելի է: " +
  "Խնդրում ենք կրկին փորձել կամ կապվել աջակցության հետ:";

export interface FinalLegalQALike {
  final_legal_qa_status?: string;
  safe_to_show_user?: boolean;
}

/**
 * Returns true when the QA result requires blocking content from the public response.
 */
export function isQABlocked(
  finalLegalQA: FinalLegalQALike | null | undefined,
): boolean {
  if (!finalLegalQA) return false;
  return (
    finalLegalQA.safe_to_show_user === false ||
    finalLegalQA.final_legal_qa_status === "FAIL"
  );
}

/**
 * Returns a sanitized parsedResult for multi-agent-analyze when QA blocks.
 * Clears all generated content fields; preserves structure expected by callers.
 */
export function buildBlockedAgentResult(): Record<string, unknown> {
  return {
    summary: QA_BLOCK_MESSAGE_HY,
    analysis: QA_BLOCK_MESSAGE_HY,
    findings: [],
    evidenceItems: [],
  };
}
