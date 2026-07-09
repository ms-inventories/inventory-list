CREATE TABLE IF NOT EXISTS frg_content_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_type text NOT NULL CHECK (block_type IN ('announcement', 'event', 'resource')),
  title text NOT NULL,
  summary text,
  body text,
  href text,
  link_label text,
  event_at timestamptz,
  sort_order integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'hidden')),
  created_by uuid REFERENCES app_users(id),
  updated_by uuid REFERENCES app_users(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS frg_content_blocks_public_idx
  ON frg_content_blocks(status, block_type, sort_order, published_at DESC, updated_at DESC);
