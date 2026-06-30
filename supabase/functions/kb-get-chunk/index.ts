import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors } from "../_shared/edge-security.ts";
import { legacyDisabledResponse } from "../_shared/legacy-disabled.ts";

serve(async (req) => {
  // Handle CORS
  const cors = handleCors(req);
  if (cors.errorResponse) return cors.errorResponse;
  const corsHeaders = cors.corsHeaders!;

  try {
    return legacyDisabledResponse(corsHeaders);

  } catch (error) {
    console.error("KB get-chunk error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Failed to get chunk" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
