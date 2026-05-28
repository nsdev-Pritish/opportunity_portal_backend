-- Change estimate_line_items.item_type_id FK from item_types → cs_items
ALTER TABLE estimate_line_items
  DROP CONSTRAINT IF EXISTS estimate_line_items_item_type_id_item_types_id_fk;

ALTER TABLE estimate_line_items
  ADD CONSTRAINT estimate_line_items_item_type_id_cs_items_id_fk
  FOREIGN KEY (item_type_id) REFERENCES cs_items(id);
