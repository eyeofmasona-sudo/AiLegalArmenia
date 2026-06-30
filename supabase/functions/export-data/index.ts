import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors } from "../_shared/edge-security.ts";
import { legacyDisabledResponse } from "../_shared/legacy-disabled.ts";

serve(async (req) => {
  const cors = handleCors(req);
  if (cors.errorResponse) return cors.errorResponse;

  return legacyDisabledResponse(cors.corsHeaders);
});
