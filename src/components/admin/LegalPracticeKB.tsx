import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KBSearchPanel } from "@/components/kb/KBSearchPanel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Scale, ShieldAlert } from "lucide-react";

export function LegalPracticeKB() {
  const { t } = useTranslation("kb");
  const [references, setReferences] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="h-5 w-5" />
          <span>{t("lp_title")}</span>
        </CardTitle>
        <CardDescription>
          {t("lp_description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <ShieldAlert className="h-4 w-4" />
          <AlertDescription>
            Legacy legal_practice_kb import, enrichment, and chunk workers are disabled. Retrieval uses the live unified corpus.
          </AlertDescription>
        </Alert>
        <KBSearchPanel referencesText={references} onReferencesChange={setReferences} />
      </CardContent>
    </Card>
  );
}
