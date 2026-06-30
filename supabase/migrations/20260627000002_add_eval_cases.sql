-- Seed migration to add missing eval cases for new invariants

-- Add to an existing suite or create a new one. Let's use the 'a0a0a0a0-a0a0-4000-8000-000000000001' P0 suite.

-- 1. refusal_when_no_support
INSERT INTO public.eval_cases (id, suite_id, name, description, target_function, mode, input_payload, invariants, tags)
VALUES (
  gen_random_uuid(),
  'a0a0a0a0-a0a0-4000-8000-000000000001',
  'Refusal when no support',
  'Ensure legal-chat refuses to invent facts when RAG returns empty',
  'legal-chat',
  'single_call',
  '{"message": "A completely nonsensical legal question that has no basis in Armenian law"}',
  '[
    {"type": "refusal_when_no_support"}
  ]',
  '{"hardening", "hallucination"}'
);

-- 2. temporal_warning_when_missing
INSERT INTO public.eval_cases (id, suite_id, name, description, target_function, mode, input_payload, invariants, tags)
VALUES (
  gen_random_uuid(),
  'a0a0a0a0-a0a0-4000-8000-000000000001',
  'Temporal warning when missing reference date',
  'Ensure legal-chat emits a temporal warning when caseDate is omitted',
  'legal-chat',
  'single_call',
  '{"message": "What is the penalty for tax evasion?"}',
  '[
    {"type": "temporal_warning_when_missing"}
  ]',
  '{"hardening", "temporal"}'
);
