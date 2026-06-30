-- Migration to add foreign keys and clean up orphans for collaboration tables
-- Verifying domain semantics: 
-- team_members: cascades on user deletion (user leaves system -> leaves team)
-- user_notes: cascades on user deletion (user leaves system -> personal notes deleted)
-- case_comments: preserves comment if user is deleted to keep case history, cascades on case deletion (already present)

DO $$
DECLARE
    orphan_tm int;
    orphan_un int;
    orphan_cc int;
BEGIN
    -- 1. Identify and clean up team_members
    SELECT count(*) INTO orphan_tm FROM public.team_members WHERE user_id NOT IN (SELECT id FROM auth.users);
    RAISE NOTICE 'Orphaned team_members found: %', orphan_tm;
    IF orphan_tm > 0 THEN
        DELETE FROM public.team_members WHERE user_id NOT IN (SELECT id FROM auth.users);
    END IF;

    -- 2. Identify and clean up user_notes
    SELECT count(*) INTO orphan_un FROM public.user_notes WHERE user_id NOT IN (SELECT id FROM auth.users);
    RAISE NOTICE 'Orphaned user_notes found: %', orphan_un;
    IF orphan_un > 0 THEN
        DELETE FROM public.user_notes WHERE user_id NOT IN (SELECT id FROM auth.users);
    END IF;

    -- 3. Identify and clean up case_comments
    SELECT count(*) INTO orphan_cc FROM public.case_comments WHERE author_id NOT IN (SELECT id FROM auth.users);
    RAISE NOTICE 'Orphaned case_comments found (author deleted): %', orphan_cc;
    IF orphan_cc > 0 THEN
        -- We want to preserve comments, but since author_id was NOT NULL, we couldn't. 
        -- If there are already orphans, we'll set them to NULL after altering the column.
    END IF;
END $$;

-- Add constraints
ALTER TABLE public.team_members
  ADD CONSTRAINT team_members_user_id_fkey 
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.user_notes
  ADD CONSTRAINT user_notes_user_id_fkey 
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- For case_comments, we preserve comments if the user is deleted
ALTER TABLE public.case_comments 
  ALTER COLUMN author_id DROP NOT NULL;

-- Now update any existing orphaned case_comments to have a NULL author
UPDATE public.case_comments 
SET author_id = NULL 
WHERE author_id IS NOT NULL 
AND author_id NOT IN (SELECT id FROM auth.users);

ALTER TABLE public.case_comments
  ADD CONSTRAINT case_comments_author_id_fkey 
  FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE SET NULL;
