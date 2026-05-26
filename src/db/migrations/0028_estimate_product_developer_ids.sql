ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS product_developer_ids INTEGER[] NOT NULL DEFAULT '{}';

UPDATE estimates
  SET product_developer_ids = ARRAY[product_developer_id]
  WHERE product_developer_id IS NOT NULL;

ALTER TABLE estimates
  DROP COLUMN IF EXISTS product_developer_id;
