import { env } from "../env.js";

const BASE = () => env.GATEWAY_URL;

export interface RequestReceiptInput {
  agent_id: string;
  action_type: string;
  target_system: string;
  payload: Record<string, unknown>;
  policy_context?: Record<string, unknown>;
}

export interface RequestReceiptResult {
  decision: string;
  receipt_id?: string;
  deny_code?: string;
  deny_reason?: string;
  policy_hash?: string;
  payload_hash?: string;
}

export interface ExecuteInput {
  receipt_id: string;
  agent_id: string;
  payload: Record<string, unknown>;
}

interface PostResult {
  status: number;
  data: Record<string, unknown>;
}

async function post(path: string, body: unknown): Promise<PostResult> {
  const res = await fetch(`${BASE()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON response body
  }
  if (!res.ok && Object.keys(data).length === 0) {
    throw new Error(`Gateway ${path} returned ${res.status}`);
  }
  return { status: res.status, data };
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE()}${path}`);
  if (!res.ok) {
    throw new Error(`Gateway GET ${path} returned ${res.status}`);
  }
  return res.json();
}

function extractDeny(data: Record<string, unknown>): RequestReceiptResult {
  return {
    decision: "DENY",
    deny_code: String(data.deny_code ?? data.code ?? "POLICY_DENY"),
    deny_reason: String(
      data.deny_reason ?? data.reason ?? data.message ?? "Request denied by policy",
    ),
    policy_hash: data.policy_hash ? String(data.policy_hash) : undefined,
    payload_hash: data.payload_hash ? String(data.payload_hash) : undefined,
  };
}

export async function requestReceipt(
  input: RequestReceiptInput,
): Promise<RequestReceiptResult> {
  const { status, data } = await post("/v1/actions/request", input);

  // Fail-closed: any non-2xx HTTP status is a DENY
  if (status < 200 || status >= 300) {
    return extractDeny(data);
  }

  // Check body-level decision — look in top-level and nested receipt
  const receipt = data.receipt as Record<string, unknown> | undefined;
  const bodyDecision = String(
    data.decision ?? receipt?.decision ?? data.status ?? "UNKNOWN",
  ).toUpperCase();

  // Explicit DENY in body
  if (bodyDecision === "DENY") {
    return extractDeny(data);
  }

  // Only classify as ALLOW if body explicitly says ALLOW
  if (bodyDecision !== "ALLOW") {
    // Ambiguous / unknown → fail closed
    return extractDeny(data);
  }

  // ALLOW path — extract receipt info
  return {
    decision: "ALLOW",
    receipt_id: String(receipt?.receipt_id ?? data.receipt_id ?? ""),
    policy_hash: String(receipt?.policy_hash ?? data.policy_hash ?? ""),
    payload_hash: String(receipt?.payload_hash ?? data.payload_hash ?? ""),
  };
}


export async function executeWithReceipt(input: ExecuteInput): Promise<unknown> {
  const { data } = await post("/v1/actions/execute", input);
  return data;
}

export async function fetchReceipt(receiptId: string): Promise<Record<string, unknown>> {
  return get(`/v1/receipts/${receiptId}`) as Promise<Record<string, unknown>>;
}
