-- Migration to add freshness metadata to KB tables
ALTER TABLE public.knowledge_base 
ADD COLUMN IF NOT EXISTS last_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
ADD COLUMN IF NOT EXISTS last_modified_at TIMESTAMP WITH TIME ZONE DEFAULT now();

ALTER TABLE public.legal_practice_kb 
ADD COLUMN IF NOT EXISTS last_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
ADD COLUMN IF NOT EXISTS last_modified_at TIMESTAMP WITH TIME ZONE DEFAULT now();

-- Create an index to quickly find stale documents
CREATE INDEX IF NOT EXISTS idx_knowledge_base_fetched 
ON public.knowledge_base(last_fetched_at ASC NULLS FIRST);

CREATE INDEX IF NOT EXISTS idx_legal_practice_kb_fetched 
ON public.legal_practice_kb(last_fetched_at ASC NULLS FIRST);

-- Create a reporting function to find stale documents
CREATE OR REPLACE FUNCTION public.get_stale_documents(older_than INTERVAL)
RETURNS TABLE (
    doc_id UUID,
    title TEXT,
    source_type TEXT,
    last_fetched_at TIMESTAMP WITH TIME ZONE,
    days_stale INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT 
        id as doc_id, 
        title, 
        'kb' as source_type, 
        last_fetched_at,
        EXTRACT(DAY FROM now() - COALESCE(last_fetched_at, '1970-01-01'::timestamp))::INTEGER as days_stale
    FROM public.knowledge_base 
    WHERE last_fetched_at < (now() - older_than) OR last_fetched_at IS NULL
    UNION ALL
    SELECT 
        id as doc_id, 
        title, 
        'practice' as source_type, 
        last_fetched_at,
        EXTRACT(DAY FROM now() - COALESCE(last_fetched_at, '1970-01-01'::timestamp))::INTEGER as days_stale
    FROM public.legal_practice_kb 
    WHERE last_fetched_at < (now() - older_than) OR last_fetched_at IS NULL
    ORDER BY days_stale DESC;
$$;
