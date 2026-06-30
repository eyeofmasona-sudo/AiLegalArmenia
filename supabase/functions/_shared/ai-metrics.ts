import { warn } from "./safe-logger.ts";

type MetricClient = {
  rpc: (
    fn: string,
    params?: Record<string, unknown>,
  ) => PromiseLike<{ error: { message?: string } | null }>;
};

export interface AiMetricInput {
  fnName: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  status?: "success" | "failed";
  errorMessage?: string | null;
  caseId?: string | null;
  userId?: string | null;
}

export async function recordAiMetric(
  supabase: MetricClient,
  input: AiMetricInput,
): Promise<void> {
  const inputTokens = Math.max(0, Number(input.inputTokens ?? 0));
  const outputTokens = Math.max(
    0,
    Number(input.outputTokens ?? Math.max(0, Number(input.totalTokens ?? 0) - inputTokens)),
  );

  try {
    const { error } = await supabase.rpc("record_ai_metric", {
      p_fn_name: input.fnName,
      p_model: input.model ?? null,
      p_input_tokens: inputTokens,
      p_output_tokens: outputTokens,
      p_cost_usd: Number(input.costUsd ?? 0),
      p_latency_ms: input.latencyMs ?? null,
      p_status: input.status ?? "success",
      p_error_message: input.errorMessage ?? null,
      p_case_id: input.caseId ?? null,
      p_user_id: input.userId ?? null,
    });

    if (error) {
      warn("ai-metrics", "record_ai_metric failed", {
        fn: input.fnName,
        message: error.message,
      });
    }
  } catch (error) {
    warn("ai-metrics", "record_ai_metric unavailable", {
      fn: input.fnName,
      error: String(error),
    });
  }
}
