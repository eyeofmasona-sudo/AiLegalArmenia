-- Make search RPCs SECURITY DEFINER so they bypass RLS
-- This allows anon users to search the legal corpus (read-only, safe)
-- Without this, anon users get 0 results (RLS blocks) and authenticated
-- users get statement timeouts (slow RLS-filtered queries).

ALTER FUNCTION public.search_legal_corpus_dual SECURITY DEFINER;
ALTER FUNCTION public.search_legal_corpus SECURITY DEFINER;
