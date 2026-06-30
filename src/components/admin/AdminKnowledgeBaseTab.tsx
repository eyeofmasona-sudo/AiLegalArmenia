import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useKnowledgeBase, type KBFilters } from "@/hooks/useKnowledgeBase";
import { KBSearchFilters } from "@/components/kb/KBSearchFilters";
import { KBDocumentCard } from "@/components/kb/KBDocumentCard";
import { KBPagination } from "@/components/kb/KBPagination";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, BookOpen, ShieldAlert } from "lucide-react";

export function AdminKnowledgeBaseTab() {
  const { t } = useTranslation(["kb"]);
  const navigate = useNavigate();
  const [filters, setFilters] = useState<KBFilters>({ page: 1, pageSize: 12 });

  const {
    documents,
    pagination,
    isLoading,
  } = useKnowledgeBase(filters);

  const handlePageChange = (page: number) => {
    setFilters({ ...filters, page });
  };

  return (
    <div className="space-y-6">
      <Alert>
        <ShieldAlert className="h-4 w-4" />
        <AlertDescription>
          Legacy knowledge_base/legal_practice_kb write/import tools are disabled. Search uses the live unified corpus.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            {t("knowledge_base")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <KBSearchFilters filters={filters} onFiltersChange={setFilters} />
        </CardContent>
      </Card>

      {filters.search && filters.search.length >= 2 && documents.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t("results_found", { count: documents.length })}
        </p>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : documents.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16">
          <BookOpen className="h-12 w-12 text-muted-foreground/50" />
          <p className="mt-4 text-lg font-medium text-muted-foreground">
            {t("no_results")}
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {documents.map((doc) => (
              <KBDocumentCard
                key={doc.id}
                document={doc}
                onView={(id) => navigate(`/kb/${id}`)}
                isAdmin={true}
                rank={"relevancePct" in doc ? (doc.relevancePct as number) : "rank" in doc ? (doc.rank as number) : undefined}
                searchQuery={filters.search}
              />
            ))}
          </div>

          {pagination && (
            <div className="mt-6">
              <KBPagination
                page={pagination.page}
                totalPages={pagination.totalPages}
                total={pagination.total}
                onPageChange={handlePageChange}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
