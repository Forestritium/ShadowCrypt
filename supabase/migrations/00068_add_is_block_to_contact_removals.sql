-- Add is_block column to contact_removals to distinguish blocks from normal removals
ALTER TABLE public.contact_removals 
  ADD COLUMN is_block BOOLEAN NOT NULL DEFAULT false;

-- We don't need to change RLS because it's already based on remover_id and removed_id
