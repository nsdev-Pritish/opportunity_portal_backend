-- ops_partners.netsuite_internal_id is not the same id space as users.netsuite_internal_id
-- (NetSuite Employee). Confirmed via live incident: an Ops Partner's own login carried
-- netsuiteInternalId '10913' (their Employee record), while their own ops_partners row
-- had netsuite_internal_id '2' — so "My Open Estimates" ownership matching (which joins
-- users.netsuite_internal_id -> ops_partners.netsuite_internal_id -> estimates.ops_partner_1_id
-- / ops_partner_2_id) silently failed and always returned zero results for that partner.
--
-- This column is a separate, explicit place to store the Ops Partner's actual NetSuite
-- Employee internal id, so ownership matching can join on it instead. Left NULL here —
-- no reliable source in this database to backfill it from; populate per-partner (manually,
-- or by fixing the NetSuite sync push) before relying on it in estimate.service.ts.
ALTER TABLE ops_partners
  ADD COLUMN IF NOT EXISTS ops_partner_employee_internal_id varchar(50);
