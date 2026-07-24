
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 00032: Server-side length constraints on profiles.username and bio
-- Fix #6: direct Supabase API callers can otherwise store arbitrarily large
-- values, bloating every contact list fetch.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_username_length' AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT chk_username_length CHECK (char_length(username) BETWEEN 3 AND 30);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bio_length' AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT chk_bio_length CHECK (bio IS NULL OR char_length(bio) <= 160);
  END IF;
END $$;
