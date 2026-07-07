-- Unified Class master table.
-- Mirrors the `classes` definition in src/db/schema/index.ts (all US + EU fields on
-- one row + syncCols). Intended to replace product_classes / product_classes_eu.
-- `is_active` is the active/inactive flag driven by the /status APIs
-- (NetSuite "Class is Inactive" checkbox, inverted).

CREATE TABLE IF NOT EXISTS classes (
  id                            serial PRIMARY KEY,
  name                          varchar(255) NOT NULL,
  parent_class                  varchar(255),
  subsidiaries                  text,
  include_children              boolean DEFAULT false,
  us_hts_code                   varchar(50),
  us_duty_rate                  numeric(10,3),
  "show"                        boolean DEFAULT false,
  eu_hts_import                 varchar(255),
  eu_hts_export                 varchar(255),
  eu_duty_rate                  numeric(10,3),
  notes                         text,
  class_planning_category       varchar(255),
  nspb_class_planning_category  varchar(255),
  china_duty_rate               numeric(10,3),
  cambodia_duty_rate            numeric(10,3),
  taiwan_duty_rate              numeric(10,3),
  thailand_duty_rate            numeric(10,3),
  vietnam_duty_rate             numeric(10,3),
  china_tariff_rate             numeric(10,3),
  hk_tariff_rate                numeric(10,3),
  taiwan_tariff_rate            numeric(10,3),
  vietnam_tariff_rate           numeric(10,3),
  cambodia_tariff_rate          numeric(10,3),
  thailand_tariff_rate          numeric(10,3),
  is_eu                         varchar(50),
  eu_hts_code                   varchar(50),
  china_duty_rate_eu            numeric(10,3),
  cambodia_duty_rate_eu         numeric(10,3),
  taiwan_duty_rate_eu           numeric(10,3),
  thailand_duty_rate_eu         numeric(10,3),
  vietnam_duty_rate_eu          numeric(10,3),
  netsuite_internal_id          varchar(50),
  is_active                     boolean NOT NULL DEFAULT true,
  source                        source NOT NULL DEFAULT 'portal',
  sync_status                   sync_status NOT NULL DEFAULT 'pending',
  sync_error                    text,
  synced_at                     timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS classes_ns_id_idx ON classes (netsuite_internal_id);
