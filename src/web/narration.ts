import type { ScenarioResult } from "../assistant/run.js";

/**
 * Build a short narration string derived strictly from gateway decision +
 * receipt/audit fields. No freeform reasoning or extra claims.
 */
export function buildNarration(result: ScenarioResult): string {
  const parts: string[] = [];

  // Opening — what the user asked
  parts.push(`The user said: "${result.userText}".`);

  // Gemini planning reasoning (if available)
  if (result.proposed.plan.length > 0) {
    parts.push(`Gemini's reasoning: ${result.proposed.plan.join(" ")}`);
  }

  // Proposed action summary
  parts.push(
    `Gemini proposed a ${result.proposed.action_type} action targeting ${result.proposed.target_system}.`,
  );

  // Gateway decision
  if (result.decision === "DENY") {
    parts.push(`The Action Gateway denied this request.`);
    if (result.deny_code) {
      parts.push(`Deny code: ${result.deny_code}.`);
    }
    if (result.deny_reason) {
      parts.push(`Reason: ${result.deny_reason}.`);
    }
    if (result.policy_hash) {
      parts.push(`Policy hash: ${result.policy_hash.slice(0, 12)}.`);
    }
    parts.push(`The action was blocked. No execution occurred.`);
  } else {
    parts.push(`The Action Gateway approved this request.`);
    if (result.receipt_id) {
      parts.push(`Receipt ID: ${result.receipt_id.slice(0, 12)}.`);
    }
    if (result.policy_hash) {
      parts.push(`Policy hash: ${result.policy_hash.slice(0, 12)}.`);
    }
    if (result.payload_hash) {
      parts.push(`Payload hash: ${result.payload_hash.slice(0, 12)}.`);
    }

    // Audit state
    if (result.audit) {
      parts.push(
        `Audit: state is ${result.audit.state}, signature ${result.audit.signature_valid}.`,
      );
    }

    // Only claim "executed" when audit confirms it
    const wasExecuted =
      result.audit?.state?.toLowerCase() === "executed" &&
      result.audit?.executed_at &&
      result.audit.executed_at !== "N/A";

    if (wasExecuted) {
      parts.push(`The action was executed with cryptographic proof.`);
    } else {
      parts.push(`The action was authorized. Receipt issued.`);
    }
  }

  return parts.join(" ");
}
