import { proposeAction, type ProposedAction } from "../agent/gemini.js";
import {
  requestReceipt,
  executeWithReceipt,
  fetchReceipt,
} from "../gateway/client.js";
import { explainDecision, type ExplainInput, type ExplainResult } from "../agent/explain.js";

export interface ScenarioResult {
  userText: string;
  proposed: ProposedAction;
  decision: string;
  deny_code?: string;
  deny_reason?: string;
  receipt_id?: string;
  policy_hash?: string;
  payload_hash?: string;
  explanation: string;
  driftRejected?: boolean;
  execution?: unknown;
  audit?: {
    state: string;
    signature_valid: string;
    executed_at: string;
  };
}

type Logger = (...args: unknown[]) => void;

function printJson(log: Logger, label: string, obj: unknown): void {
  log(`  ${label}: ${JSON.stringify(obj, null, 2)}`);
}

export async function runTurn(
  userText: string,
  agentId: string,
  log: Logger = console.log,
): Promise<ScenarioResult> {
  // Step 1: Gemini proposes an action
  log(`\n  User input: "${userText}"`);
  const proposed = await proposeAction(userText);
  printJson(log, "Gemini proposed", proposed);

  // Step 2: Request authorization from the gateway
  log("\n  Requesting authorization from Action Gateway...");
  const authResult = await requestReceipt({
    agent_id: agentId,
    action_type: proposed.action_type,
    target_system: proposed.target_system,
    payload: proposed.payload,
  });

  const out: ScenarioResult = {
    userText,
    proposed,
    decision: authResult.decision,
    explanation: "",
    deny_code: authResult.deny_code,
    deny_reason: authResult.deny_reason,
    receipt_id: authResult.receipt_id,
    policy_hash: authResult.policy_hash,
    payload_hash: authResult.payload_hash,
  };

  if (authResult.decision === "DENY") {
    log("\n  ============================");
    log("  DECISION: DENIED");
    log(`  Deny code:   ${authResult.deny_code}`);
    log(`  Deny reason: ${authResult.deny_reason}`);
    if (authResult.policy_hash) {
      log(`  Policy hash: ${authResult.policy_hash}`);
    }
    log("  ============================");

    // Generate Gemini explanation for denial
    const explainInput: ExplainInput = {
      userText,
      proposedAction: proposed,
      decision: "DENIED",
      deny_code: authResult.deny_code,
      deny_reason: authResult.deny_reason,
    };
    const explainResult: ExplainResult = await explainDecision(explainInput);
    out.explanation = explainResult.text;
    out.driftRejected = explainResult.driftRejected;
    log(`\n  Gemini explanation:\n  ${out.explanation}`);
    if (explainResult.driftRejected) log(`  [drift rejected]`);
    return out;
  }

  // Step 3: ALLOW — print receipt info and execute
  log("\n  ============================");
  log("  DECISION: ALLOWED");
  log(`  Receipt ID:   ${authResult.receipt_id}`);
  log(`  Policy hash:  ${authResult.policy_hash}`);
  log(`  Payload hash: ${authResult.payload_hash}`);
  log("  ============================");

  log("\n  Executing action with receipt...");
  const execResult = await executeWithReceipt({
    receipt_id: authResult.receipt_id!,
    agent_id: agentId,
    payload: proposed.payload,
  });
  printJson(log, "Execution result", execResult);
  out.execution = execResult;

  // Step 4: Fetch receipt for audit
  log("\n  Fetching receipt for audit...");
  try {
    const receipt = await fetchReceipt(authResult.receipt_id!);
    log("  --- Receipt Audit ---");
    log(`  State:          ${receipt.state ?? receipt.status ?? "unknown"}`);
    log(`  Signature valid: ${receipt.signature_valid ?? "N/A"}`);
    log(`  Executed at:    ${receipt.executed_at ?? "N/A"}`);
    log("  ---------------------");
    out.audit = {
      state: String(receipt.state ?? receipt.status ?? "unknown"),
      signature_valid: String(receipt.signature_valid ?? "N/A"),
      executed_at: String(receipt.executed_at ?? "N/A"),
    };
  } catch (err) {
    log(`  (Could not fetch receipt: ${err instanceof Error ? err.message : err})`);
  }

  // Generate Gemini explanation for allowed+executed
  const explainInput: ExplainInput = {
    userText,
    proposedAction: proposed,
    decision: "ALLOWED",
    receipt_id: authResult.receipt_id,
    policy_hash: authResult.policy_hash,
    payload_hash: authResult.payload_hash,
    audit: out.audit,
  };
  const explainResult: ExplainResult = await explainDecision(explainInput);
  out.explanation = explainResult.text;
  out.driftRejected = explainResult.driftRejected;
  log(`\n  Gemini explanation:\n  ${out.explanation}`);
  if (explainResult.driftRejected) log(`  [drift rejected]`);

  return out;
}
