import { useQuery } from '@tanstack/react-query';
import type { Database } from '@/integrations/supabase/types';

type KbCategory = Database['public']['Enums']['kb_category'];

export interface CategoryCount {
  category: KbCategory;
  count: number;
}

export function useKBCategoryCounts() {
  return useQuery({
    queryKey: ['kb-category-counts'],
    queryFn: async () => {
      return new Map<string, number>();
    },
  });
}

export function useKBCategoryDocuments(category: KbCategory | null) {
  return useQuery({
    queryKey: ['kb-category-docs', category],
    queryFn: async () => {
      if (!category) return [];
      return [];
    },
    enabled: !!category,
  });
}
