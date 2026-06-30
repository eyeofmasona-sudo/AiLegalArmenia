import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Cpu, Globe } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type AIProvider = "openai" | "openrouter";

type AppSettingsRow = { value: string };
type AppSettingsQueryBuilder = {
  select: (columns: string) => AppSettingsQueryBuilder;
  eq: (column: string, value: unknown) => AppSettingsQueryBuilder;
  single: () => PromiseLike<{
    data: AppSettingsRow | null;
    error: { message: string } | null;
  }>;
  upsert: (
    value: { key: string; value: AIProvider; updated_at: string },
    options: { onConflict: string },
  ) => PromiseLike<{ error: { message: string } | null }>;
};
type AppSettingsClient = typeof supabase & {
  from: (table: "app_settings") => AppSettingsQueryBuilder;
};

const PROVIDER_INFO: Record<AIProvider, { label: string; description: string; icon: typeof Cpu; badge: string }> = {
  openai: {
    label: "OpenAI Direct",
    description: "Only openai/* chat models can run directly through api.openai.com.",
    icon: Cpu,
    badge: "OpenAI",
  },
  openrouter: {
    label: "OpenRouter",
    description: "Claude/Gemini legal models route through OpenRouter. Embeddings remain direct.",
    icon: Globe,
    badge: "OpenRouter",
  },
};

export function AIProviderSwitch() {
  const [provider, setProvider] = useState<AIProvider>("openrouter");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadProvider();
  }, []);

  const loadProvider = async () => {
    try {
      const { data, error } = await (supabase as AppSettingsClient)
        .from("app_settings")
        .select("value")
        .eq("key", "ai_provider")
        .single();

      if (!error && data) {
        setProvider(data.value === "openai" ? "openai" : "openrouter");
      }
    } catch {
      // app_settings may be unavailable in some environments.
    } finally {
      setLoading(false);
    }
  };

  const handleChange = async (newProvider: AIProvider) => {
    setSaving(true);

    try {
      const { error } = await (supabase as AppSettingsClient)
        .from("app_settings")
        .upsert(
          { key: "ai_provider", value: newProvider, updated_at: new Date().toISOString() },
          { onConflict: "key" },
        );

      if (error) {
        toast.error("Provider save failed: " + error.message);
        return;
      }

      setProvider(newProvider);
      toast.success(`Switched to ${PROVIDER_INFO[newProvider].label}`);
    } catch {
      toast.error("Provider save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const info = PROVIDER_INFO[provider];
  const Icon = info.icon;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Cpu className="h-4 w-4" />
          AI Provider
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <Label className="text-sm font-medium">{info.label}</Label>
              <Badge variant="default">
                <Icon className="h-3 w-3 mr-1" /> {info.badge}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{info.description}</p>
          </div>
          <div className="flex items-center gap-2">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            <Select value={provider} onValueChange={(v) => handleChange(v as AIProvider)} disabled={saving}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI Direct</SelectItem>
                <SelectItem value="openrouter">OpenRouter</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
