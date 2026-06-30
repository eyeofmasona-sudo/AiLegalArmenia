import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

const source = () =>
  Deno.readTextFile("supabase/functions/legal-chat/index.ts");

Deno.test("legal-chat safe streaming - streamMode API exists", async () => {
  const text = await source();

  assertStringIncludes(text, 'type LegalChatStreamMode = "safe" | "legacy"');
  assertStringIncludes(text, "function resolveStreamMode");
  assertStringIncludes(text, "reqBody.streamMode");
  assertStringIncludes(text, "LEGAL_CHAT_STREAM_MODE");
});

Deno.test("legal-chat safe streaming - safe mode does not emit raw token chunks before QA", async () => {
  const text = await source();
  const transformBlock = text.match(
    /transform\(chunk, controller\)[\s\S]*?async flush\(controller\)/,
  )?.[0] ?? "";

  assertStringIncludes(transformBlock, 'if (streamMode === "legacy")');
  assertStringIncludes(
    transformBlock,
    'controller.enqueue(encoder.encode(line + "\\n"))',
  );
  assertEquals(
    transformBlock.includes(
      'streamMode === "safe") {\n              controller.enqueue(encoder.encode(line',
    ),
    false,
  );
  assertStringIncludes(
    transformBlock,
    'if (streamMode === "legacy") {\n            controller.enqueue(chunk);',
  );
});

Deno.test("legal-chat safe streaming - progress events and heartbeat configured", async () => {
  const text = await source();

  for (
    const eventName of [
      "reasoning_started",
      "retrieval_complete",
      "generating_draft",
      "verifying_citations",
      "official_fact_check",
      "final_qa",
      "completed",
      "blocked",
    ]
  ) {
    assertStringIncludes(text, `sseEvent("${eventName}"`);
  }
  assertStringIncludes(text, "const HEARTBEAT_INTERVAL_MS = 5000");
  assertStringIncludes(text, "setInterval");
  assertStringIncludes(text, 'sseEvent("progress"');
});

Deno.test("legal-chat safe streaming - final_text is emitted only after QA result exists", async () => {
  const text = await source();
  const qaIndex = text.indexOf(
    "const qaResult = await runLegalPipeline",
    text.indexOf("async flush"),
  );
  const finalTextIndex = text.indexOf('sseEvent("final_text"', qaIndex);
  const blockCheckIndex = text.indexOf(
    "shouldBlockChatOutput(qaResult.finalLegalQA)",
    qaIndex,
  );

  assert(qaIndex > 0);
  assert(blockCheckIndex > qaIndex);
  assert(finalTextIndex > blockCheckIndex);
});

Deno.test("legal-chat safe streaming - blocked event does not contain raw unsafe text", async () => {
  const text = await source();
  const blockedBlock =
    text.match(/sseEvent\(\"blocked\"[\s\S]*?\}\)\)\);/)?.[0] ?? "";

  assertStringIncludes(
    text,
    "Վերլուծությունը չի կարող ցուցադրվել, քանի որ վերջնական իրավական որակի ստուգումը հայտնաբերել է բարձր ռիսկային խնդիրներ։ Խնդրում ենք դիմել իրավաբանի կամ կրկնել հարցումը՝ լրացուցիչ փաստերով։",
  );
  assertEquals(text.includes("ХЋХҐЦЂХ¬"), false);
  assertStringIncludes(blockedBlock, "SAFE_BLOCKED_MESSAGE_HY");
  assertEquals(blockedBlock.includes("streamedText"), false);
  assertEquals(blockedBlock.includes("text:"), false);
});

Deno.test("legal-chat safe streaming - metadata events still emitted after safe verdict", async () => {
  const text = await source();
  const eventIndex = (eventName: string) =>
    text.search(new RegExp(`sseEvent\\(\\s*"${eventName}"`));
  const metadataIndex = eventIndex("pipeline_metadata");
  const citationIndex = eventIndex("citation_verification");
  const officialIndex = eventIndex("official_source_fact_check");
  const finalQaIndex = eventIndex("final_legal_qa");

  assert(metadataIndex > 0);
  assert(citationIndex > metadataIndex);
  assert(officialIndex > citationIndex);
  assert(finalQaIndex > officialIndex);
});

Deno.test("legal-chat safe streaming - DONE remains last after heartbeat cleanup", async () => {
  const text = await source();
  const clearIndex = text.lastIndexOf("clearInterval(heartbeatId)");
  const doneIndex = text.lastIndexOf("data: [DONE]");

  assert(clearIndex > 0);
  assert(doneIndex > clearIndex);
});

Deno.test("legal-chat legacy streaming - old token forwarding is preserved and marked", async () => {
  const text = await source();

  assertStringIncludes(text, "streaming_safety_mode: streamingSafetyMode");
  assertStringIncludes(text, "legacy_unverified_streaming");
  assertStringIncludes(
    text,
    'if (streamMode === "legacy") {\n              controller.enqueue(encoder.encode(line + "\\n"));',
  );
});

Deno.test("legal-chat safe streaming - QA phase uses cached RAG only", async () => {
  const text = await source();
  const qaBlock = text.match(
    /const qaResult = await runLegalPipeline[\s\S]*?const citationVerification/,
  )?.[0] ?? "";

  assertStringIncludes(qaBlock, "generatedText: streamedText");
  assertStringIncludes(qaBlock, "cachedRagResult ??");
  assertEquals(qaBlock.includes("searchKB("), false);
  assertEquals(qaBlock.includes("searchPractice("), false);
});
