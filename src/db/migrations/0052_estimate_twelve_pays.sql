-- Add the two "Twelve Pays" YES/NO fields to estimates.
-- These map to the NetSuite custom body fields on the Estimate / Sales Order:
--   twelve_pays_import_frt   → custbody_twelve_pays_import_frt   (Twelve Pays Import FRT/Duty)
--   twelve_pays_ship_to_cust → custbody_twelve_pays_ship_to_cust (Twelve Pays Shipping to Customer)
-- Values are 'YES' or 'NO' (frontend dropdown); NULL when unset.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS twelve_pays_import_frt   VARCHAR(3),
  ADD COLUMN IF NOT EXISTS twelve_pays_ship_to_cust VARCHAR(3);
