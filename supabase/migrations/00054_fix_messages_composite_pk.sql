
-- ── Replace the single-column messages PK with a composite (id, owner_id) PK ──
--
-- WHY: The existing schema has `id uuid PRIMARY KEY` (global uniqueness) plus
-- a UNIQUE(id, owner_id) constraint added in migration 00046.
--
-- Problem 1 — 400 Bad Request:
--   PostgREST upsert with on_conflict=id,owner_id requires the column list to
--   map to exactly ONE unique index.  When `id` is the sole PK (already a unique
--   index), PostgREST v11+ rejects the composite target as ambiguous/redundant,
--   returning HTTP 400 before the query ever reaches the database.
--
-- Problem 2 — 409 Conflict:
--   Sender and receiver both store a copy of the same message under the shared
--   UUID (sharedMsgId).  With a single-column PK on `id`, the second INSERT
--   collides on the PK → PostgreSQL throws 23505 → PostgREST returns HTTP 409.
--
-- Fix: Make (id, owner_id) the PRIMARY KEY.  Each user now has their own row
-- slot for the same message UUID, and PostgREST's on_conflict=id,owner_id maps
-- to the PK unambiguously.
--
-- No other table has a FOREIGN KEY referencing messages(id), so dropping the
-- old PK constraint is safe.

ALTER TABLE public.messages
  DROP CONSTRAINT messages_pkey;

-- The named UNIQUE constraint is now superseded by the new composite PK.
ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_id_owner_unique;

ALTER TABLE public.messages
  ADD PRIMARY KEY (id, owner_id);
