import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../env.js";

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

export interface ExplainResult {
  text: string;
  driftRejected: boolean;
}

export interface ExplainInput {
  userText: string;
  proposedAction: {
    plan?: string[];
    action_type: string;
    target_system: string;
    payload: Record<string, unknown>;
  };
  decision: "ALLOWED" | "DENIED" | "REPLAY_DENIED";
  deny_code?: string;
  deny_reason?: string;
  receipt_id?: string;
  policy_hash?: string;
  payload_hash?: string;
  audit?: {
    state?: string;
    signature_valid?: string;
    executed_at?: string;
  };
}

const EXPLAIN_PROMPT = `You are a governed action explainer. You describe the outcome of a payment or transaction action to the end user. This is NOT a chatbot. You do NOT answer questions, suggest features, or discuss capabilities.

This explanation will be spoken aloud via TTS.

DOMAIN INVARIANT:
You are only allowed to describe actions related to payments and transaction safety.
Do not mention weather, search, browsing, unsupported features, or capability limits unless explicitly present in the input facts.
Do not invent tools, actions, or system behaviors that are not in the provided facts.

FACT-BOUND INVARIANT:
You may only use fields provided in the input object.
If a fact is not present, do not infer or describe it.
Do NOT speculate about why something happened beyond what the facts state.

OUTCOME INVARIANT:
Each explanation must clearly match one of three cases:
- ALLOWED: the action was completed successfully.
- DENIED: the action was stopped due to a policy limit or safety rule.
- REPLAY_DENIED: the action was already used and cannot be repeated.
If the input decision does not match one of these, say nothing beyond the facts.

VARIATION RULE:
You may vary wording slightly between runs, but:
- Meaning must remain identical to the outcome.
- No new concepts introduced.
- No system internals exposed.

SAFETY PHRASE RULE:
Always include at least one of these phrases (exact or near-exact):
- "nothing was sent"
- "I didn't complete that"
- "this was completed"
- "can't be used again"

TONE:
Use "I" for the assistant. Refer to the user as "you".
Be calm, clear, and protective. No blame. No alarmist language.

FORBIDDEN TERMS (never output these):
"gateway", "deny_code", "policy_hash", "payload_hash", "signature", "receipt ID", "receipt id", "security rules", "AI recognized", "API", "unsupported", "feature", "browse", "weather", "search", or any snake_case identifier.

LENGTH: 2–3 sentences maximum. Plain text only. No markdown, no bullet points.`;

function buildFactBlock(input: ExplainInput): string {
  const lines: string[] = [];
  lines.push(`User request: "${input.userText}"`);
  lines.push(`Proposed action: ${input.proposedAction.action_type} on ${input.proposedAction.target_system}`);
  if (input.proposedAction.plan && input.proposedAction.plan.length > 0) {
    lines.push(`Agent reasoning: ${input.proposedAction.plan.join("; ")}`);
  }
  lines.push(`Gateway decision: ${input.decision}`);
  if (input.deny_code) lines.push(`Denial category: ${input.deny_code}`);
  if (input.deny_reason) lines.push(`Denial detail: ${input.deny_reason}`);
  if (input.receipt_id) lines.push(`Receipt was issued: yes`);
  if (input.audit?.state) lines.push(`Audit state: ${input.audit.state}`);
  if (input.audit?.executed_at && input.audit.executed_at !== "N/A") {
    lines.push(`Execution confirmed: yes`);
  }
  return lines.join("\n");
}

export const DRIFT_FALLBACK =
  "I can only help with payment-related actions here, so I didn't proceed. Nothing was sent.";

function deterministicFallback(input: ExplainInput): string {
  if (input.decision === "REPLAY_DENIED") {
    return "That action was already completed earlier, so it can't be used again.";
  }
  if (input.decision === "DENIED") {
    return "I didn't complete that request because it exceeds the allowed limit. Nothing was sent.";
  }
  return "I completed that payment for you. The action was approved and finished successfully.";
}

const COMPLETION_PHRASES = ["completed", "processed", "finished", "approved", "executed", "succeeded", "went through"];
const DENIAL_PHRASES = ["didn't complete", "did not complete", "refused", "blocked", "denied", "stopped", "prevented", "wasn't sent", "was not sent", "nothing was sent"];

function hasContradiction(text: string, decision: string): boolean {
  if (decision !== "DENIED") return false;
  const lower = text.toLowerCase();
  const hasDenial = DENIAL_PHRASES.some(p => lower.includes(p));
  const hasCompletion = COMPLETION_PHRASES.some(p => lower.includes(p));
  // Contradiction: claims both denial AND completion, or claims completion on a DENIED decision
  if (hasCompletion) return true;
  // Also reject if no denial language at all for a DENIED decision
  if (!hasDenial) return true;
  return false;
}

// ── Post-generation validator ──
// Rejects domain drift, jargon leaks, and missing domain references.
const REJECT_TOKENS = [
  "weather", "browse", "search", "unsupported", "feature",
  "api", "gateway", "policy_hash", "payload_hash", "receipt id",
  "receipt_id", "deny_code", "security_rules",
];
const SNAKE_CASE_RE = /\b[a-z]+_[a-z_]+\b/;
const DOMAIN_RE = /transfer|payment|sent|complete|denied|denial|replay|limit|approved|finished/i;

export function validateExplanation(text: string): boolean {
  const lower = text.toLowerCase();
  for (const token of REJECT_TOKENS) {
    if (lower.includes(token)) return false;
  }
  if (SNAKE_CASE_RE.test(text)) return false;
  if (!DOMAIN_RE.test(text)) return false;
  return true;
}

/**
 * Ask Gemini to produce a 2–4 sentence human-friendly explanation of
 * what happened. Falls back to a deterministic string on any failure.
 */
export async function explainDecision(input: ExplainInput): Promise<ExplainResult> {
  try {
    const model = genAI.getGenerativeModel({
      model: env.GEMINI_MODEL,
      systemInstruction: EXPLAIN_PROMPT,
    });

    const factBlock = buildFactBlock(input);
    const result = await model.generateContent(
      `Given these facts, explain what happened:\n\n${factBlock}`,
    );
    const text = result.response.text().trim();

    if (!text || text.length > 800) {
      return { text: deterministicFallback(input), driftRejected: false };
    }

    if (!validateExplanation(text)) {
      console.warn(`[explain] Validator rejected output, using fallback. Raw: ${text.slice(0, 120)}`);
      return { text: DRIFT_FALLBACK, driftRejected: true };
    }

    if (hasContradiction(text, input.decision)) {
      console.warn(`[explain] Contradiction detected (decision=${input.decision}), using deterministic fallback. Raw: ${text.slice(0, 120)}`);
      return { text: deterministicFallback(input), driftRejected: false };
    }

    return { text, driftRejected: false };
  } catch (err) {
    console.error(
      `[explain] Gemini explanation failed: ${err instanceof Error ? err.message : err}`,
    );
    return { text: deterministicFallback(input), driftRejected: false };
  }
}
