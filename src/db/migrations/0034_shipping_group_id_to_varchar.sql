-- shipping_group_id is used as a text label ("Group 1", "Group 2", ...)
-- not as a FK to the shipping_groups table; drop FK and widen to varchar.

ALTER TABLE estimate_line_items
  DROP CONSTRAINT IF EXISTS estimate_line_items_shipping_group_id_shipping_groups_id_fk;

ALTER TABLE estimate_line_items
  ALTER COLUMN shipping_group_id TYPE VARCHAR(255) USING shipping_group_id::text;
