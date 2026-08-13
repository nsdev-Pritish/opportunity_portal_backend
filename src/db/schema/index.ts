import {
  pgTable, serial, varchar, boolean, timestamp, integer,
  numeric, text, jsonb, date, index, uniqueIndex, unique, pgEnum, AnyPgColumn, uuid,
  bigserial, bigint,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ─── Enums ─────────────────────────────────────────────────────────────────

export const syncStatusEnum = pgEnum('sync_status', [
  'pending', 'synced', 'dirty', 'failed', 'skipped',
]);

export const sourceEnum = pgEnum('source', ['portal', 'netsuite']);

export const directionEnum = pgEnum('direction', ['to_netsuite', 'from_netsuite']);

export const operationEnum = pgEnum('operation', ['create', 'update', 'deactivate']);

export const estimateStatusEnum = pgEnum('estimate_status', [
  'draft', 'submitted', 'approved', 'otb', 'closed_won', 'closed_lost',
]);


export const countryOfDestEnum = pgEnum('country_of_dest', ['US', 'EU']);

// ─── Helper: standard sync columns ────────────────────────────────────────

const syncCols = {
  netsuiteInternalId: varchar('netsuite_internal_id', { length: 50 }),
  isActive: boolean('is_active').default(true).notNull(),
  source: sourceEnum('source').default('portal').notNull(),
  syncStatus: syncStatusEnum('sync_status').default('pending').notNull(),
  syncError: text('sync_error'),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
};

// ══════════════════════════════════════════════════════════════════
//  USERS
// ══════════════════════════════════════════════════════════════════

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  role: varchar('role', { length: 50 }).default('user').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  emailIdx: uniqueIndex('users_email_idx').on(t.email),
}));

// ══════════════════════════════════════════════════════════════════
//  API KEYS  — NetSuite uses these to authenticate
//  One key per environment (dev / staging / prod)
// ══════════════════════════════════════════════════════════════════

export const apiKeys = pgTable('api_keys', {
  id         : serial('id').primaryKey(),
  name       : varchar('name', { length: 100 }).notNull(),   // e.g. "NetSuite Production"
  keyHash    : varchar('key_hash', { length: 255 }).notNull(), // bcrypt hash
  keyPrefix  : varchar('key_prefix', { length: 8 }).notNull(), // first 8 chars for display
  isActive   : boolean('is_active').default(true).notNull(),
  lastUsedAt : timestamp('last_used_at', { withTimezone: true }),
  createdAt  : timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ══════════════════════════════════════════════════════════════════
//  MASTER DATA — DROPDOWN TABLES
// ══════════════════════════════════════════════════════════════════

export const subsidiaries = pgTable('subsidiaries', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 50 }),
  country: varchar('country', { length: 100 }),
  currencyId: integer('currency_id').references(() => currencies.id),
  isDefault: boolean('is_default').default(false),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('subsidiaries_ns_id_idx').on(t.netsuiteInternalId),
  codeIdx: uniqueIndex('subsidiaries_code_idx').on(t.code),
}));

// OBC POD Region — master dropdown synced from NetSuite, referenced by customers.
export const obcPodRegions = pgTable('obc_pod_regions', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('obc_pod_regions_ns_id_idx').on(t.netsuiteInternalId),
}));

// Country — master dropdown synced from NetSuite.
//   name → country name, code → ISO code (optional), netsuiteInternalId → NS internal id.
export const countries = pgTable('countries', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 10 }),   // ISO country code, e.g. "US"
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('countries_ns_id_idx').on(t.netsuiteInternalId),
}));

// State — master dropdown synced from NetSuite. Scoped to a country (country → many states).
//   name → state name, code → state code (optional), countryId → countries.id FK.
export const states = pgTable('states', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 20 }),   // state / province code, e.g. "CA"
  countryId: integer('country_id').references(() => countries.id),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('states_ns_id_idx').on(t.netsuiteInternalId),
  countryIdx: index('states_country_idx').on(t.countryId),
}));

export const customers = pgTable('customers', {
  id: serial('id').primaryKey(),
  subsidiaryId: integer('subsidiary_id').references(() => subsidiaries.id),
  name: varchar('name', { length: 255 }).notNull(),
  parentCompany: varchar('parent_company', { length: 255 }),
  salesRep: varchar('sales_rep', { length: 255 }),            // Sales Rep name (from NetSuite) — for display / fallback matching
  salesRepNsId: varchar('sales_rep_ns_id', { length: 50 }),   // Sales Rep NS internal id (as received from NetSuite)
  salesRepId: integer('sales_rep_id').references(() => accountManagers.id), // resolved local account_managers.id → drives Acct Manager
  contactName: varchar('contact_name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  terms: varchar('terms', { length: 100 }),
  chargebackRoyalties: numeric('chargeback_royalties'),
  currencyId: integer('currency_id'),
  podRegionId: integer('pod_region_id').references(() => obcPodRegions.id),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('customers_ns_id_idx').on(t.netsuiteInternalId),
  syncIdx: index('customers_sync_idx').on(t.syncStatus),
  nameIdx: index('customers_name_idx').on(t.name),
  subsidiaryIdx: index('customers_subsidiary_idx').on(t.subsidiaryId),
  podRegionIdx: index('customers_pod_region_idx').on(t.podRegionId),
  salesRepIdx: index('customers_sales_rep_idx').on(t.salesRepId),
}));

export const contacts = pgTable('contacts', {
  id: serial('id').primaryKey(),
  customerId: integer('customer_id').references(() => customers.id),
  subsidiaryId: integer('subsidiary_id').references(() => subsidiaries.id),
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  title: varchar('title', { length: 100 }),
  state: varchar('state', { length: 100 }),
  country: varchar('country', { length: 100 }),
  currencyId: integer('currency_id').references(() => currencies.id),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('contacts_ns_id_idx').on(t.netsuiteInternalId),
  customerIdx: index('contacts_customer_idx').on(t.customerId),
  subsidiaryIdx: index('contacts_subsidiary_idx').on(t.subsidiaryId),
}));

export const addresses = pgTable('addresses', {
  id: serial('id').primaryKey(),
  customerId: integer('customer_id').references(() => customers.id),
  type: varchar('type', { length: 20 }).default('shipping'), // 'shipping' | 'billing'
  label: varchar('label', { length: 100 }),
  companyName: varchar('company_name', { length: 255 }),   // Company / Customer Account
  attention: varchar('attention', { length: 255 }),
  addressee: varchar('addressee', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  addrLine1: varchar('addr_line1', { length: 255 }),
  addrLine2: varchar('addr_line2', { length: 255 }),
  city: varchar('city', { length: 100 }),
  // Free-text country/state — kept for display and NetSuite sync (populated from the FK ids below).
  state: varchar('state', { length: 100 }),
  country: varchar('country', { length: 100 }),
  // FK links to the country/state master dropdowns (state depends on the selected country).
  countryId: integer('country_id').references(() => countries.id),
  stateId: integer('state_id').references(() => states.id),
  postalCode: varchar('postal_code', { length: 20 }),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('addresses_ns_id_idx').on(t.netsuiteInternalId),
  customerIdx: index('addresses_customer_idx').on(t.customerId),
  typeIdx: index('addresses_type_idx').on(t.type),
  countryIdx: index('addresses_country_idx').on(t.countryId),
  stateIdx: index('addresses_state_idx').on(t.stateId),
}));

export const currencies = pgTable('currencies', {
  id: serial('id').primaryKey(),
  code: varchar('code', { length: 3 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  symbol: varchar('symbol', { length: 10 }),
  exchangeRate: numeric('exchange_rate', { precision: 12, scale: 6 }).default('1'),
  ...syncCols,
});

export const projectNames = pgTable('project_names', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  projectTypeId: integer('project_type_id').references(() => projectTypes.id),
  customerId: integer('customer_id').references(() => customers.id),
  description: text('description'),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('project_names_ns_id_idx').on(t.netsuiteInternalId),
  customerIdx: index('project_names_customer_idx').on(t.customerId),
  projectTypeIdx: index('project_names_project_type_idx').on(t.projectTypeId),
}));

export const projectTypes = pgTable('project_types', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('project_types_ns_id_idx').on(t.netsuiteInternalId),
}));

export const likelyToClose = pgTable('likely_to_close', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  ...syncCols,
});

export const departments = pgTable('departments', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  deptShow: boolean('dept_show').notNull().default(true),
  ...syncCols,
});

export const salesChannels = pgTable('sales_channels', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
});

export const businessVerticals = pgTable('business_verticals', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
});

export const businessTypes = pgTable('business_types', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
});

export const employees = pgTable('employees', {
  id: serial('id').primaryKey(),
  employeeId: varchar('employee_id', { length: 100 }),     // NetSuite "Employee ID" (entityId), distinct from internal id
  firstName: varchar('first_name', { length: 100 }),       // legacy — kept for backward compatibility
  lastName: varchar('last_name', { length: 100 }),         // legacy — kept for backward compatibility
  name: varchar('name', { length: 255 }),                  // full display name
  jobTitle: varchar('job_title', { length: 255 }),
  developer: boolean('developer').default(false).notNull(),
  salesRep: boolean('sales_rep').default(false).notNull(),
  productDeveloper: boolean('product_developer').default(false).notNull(),
  email: varchar('email', { length: 255 }),
  currencyId: integer('currency_id').references(() => currencies.id),
  subsidiaryId: integer('subsidiary_id').references(() => subsidiaries.id),
  departmentId: integer('department_id').references(() => departments.id),
  roles: jsonb('roles').$type<string[]>().default([]),     // legacy — kept for backward compatibility
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('employees_ns_id_idx').on(t.netsuiteInternalId),
  subsidiaryIdx: index('employees_subsidiary_idx').on(t.subsidiaryId),
  departmentIdx: index('employees_department_idx').on(t.departmentId),
}));

// ─── "List" master dropdowns (NetSuite custom lists) ───────────────
export const quarters = pgTable('quarters', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('quarters_ns_id_idx').on(t.netsuiteInternalId),
}));

export const forecastStatuses = pgTable('forecast_statuses', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('forecast_statuses_ns_id_idx').on(t.netsuiteInternalId),
}));

export const hkPartners = pgTable('hk_partners', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
});

export const opsPartners = pgTable('ops_partners', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
});

export const compliancePartners = pgTable('compliance_partners', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
});

export const accountManagers = pgTable('account_managers', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
});

// ES Status — master dropdown. `isActive` (from syncCols) is the active/inactive flag.
export const esStatus = pgTable('es_status', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,   // provides netsuite_internal_id, is_active, source, sync_* , timestamps
}, (t) => ({
  nsIdIdx: uniqueIndex('es_status_ns_id_idx').on(t.netsuiteInternalId),
}));

export const productDevelopers = pgTable('product_developers', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
});

export const clientIncoterms = pgTable('client_incoterms', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
});

export const clientShippingMethods = pgTable('client_shipping_methods', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
});

// Aliases used by the netsuite sync routes — point to the same underlying tables
export const incoterms = clientIncoterms;
export const shippingMethods = clientShippingMethods;

export const vendors = pgTable('vendors', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 255 }),
  country: varchar('country', { length: 100 }),
  subsidiaryId: integer('subsidiary_id').references(() => subsidiaries.id),
  defaultCurrencyId: integer('default_currency_id').references(() => currencies.id),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('vendors_ns_id_idx').on(t.netsuiteInternalId),
  subsidiaryIdx: index('vendors_subsidiary_idx').on(t.subsidiaryId),
}));

export const vendorAddresses = pgTable('vendor_addresses', {
  id: serial('id').primaryKey(),
  vendorId: integer('vendor_id').references(() => vendors.id).notNull(),
  attention: varchar('attention', { length: 255 }),
  addressee: varchar('addressee', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  addrLine1: varchar('addr_line1', { length: 255 }),
  addrLine2: varchar('addr_line2', { length: 255 }),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 100 }),
  zip: varchar('zip', { length: 20 }),
  country: varchar('country', { length: 100 }),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('vendor_addresses_ns_id_idx').on(t.netsuiteInternalId),
  vendorIdx: index('vendor_addresses_vendor_idx').on(t.vendorId),
}));

export const vendorIncoterms = pgTable('vendor_incoterms', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('vendor_incoterms_ns_id_idx').on(t.netsuiteInternalId),
}));

export const csItems = pgTable('cs_items', {
  id: serial('id').primaryKey(),
  itemName: varchar('item_name', { length: 255 }).notNull(),
  subsidiaryId: integer('subsidiary_id').references(() => subsidiaries.id),
  isFeeItem: boolean('is_fee_item').default(false).notNull(),
  currencyId: integer('currency_id').references(() => currencies.id),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('cs_items_ns_id_idx').on(t.netsuiteInternalId),
  subsidiaryIdx: index('cs_items_subsidiary_idx').on(t.subsidiaryId),
}));

export const factories = pgTable('factories', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  country: varchar('country', { length: 100 }),
  vendorId: integer('vendor_id').references(() => vendors.id),
  ...syncCols,
});

export const itemTypes = pgTable('item_types', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  requiresHts: boolean('requires_hts').default(false),
  ...syncCols,
});

export const productClasses = pgTable('product_classes', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  parentClass: varchar('parent_class', { length: 255 }),
  classCode: varchar('class_code', { length: 255 }),
  usHtsCode: varchar('us_hts_code', { length: 50 }),
  chinaDutyRate: numeric('china_duty_rate', { precision: 10, scale: 3 }),
  cambodiaDutyRate: numeric('cambodia_duty_rate', { precision: 10, scale: 3 }),
  taiwanDutyRate: numeric('taiwan_duty_rate', { precision: 10, scale: 3 }),
  thailandDutyRate: numeric('thailand_duty_rate', { precision: 10, scale: 3 }),
  vietnamDutyRate: numeric('vietnam_duty_rate', { precision: 10, scale: 3 }),
  chinaTariffRate: numeric('china_tariff_rate', { precision: 10, scale: 3 }),
  hkTariffRate: numeric('hk_tariff_rate', { precision: 10, scale: 3 }),
  taiwanTariffRate: numeric('taiwan_tariff_rate', { precision: 10, scale: 3 }),
  vietnamTariffRate: numeric('vietnam_tariff_rate', { precision: 10, scale: 3 }),
  cambodiaTariffRate: numeric('cambodia_tariff_rate', { precision: 10, scale: 3 }),
  thailandTariffRate: numeric('thailand_tariff_rate', { precision: 10, scale: 3 }),
  ...syncCols,
});

export const productClassesEu = pgTable('product_classes_eu', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  parentClass: varchar('parent_class', { length: 255 }),
  classCode: varchar('class_code', { length: 255 }),
  euHtsCode: varchar('eu_hts_code', { length: 50 }),
  chinaDutyRate: numeric('china_duty_rate', { precision: 10, scale: 3 }),
  cambodiaDutyRate: numeric('cambodia_duty_rate', { precision: 10, scale: 3 }),
  taiwanDutyRate: numeric('taiwan_duty_rate', { precision: 10, scale: 3 }),
  thailandDutyRate: numeric('thailand_duty_rate', { precision: 10, scale: 3 }),
  vietnamDutyRate: numeric('vietnam_duty_rate', { precision: 10, scale: 3 }),
  ...syncCols,
});

// Unified Class master — mirrors the NetSuite "Class" record (holds both the US
// and EU fields on a single row). Intended to replace productClasses + productClassesEu.
export const classes = pgTable('classes', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  parentClass: varchar('parent_class', { length: 255 }),
  subsidiaries: text('subsidiaries'),
  includeChildren: boolean('include_children').default(false),
  usHtsCode: varchar('us_hts_code', { length: 50 }),
  usDutyRate: numeric('us_duty_rate', { precision: 10, scale: 3 }),
  show: boolean('show').default(false),
  euHtsImport: varchar('eu_hts_import', { length: 255 }),
  euHtsExport: varchar('eu_hts_export', { length: 255 }),
  euDutyRate: numeric('eu_duty_rate', { precision: 10, scale: 3 }),
  notes: text('notes'),
  classPlanningCategory: varchar('class_planning_category', { length: 255 }),
  nspbClassPlanningCategory: varchar('nspb_class_planning_category', { length: 255 }),
  chinaDutyRate: numeric('china_duty_rate', { precision: 10, scale: 3 }),
  cambodiaDutyRate: numeric('cambodia_duty_rate', { precision: 10, scale: 3 }),
  taiwanDutyRate: numeric('taiwan_duty_rate', { precision: 10, scale: 3 }),
  thailandDutyRate: numeric('thailand_duty_rate', { precision: 10, scale: 3 }),
  vietnamDutyRate: numeric('vietnam_duty_rate', { precision: 10, scale: 3 }),
  chinaTariffRate: numeric('china_tariff_rate', { precision: 10, scale: 3 }),
  hkTariffRate: numeric('hk_tariff_rate', { precision: 10, scale: 3 }),
  taiwanTariffRate: numeric('taiwan_tariff_rate', { precision: 10, scale: 3 }),
  vietnamTariffRate: numeric('vietnam_tariff_rate', { precision: 10, scale: 3 }),
  cambodiaTariffRate: numeric('cambodia_tariff_rate', { precision: 10, scale: 3 }),
  thailandTariffRate: numeric('thailand_tariff_rate', { precision: 10, scale: 3 }),
  isEu: varchar('is_eu', { length: 50 }),
  euHtsCode: varchar('eu_hts_code', { length: 50 }),
  chinaDutyRateEu: numeric('china_duty_rate_eu', { precision: 10, scale: 3 }),
  cambodiaDutyRateEu: numeric('cambodia_duty_rate_eu', { precision: 10, scale: 3 }),
  taiwanDutyRateEu: numeric('taiwan_duty_rate_eu', { precision: 10, scale: 3 }),
  thailandDutyRateEu: numeric('thailand_duty_rate_eu', { precision: 10, scale: 3 }),
  vietnamDutyRateEu: numeric('vietnam_duty_rate_eu', { precision: 10, scale: 3 }),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('classes_ns_id_idx').on(t.netsuiteInternalId),
}));

export const sustainabilityOptions = pgTable('sustainability_options', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
});

export const componentKitItems = pgTable('component_kit_items', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
});

export const closedLostReasons = pgTable('closed_lost_reasons', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('closed_lost_reasons_ns_id_idx').on(t.netsuiteInternalId),
}));

export const clientPursuitAlternatives = pgTable('client_pursuit_alternatives', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('client_pursuit_alternatives_ns_id_idx').on(t.netsuiteInternalId),
}));

export const estimateStatuses = pgTable('estimate_statuses', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  stage: varchar('stage', { length: 255 }),
  probability: numeric('probability', { precision: 5, scale: 2 }),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('estimate_statuses_ns_id_idx').on(t.netsuiteInternalId),
}));

export const shippingGroups = pgTable('shipping_groups', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  volumetricDivisor: numeric('volumetric_divisor', { precision: 10, scale: 2 }).default('5000'),
  ...syncCols,
});

// ══════════════════════════════════════════════════════════════════
//  FREIGHT COST RATES
// ══════════════════════════════════════════════════════════════════

export const lclRates = pgTable('lcl_rates', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  pol: varchar('pol', { length: 255 }),
  pod: varchar('pod', { length: 255 }),
  pricePerCbm: numeric('price_per_cbm', { precision: 15, scale: 4 }),
  minFlatRate: numeric('min_flat_rate', { precision: 15, scale: 4 }),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('lcl_rates_ns_id_idx').on(t.netsuiteInternalId),
}));

export const fclRates = pgTable('fcl_rates', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  pol: varchar('pol', { length: 255 }),
  pod: varchar('pod', { length: 255 }),
  container20: numeric('container20', { precision: 15, scale: 4 }),
  container40: numeric('container40', { precision: 15, scale: 4 }),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('fcl_rates_ns_id_idx').on(t.netsuiteInternalId),
}));

export const airRates = pgTable('air_rates', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  pol: varchar('pol', { length: 255 }),
  pod: varchar('pod', { length: 255 }),
  pricePerKg: numeric('price_per_kg', { precision: 15, scale: 4 }),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('air_rates_ns_id_idx').on(t.netsuiteInternalId),
}));

// Drayage — master dropdown synced from NetSuite custom record `customrecord_fcldrayage`.
// Referenced by estimate_freight_groups (freight group → one drayage).
//   name    → Name
//   netsuiteInternalId (from syncCols) → recordid (NetSuite ID)
//   isActive (from syncCols) → inverse of NetSuite `isinactive`
export const drayage = pgTable('drayage', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),           // Name
  city: varchar('city', { length: 255 }),                     // custrecord_fcldrayage_city
  state: varchar('state', { length: 255 }),                   // custrecord_fcldrayage_state
  zipCode: varchar('zip_code', { length: 20 }),               // custrecord_fcldrayage_zipcode
  port: varchar('port', { length: 255 }),                     // custrecord_fcldrayage_port
  total: numeric('total', { precision: 15, scale: 4 }),       // custrecord_fcldrayage_total
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('drayage_ns_id_idx').on(t.netsuiteInternalId),
}));

export const additionalFees = pgTable('additional_fees', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  freightType: varchar('freight_type', { length: 100 }),
  docFee: numeric('doc_fee', { precision: 15, scale: 4 }),
  amsFee: numeric('ams_fee', { precision: 15, scale: 4 }),
  deConsolFee: numeric('de_consol_fee', { precision: 15, scale: 4 }),
  ddsisFee: numeric('ddsis_fee', { precision: 15, scale: 4 }),
  fceFee: numeric('fce_fee', { precision: 15, scale: 4 }),
  pierPass: numeric('pier_pass', { precision: 15, scale: 4 }),
  handlingFee: numeric('handling_fee', { precision: 15, scale: 4 }),
  isfFiling: numeric('isf_filing', { precision: 15, scale: 4 }),
  entryFee: numeric('entry_fee', { precision: 15, scale: 4 }),
  palletSurcharge: numeric('pallet_surcharge', { precision: 15, scale: 4 }),
  carrierImportFee: numeric('carrier_import_fee', { precision: 15, scale: 4 }),
  addFeeTotal: numeric('add_fee_total', { precision: 15, scale: 4 }),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('additional_fees_ns_id_idx').on(t.netsuiteInternalId),
}));

// ══════════════════════════════════════════════════════════════════
//  ESTIMATES (OPPORTUNITY HEADER)
// ══════════════════════════════════════════════════════════════════

export const estimates = pgTable('estimates', {
  id: serial('id').primaryKey(),
  netsuiteInternalId: varchar('netsuite_internal_id', { length: 50 }).unique(),
  documentNumber: varchar('document_number', { length: 100 }),  // NS transaction ID (e.g. "EST-0042")

  // Primary Information
  subsidiaryId: integer('subsidiary_id').references(() => subsidiaries.id),
  customerId: integer('customer_id').references(() => customers.id).notNull(),
  customerContactId: integer('customer_contact_id').references(() => contacts.id),
  customerPo: varchar('customer_po', { length: 100 }),
  projectNameId: integer('project_name_id').references(() => projectNames.id),
  projectName: varchar('project_name', { length: 255 }),
  projectTypeId: integer('project_type_id').references(() => projectTypes.id),
  trandate: date('trandate'),  // NetSuite transaction date. Inbound: set from NS `trandate` key. Outbound: sent as created_at.
  expectedCloseDate: date('expected_close_date'),
  promiseDate: date('promise_date'),
  likelyToCloseId: integer('likely_to_close_id').references(() => likelyToClose.id),
  sellCurrencyId: integer('sell_currency_id').references(() => currencies.id),
  projectedTotalAmt: numeric('projected_total_amt', { precision: 15, scale: 2 }),
  estimatedQty: integer('estimated_qty'),
  adjustedPipeline: numeric('adjusted_pipeline', { precision: 15, scale: 2 }), // NetSuite currency field: adjustedPipelineAmountNS

  // Classification
  departmentId: integer('department_id').references(() => departments.id),
  salesChannelId: integer('sales_channel_id').references(() => salesChannels.id),
  businessVerticalId: integer('business_vertical_id').references(() => businessVerticals.id),
  businessTypeId: integer('business_type_id').references(() => businessTypes.id),
  compliancePartnerId: integer('compliance_partner_id').references(() => compliancePartners.id),
  acctManagerId: integer('acct_manager_id').references(() => accountManagers.id),
  productDeveloperIds: integer('product_developer_ids').array().default([]),
  hkPartnerId: integer('hk_partner_id').references(() => hkPartners.id),
  opsPartner1Id: integer('ops_partner_1_id').references(() => opsPartners.id),
  opsPartner2Id: integer('ops_partner_2_id').references(() => opsPartners.id),
  deckRequest: boolean('deck_request').default(false),
  artSetupRequest: boolean('art_setup_request').default(false),
  pkgDeckRequest: boolean('pkg_deck_request').default(false),
  pkgArtSetupRequest: boolean('pkg_art_setup_request').default(false),

  // Client Shipping & Billing
  shippingAddressId: integer('shipping_address_id').references(() => addresses.id),
  shipTo: text('ship_to'),
  billingAddressId: integer('billing_address_id').references(() => addresses.id),
  billTo: text('bill_to'),
  clientIncotermsId: integer('client_incoterms_id').references(() => clientIncoterms.id),
  clientShipMethodId: integer('client_ship_method_id').references(() => clientShippingMethods.id),

  // Edit / Update fields
  statusId: integer('status_id').references(() => estimateStatuses.id),
  esStatusId: integer('es_status_id').references(() => esStatus.id),
  closedLostReasonId: integer('closed_lost_reason_id').references(() => closedLostReasons.id),
  clientPursuitAlternativeId: integer('client_pursuit_alternative_id').references(() => clientPursuitAlternatives.id),
  projectHoldDate: date('project_hold_date'),
  notesClosedLostReason: text('notes_closed_lost_reason'),

  // OTB conversion
  otbConvertedAt: timestamp('otb_converted_at', { withTimezone: true }),

  // Additional
  sampleOnlyOrder: boolean('sample_only_order').default(false),
  reOrder: boolean('re_order').default(false),
  bibleLink: varchar('bible_link', { length: 1000 }),
  memo: text('memo'),
  attachments: jsonb('attachments').$type<Array<{ name: string; url: string; size: number; type: string }>>().default([]),

  // Twelve Pays flags — 'YES' | 'NO' (NULL when unset). Sync to NetSuite custom body fields:
  //   twelvePaysImportFrt  → custbody_twelve_pays_import_frt   (Twelve Pays Import FRT/Duty)
  //   twelvePaysShipToCust → custbody_twelve_pays_ship_to_cust (Twelve Pays Shipping to Customer)
  twelvePaysImportFrt: varchar('twelve_pays_import_frt', { length: 3 }),
  twelvePaysShipToCust: varchar('twelve_pays_ship_to_cust', { length: 3 }),

  // Status & Sync
  status: estimateStatusEnum('status').default('draft').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  source: sourceEnum('source').default('portal').notNull(),
  syncStatus: syncStatusEnum('sync_status').default('pending').notNull(),
  syncError: text('sync_error'),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
  createdBy: integer('created_by').references(() => users.id),
  updatedBy: integer('updated_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  nsIdIdx: uniqueIndex('estimates_ns_id_idx').on(t.netsuiteInternalId),
  customerIdx: index('estimates_customer_idx').on(t.customerId),
  syncIdx: index('estimates_sync_idx').on(t.syncStatus),
  updatedIdx: index('estimates_updated_idx').on(t.updatedAt),
  statusIdx: index('estimates_status_idx').on(t.status),
}));

// ══════════════════════════════════════════════════════════════════
//  ESTIMATE QUOTES (one per OTB conversion)
// ══════════════════════════════════════════════════════════════════

export const estimateQuotes = pgTable('estimate_quotes', {
  id                     : serial('id').primaryKey(),
  estimateId             : integer('estimate_id').references(() => estimates.id, { onDelete: 'cascade' }).notNull(),
  quoteNetsuiteInternalId: varchar('quote_netsuite_internal_id', { length: 50 }),
  quoteDocumentNumber    : varchar('quote_document_number', { length: 100 }),
  status                 : varchar('status', { length: 20 }).default('active').notNull(), // 'active' | 'replaced'
  syncStatus             : syncStatusEnum('sync_status').default('pending').notNull(),
  syncError              : text('sync_error'),
  syncedAt               : timestamp('synced_at', { withTimezone: true }),
  createdAt              : timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt              : timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  estimateIdx: index('eq_estimate_idx').on(t.estimateId),
}));

// ══════════════════════════════════════════════════════════════════
//  ESTIMATE LINE ITEMS (COST SHEET)
// ══════════════════════════════════════════════════════════════════

export const estimateLineItems = pgTable('estimate_line_items', {
  id: serial('id').primaryKey(),
  netsuiteInternalId: varchar('netsuite_internal_id', { length: 50 }).unique(),
  estimateId: integer('estimate_id').references(() => estimates.id, { onDelete: 'cascade' }).notNull(),
  lineNumber: integer('line_number').notNull(),

  // Line Header
  itemTypeId: integer('item_type_id').references(() => csItems.id),
  shortDescription: varchar('short_description', { length: 500 }),
  color: varchar('color', { length: 20 }),  // hex color e.g. "#FFAA00", stored when saving the item
  vendorId: integer('vendor_id').references(() => vendors.id),
  quantity: numeric('quantity', { precision: 12, scale: 4 }).default('0'),
  sellPricePerUnit: numeric('sell_price_per_unit', { precision: 15, scale: 4 }).default('0'),
  skuMarginPct: numeric('sku_margin_pct', { precision: 10, scale: 3 }).default('0'),
  salesAmount: numeric('sales_amount', { precision: 15, scale: 2 }),
  pickupExwFob: numeric('pickup_exw_fob', { precision: 15, scale: 2 }),
  oceanDdp: numeric('ocean_ddp', { precision: 15, scale: 2 }),
  airDdp: numeric('air_ddp', { precision: 15, scale: 2 }),
  exclude: boolean('exclude').default(false),

  // Purchase Information
  image: jsonb('image').$type<{ name: string; url: string; size: number; type: string }>(),
  description: text('description'),
  factoryId: integer('factory_id').references(() => factories.id),
  vendorCurrencyId: integer('vendor_currency_id').references(() => currencies.id),
  factoryCostPerUnit: numeric('factory_cost_per_unit', { precision: 15, scale: 4 }).default('0'),
  packingCostPerUnit: numeric('packing_cost_per_unit', { precision: 15, scale: 4 }).default('0'),
  sampleFees: numeric('sample_fees', { precision: 15, scale: 2 }).default('0'),
  otherPerUnit: numeric('other_per_unit', { precision: 15, scale: 4 }).default('0'),

  // Landed Cost
  freightPerUnit: numeric('freight_per_unit', { precision: 15, scale: 4 }).default('0'),
  dutyPct: numeric('duty_pct', { precision: 10, scale: 3 }).default('0'),
  tariffPct: numeric('tariff_pct', { precision: 10, scale: 3 }).default('10'),
  tariffMuPct: numeric('tariff_mu_pct', { precision: 10, scale: 3 }).default('0'),
  otherCostPct: numeric('other_cost_pct', { precision: 10, scale: 3 }).default('0'),
  paddingPct: numeric('padding_pct', { precision: 10, scale: 3 }).default('0'),
  usdFactoryCost: numeric('usd_factory_cost', { precision: 15, scale: 4 }),
  landedCostPerUnit: numeric('landed_cost_per_unit', { precision: 15, scale: 4 }),
  extendedLandedCost: numeric('extended_landed_cost', { precision: 15, scale: 2 }),

  // Classification
  productClassId: integer('product_class_id').references(() => productClasses.id),
  sustainabilityId: integer('sustainability_id').references(() => sustainabilityOptions.id),
  productClassEuId: integer('product_class_eu_id').references(() => productClassesEu.id),
  classId: integer('class_id').references(() => classes.id),
  componentKitItemId: integer('component_kit_item_id').references(() => componentKitItems.id),
  htsCode: varchar('hts_code', { length: 20 }),
  countryOfOrigin: varchar('country_of_origin', { length: 100 }),
  countryOfDest: countryOfDestEnum('country_of_dest').default('US'),

  // Packing Details
  unitsPerCarton: integer('units_per_carton'),
  dimLCm: numeric('dim_l_cm', { precision: 10, scale: 2 }),
  dimWCm: numeric('dim_w_cm', { precision: 10, scale: 2 }),
  dimHCm: numeric('dim_h_cm', { precision: 10, scale: 2 }),
  weightKgPerCarton: numeric('weight_kg_per_carton', { precision: 10, scale: 3 }),
  cbmPerCarton: numeric('cbm_per_carton', { precision: 10, scale: 5 }),
  totalCartons: integer('total_cartons').default(0),
  totalCbm: numeric('total_cbm', { precision: 10, scale: 3 }),
  chargeableWeightKg: numeric('chargeable_weight_kg', { precision: 10, scale: 3 }),
  shippingGroupId: varchar('shipping_group_id', { length: 255 }),

  // Other Details (Vendor)
  exFactoryDate: date('ex_factory_date'),
  vendorIncotermsId: integer('vendor_incoterms_id').references(() => vendorIncoterms.id),
  shipToVendorId: integer('ship_to_vendor_id').references(() => vendors.id),
  shipToVendorAddrId: integer('ship_to_vendor_addr_id').references(() => vendorAddresses.id),
  notes: text('notes'),

  // Extended Line Fields
  selected:           boolean('selected').default(true).notNull(),
  lineComponents:       text('line_components'),
  previousLineId:       integer('previous_line_id'),
  additionalFeeInfo:    text('additional_fee_info'),
  countryOrigin:        varchar('country_origin', { length: 100 }),
  itemClass:            varchar('item_class', { length: 255 }),
  classItem:            varchar('class_item', { length: 255 }),
  vendorSku:            varchar('vendor_sku', { length: 255 }),
  shippingInstruction:  text('shipping_instruction'),
  paddingAmount:        numeric('padding_amount',        { precision: 15, scale: 4 }),
  dutyMarkupAmount:     numeric('duty_markup_amount',    { precision: 15, scale: 4 }),
  converted:            boolean('converted').default(false),
  // Line-level freight mode selection (free-form text, e.g. "FOB", "Ocean", "Air", "Group").
  freightModeSelection: varchar('freight_mode_selection', { length: 20 }),
  // Line-level true tariff (free-form text). Synced to NetSuite as `trueTariffRateNS`.
  trueTariff:           varchar('true_tariff', { length: 255 }),
  freightSelectedGroup: varchar('freight_selected_group', { length: 255 }),
  freightPol:           varchar('freight_pol', { length: 255 }),
  freightPod:           varchar('freight_pod', { length: 255 }),
  totalFreightCost:     numeric('total_freight_cost',    { precision: 15, scale: 4 }),
  freightCostPerUnit:   numeric('freight_cost_per_unit', { precision: 15, scale: 4 }),
  freightProvider:      varchar('freight_provider', { length: 255 }),
  freightNotes:         text('freight_notes'),
  excludeFromPrint:     boolean('exclude_from_print').default(false),

  // Freight: back-reference to the freight group this line belongs to (group → many lines,
  // line → one group). All active freight logic now lives on estimate_freight_groups; the
  // legacy freight_* columns above are retained for backward compatibility but no longer used.
  freightGroupId: integer('freight_group_id').references((): AnyPgColumn => estimateFreightGroups.id, { onDelete: 'set null' }),

  // Soft delete: false = "deleted" (hidden from reads, row retained for NetSuite deactivation)
  isActive:             boolean('is_active').default(true).notNull(),

  // Parent–child relationship (Quote Kit Item → Component Kit Items)
  parentLineItemId: integer('parent_line_item_id').references((): AnyPgColumn => estimateLineItems.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull().default(0),

  // Sync
  syncStatus: syncStatusEnum('sync_status').default('pending').notNull(),
  syncError: text('sync_error'),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  estimateIdx: index('eli_estimate_idx').on(t.estimateId),
  syncIdx: index('eli_sync_idx').on(t.syncStatus),
  vendorIdx: index('eli_vendor_idx').on(t.vendorId),
  // Partial: only active rows must have a unique line number. Soft-deleted rows keep
  // their old line_number but are excluded so a re-inserted active row can reuse it.
  lineNumberIdx: uniqueIndex('eli_line_number_idx').on(t.estimateId, t.lineNumber).where(sql`${t.isActive} = true`),
  parentIdx: index('eli_parent_idx').on(t.parentLineItemId),
}));

// ══════════════════════════════════════════════════════════════════
//  ESTIMATE FREIGHT GROUPS (per-estimate shipping group selections)
// ══════════════════════════════════════════════════════════════════

export const estimateFreightGroups = pgTable('estimate_freight_groups', {
  id: serial('id').primaryKey(),
  estimateId: integer('estimate_id').references(() => estimates.id, { onDelete: 'cascade' }).notNull(),
  groupName: varchar('group_name', { length: 255 }).notNull().default('Group 1'),

  // Freight Mode Selected for this group (OCEAN_LCL | OCEAN_FCL | AIR | CUSTOM)
  freightModeSelected: varchar('freight_mode_selected', { length: 20 }),

  // Drayage selected for this group → drayage master dropdown.
  drayageId: integer('drayage_id').references(() => drayage.id, { onDelete: 'set null' }),

  // Membership: ids of the estimate_line_items belonging to this group.
  itemIds: jsonb('item_ids').$type<number[]>().default([]),

  // Aggregated metrics across the group's line items
  numItems: integer('num_items').default(0),
  totalCartons: integer('total_cartons').default(0),
  totalCbm: numeric('total_cbm', { precision: 10, scale: 3 }),
  totalWeight: numeric('total_weight', { precision: 10, scale: 3 }),

  // Ocean LCL
  oceanLclTotal:   numeric('ocean_lcl_total',    { precision: 15, scale: 4 }),
  oceanLclPerUnit: numeric('ocean_lcl_per_unit', { precision: 15, scale: 4 }),
  oceanLclPol:     varchar('ocean_lcl_pol', { length: 255 }),
  oceanLclPod:     varchar('ocean_lcl_pod', { length: 255 }),

  // Ocean FCL
  oceanFclTotal:   numeric('ocean_fcl_total',    { precision: 15, scale: 4 }),
  oceanFclPerUnit: numeric('ocean_fcl_per_unit', { precision: 15, scale: 4 }),
  oceanFclPol:     varchar('ocean_fcl_pol', { length: 255 }),
  oceanFclPod:     varchar('ocean_fcl_pod', { length: 255 }),

  // Air
  airTotal:   numeric('air_total',    { precision: 15, scale: 4 }),
  airPerUnit: numeric('air_per_unit', { precision: 15, scale: 4 }),
  airPol:     varchar('air_pol', { length: 255 }),
  airPod:     varchar('air_pod', { length: 255 }),

  // Custom provider
  customTotal:    numeric('custom_total',    { precision: 15, scale: 4 }),
  customPerUnit:  numeric('custom_per_unit', { precision: 15, scale: 4 }),
  customProvider: varchar('custom_provider', { length: 255 }),
  customNotes:    text('custom_notes'),

  // Sync — mirrors the parent estimate's NetSuite outcome so the UI can show the
  // sync state (and any error) per freight group. Written by netsuiteSync.service.
  syncStatus: syncStatusEnum('sync_status').default('pending').notNull(),
  syncError:  text('sync_error'),
  syncedAt:   timestamp('synced_at', { withTimezone: true }),

  // Soft-delete flag. On an update where fewer groups are sent than exist, the surplus
  // groups are deactivated (is_active=false) rather than hard-deleted, so their row id
  // survives. All read paths filter on is_active=true.
  isActive: boolean('is_active').default(true).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // NOTE: the old chosen_type, sort_order and rate-ref columns from the original
  // estimate_freight_groups table still exist physically in the DB but are intentionally
  // not mapped here — they are unused by the current freight-group model.
}, (t) => ({
  estimateIdx: index('efg_estimate_idx').on(t.estimateId),
  drayageIdx: index('efg_drayage_idx').on(t.drayageId),
}));

// ══════════════════════════════════════════════════════════════════
//  ESTIMATE + QUOTE SAVED SEARCH (mirror of the NetSuite saved search)
//  One row per estimate/quote record returned by the NS saved search.
//  Columns that map to a master table store the FK id (not the text);
//  the text is resolvable by joining to that master table.
//  Populated in future by a NetSuite sync; for now just the structure.
// ══════════════════════════════════════════════════════════════════

export const estimateQuoteSearch = pgTable('estimate_quote_search', {
  id: serial('id').primaryKey(),

  // Document Number — plain text from NS (e.g. "EST0008946")
  documentNumber: varchar('document_number', { length: 100 }),

  // Department → departments
  departmentId: integer('department_id').references(() => departments.id),

  // Customer hierarchy → customers (Name / Top Level Parent are FK; Consolidated Customer is free text)
  customerId: integer('customer_id').references(() => customers.id),
  consolidatedCustomer: varchar('consolidated_customer', { length: 255 }), // free text (was FK → customers)
  topLevelParentId: integer('top_level_parent_id').references(() => customers.id),

  // Status — free text (was FK → estimate_statuses)
  status: varchar('status', { length: 255 }),

  // Dates
  tranDate: date('tran_date'),                          // "Date"
  expectedCloseDate: date('expected_close_date'),       // "Expected Close"
  promisedDeliveryDate: date('promised_delivery_date'), // "Promised Delivery Date"

  // Amounts
  projectedTotal: numeric('projected_total'),
  exchangeRate: numeric('exchange_rate'),
  // Foreign Amount — native transaction-currency amount, as sent by NetSuite.
  // Falls back to a derived value (projectedTotal ÷ exchangeRate) in the
  // snapshot builder when NetSuite hasn't populated this yet.
  foreignAmount: numeric('foreign_amount'),

  // Currency → currencies
  currencyId: integer('currency_id').references(() => currencies.id),

  // Subsidiary → subsidiaries
  subsidiaryId: integer('subsidiary_id').references(() => subsidiaries.id),

  // Project Name → project_names
  projectNameId: integer('project_name_id').references(() => projectNames.id),

  // Business Vertical → business_verticals
  businessVerticalId: integer('business_vertical_id').references(() => businessVerticals.id),

  // Sales Rep → account_managers (same mapping the estimates table uses; employees is empty)
  salesRepId: integer('sales_rep_id').references(() => accountManagers.id),

  // Likely To Close → likely_to_close
  likelyToCloseId: integer('likely_to_close_id').references(() => likelyToClose.id),

  // ── Line item fields (Gina Chang, "column add pipeline and so") ──────────
  lineUniqueKey: varchar('line_unique_key', { length: 50 }),
  lineNumber: integer('line_number'),
  createdFromDirect: varchar('created_from_direct', { length: 255 }),
  itemId: integer('item_id').references(() => csItems.id),
  itemName: varchar('item_name', { length: 255 }),
  itemType: varchar('item_type', { length: 100 }),
  quantity: numeric('quantity'),
  quantityBackOrdered: numeric('quantity_back_ordered'),
  unitSalesPrice: numeric('unit_sales_price'),
  lineAmount: numeric('line_amount'),
  shortDescription: varchar('short_description', { length: 500 }),
  vendorCurrency: varchar('vendor_currency', { length: 100 }),
  description: text('description'),
  lineProjectId: integer('line_project_id').references(() => projectNames.id),
  lineProjectTypeId: integer('line_project_type_id').references(() => projectTypes.id),

  ...syncCols, // netsuiteInternalId ("Internal ID"), source, syncStatus, timestamps, …
}, (t) => ({
  nsIdIdx:     uniqueIndex('eqs_ns_id_idx').on(t.netsuiteInternalId),
  syncIdx:     index('eqs_sync_idx').on(t.syncStatus),
  customerIdx: index('eqs_customer_idx').on(t.customerId),
  statusIdx:   index('eqs_status_idx').on(t.status),
  docNumIdx:   index('eqs_doc_num_idx').on(t.documentNumber),
}));

// ══════════════════════════════════════════════════════════════════
//  SALES ORDER SAVED SEARCH (mirror of the NetSuite saved search)
//  Same column set as estimate_quote_search; FK ids for mastered columns.
// ══════════════════════════════════════════════════════════════════

export const salesOrderSearch = pgTable('sales_order_search', {
  id: serial('id').primaryKey(),

  documentNumber: varchar('document_number', { length: 100 }),

  // Created From — the source transaction this SO was created from, as plain
  // text (e.g. the Estimate's document number "EST0008946"). Free text, not a
  // FK: it's the lifecycle link key the snapshot engine resolves anchor_id from.
  createdFrom: varchar('created_from', { length: 255 }),

  departmentId: integer('department_id').references(() => departments.id),

  // Customer hierarchy → customers (Name / Top Level Parent are FK; Consolidated Customer is free text)
  customerId: integer('customer_id').references(() => customers.id),
  consolidatedCustomer: varchar('consolidated_customer', { length: 500 }), // free text (was FK → customers)
  topLevelParentId: integer('top_level_parent_id').references(() => customers.id),

  // Status — free text (was FK → estimate_statuses); NS sends "pendingFulfillment" etc.
  status: varchar('status', { length: 255 }),

  tranDate: date('tran_date'),
  expectedCloseDate: date('expected_close_date'),
  promisedDeliveryDate: date('promised_delivery_date'),
  endDate: date('end_date'),                            // "End Date"

  projectedTotal: numeric('projected_total'),
  exchangeRate: numeric('exchange_rate'),
  amountNet: numeric('amount_net'),                     // "Amount (Net)"
  openAmount: numeric('open_amount'),                   // "Open Amount"
  // Foreign Amount — native transaction-currency amount, as sent by NetSuite.
  // Falls back to a derived value (projectedTotal ÷ exchangeRate) in the
  // snapshot builder when NetSuite hasn't populated this yet.
  foreignAmount: numeric('foreign_amount'),

  currencyId: integer('currency_id').references(() => currencies.id),
  subsidiaryId: integer('subsidiary_id').references(() => subsidiaries.id),
  projectNameId: integer('project_name_id').references(() => projectNames.id),
  businessVerticalId: integer('business_vertical_id').references(() => businessVerticals.id),
  salesRepId: integer('sales_rep_id').references(() => accountManagers.id),
  likelyToCloseId: integer('likely_to_close_id').references(() => likelyToClose.id),

  // ── Line item fields (Gina Chang, "column add pipeline and so") ──────────
  lineUniqueKey: varchar('line_unique_key', { length: 50 }),
  lineNumber: integer('line_number'),
  createdFromDirect: varchar('created_from_direct', { length: 255 }),
  itemId: integer('item_id').references(() => csItems.id),
  itemName: varchar('item_name', { length: 255 }),
  itemType: varchar('item_type', { length: 100 }),
  quantity: numeric('quantity'),
  quantityBackOrdered: numeric('quantity_back_ordered'),
  unitSalesPrice: numeric('unit_sales_price'),
  lineAmount: numeric('line_amount'),
  shortDescription: varchar('short_description', { length: 500 }),
  vendorCurrency: varchar('vendor_currency', { length: 100 }),
  description: text('description'),
  lineProjectId: integer('line_project_id').references(() => projectNames.id),
  lineProjectTypeId: integer('line_project_type_id').references(() => projectTypes.id),

  ...syncCols,
}, (t) => ({
  nsIdIdx:     uniqueIndex('sos_ns_id_idx').on(t.netsuiteInternalId),
  syncIdx:     index('sos_sync_idx').on(t.syncStatus),
  customerIdx: index('sos_customer_idx').on(t.customerId),
  statusIdx:   index('sos_status_idx').on(t.status),
  docNumIdx:   index('sos_doc_num_idx').on(t.documentNumber),
  createdFromIdx: index('sos_created_from_idx').on(t.createdFrom),
}));

// ══════════════════════════════════════════════════════════════════
//  INVOICE SAVED SEARCH (mirror of the NetSuite saved search)
//  Same column set as estimate_quote_search; FK ids for mastered columns.
// ══════════════════════════════════════════════════════════════════

export const invoiceSearch = pgTable('invoice_search', {
  id: serial('id').primaryKey(),

  documentNumber: varchar('document_number', { length: 100 }),

  // Created From — the source transaction this invoice was created from, as
  // plain text (usually the SO's document number). Free text, not a FK.
  createdFrom: varchar('created_from', { length: 255 }),

  // Sales Order link — "Document Number (SO)" + "SO Date" carried as plain text
  // /date rather than a FK into sales_order_search, so an invoice still keeps
  // the reference when its SO row hasn't synced (or is later removed).
  soDocumentNumber: varchar('so_document_number', { length: 100 }),
  soDate: date('so_date'),

  // EST Number — originating Estimate's document number ("EST0008946"). This is
  // the lifecycle link key the snapshot engine resolves anchor_id from.
  estNumber: varchar('est_number', { length: 100 }),

  departmentId: integer('department_id').references(() => departments.id),

  customerId: integer('customer_id').references(() => customers.id),
  // Consolidated Customer — free text (was FK -> customers). NetSuite's
  // Invoice saved search sends the DISPLAY TEXT directly, never an internal
  // id, so the FK lookup matched nothing and this always stored null. Same
  // fix as sales_order_search (migration 0073).
  consolidatedCustomer: varchar('consolidated_customer', { length: 500 }),
  topLevelParentId: integer('top_level_parent_id').references(() => customers.id),

  statusId: integer('status_id').references(() => estimateStatuses.id),

  tranDate: date('tran_date'),
  expectedCloseDate: date('expected_close_date'),
  promisedDeliveryDate: date('promised_delivery_date'),

  projectedTotal: numeric('projected_total'),
  exchangeRate: numeric('exchange_rate'),
  usdInvoiceAmount: numeric('usd_invoice_amount'),      // "USD Invoice Amount"
  usdNetRevenue: numeric('usd_net_revenue'),            // "USD Net Revenue"
  // Foreign Amount — native transaction-currency amount, as sent by NetSuite.
  // Falls back to a derived value (projectedTotal ÷ exchangeRate) in the
  // snapshot builder when NetSuite hasn't populated this yet.
  foreignAmount: numeric('foreign_amount'),

  currencyId: integer('currency_id').references(() => currencies.id),
  subsidiaryId: integer('subsidiary_id').references(() => subsidiaries.id),
  projectNameId: integer('project_name_id').references(() => projectNames.id),
  businessVerticalId: integer('business_vertical_id').references(() => businessVerticals.id),
  salesRepId: integer('sales_rep_id').references(() => accountManagers.id),
  likelyToCloseId: integer('likely_to_close_id').references(() => likelyToClose.id),

  ...syncCols,
}, (t) => ({
  nsIdIdx:     uniqueIndex('invs_ns_id_idx').on(t.netsuiteInternalId),
  syncIdx:     index('invs_sync_idx').on(t.syncStatus),
  customerIdx: index('invs_customer_idx').on(t.customerId),
  statusIdx:   index('invs_status_idx').on(t.statusId),
  docNumIdx:   index('invs_doc_num_idx').on(t.documentNumber),
  createdFromIdx: index('invs_created_from_idx').on(t.createdFrom),
  soDocNumIdx:    index('invs_so_doc_num_idx').on(t.soDocumentNumber),
  estNumberIdx:   index('invs_est_number_idx').on(t.estNumber),
}));

// ══════════════════════════════════════════════════════════════════
//  BUDGET SAVED SEARCH (mirror of the NetSuite budget/forecast saved search)
//  List/Record fields store the FK id; (FCT) = forecast numeric fields.
//  FK targets: departments, customers, quarters, forecast_statuses, employees.
// ══════════════════════════════════════════════════════════════════

export const budgetSearch = pgTable('budget_search', {
  id: serial('id').primaryKey(),

  // Name — full display name (e.g. "NYU Langone : NYU Patient Journey | 33 | 10/1/2026")
  name: varchar('name', { length: 500 }),

  // Periods & dates
  soClosePeriod: date('so_close_period'),       // "SO Close Period"
  leadTime: varchar('lead_time', { length: 100 }), // "Lead Time" (format unknown — kept as text)
  revenuePeriod: date('revenue_period'),        // "Revenue Period"
  movedFromDate: date('moved_from_date'),       // "Moved From Date (FCT)"
  revenueMovedToPeriod: date('revenue_moved_to_period'), // "Revenue - Moved To Period (FCT)"
  fiscalYear: integer('fiscal_year'),           // "Fiscal Year"

  // Quarters → quarters  (SO QTR / Revenue QTR)
  soQtrId: integer('so_qtr_id').references(() => quarters.id),
  revenueQtrId: integer('revenue_qtr_id').references(() => quarters.id),

  // Amounts / forecast numerics (FCT)
  budgetAmount: numeric('budget_amount'),
  dilutionsPct: numeric('dilutions_pct'),
  dilutionsAmt: numeric('dilutions_amt'),
  netRevenue: numeric('net_revenue'),
  projectedGm: numeric('projected_gm'),
  projectedProfit: numeric('projected_profit'),
  trueGmGoal: numeric('true_gm_goal'),

  // Forecast Status → forecast_statuses
  forecastStatusId: integer('forecast_status_id').references(() => forecastStatuses.id),
  // "2026 Q1 Reforecast" — scenario/forecast label (assumption: free text)
  forecastScenario: varchar('forecast_scenario', { length: 255 }),

  // Department → departments
  departmentId: integer('department_id').references(() => departments.id),

  // Customer hierarchy → customers (Parent / Consolidated Customer)
  parentId: integer('parent_id').references(() => customers.id),
  consolidatedCustomerId: integer('consolidated_customer_id').references(() => customers.id),
  // Consolidated Customer (Text Field) — plain text variant
  consolidatedCustomerText: varchar('consolidated_customer_text', { length: 500 }),

  // Account Manager → employees
  accountManagerId: integer('account_manager_id').references(() => employees.id),

  // NetSuite record timestamps — "Last Modified" / "Date Created" on the NS
  // record itself. Distinct from syncCols' createdAt/updatedAt below, which
  // track when the PORTAL row was written.
  //   mode: 'string' (unlike every other timestamp in this file) because these
  //   arrive as NetSuite datetime STRINGS and are written straight through by
  //   the sync service. Drizzle's default Date mode calls .toISOString() on the
  //   value, which would throw on a string; 'string' mode hands the literal to
  //   Postgres to parse, exactly like the date() columns above.
  lastModified: timestamp('last_modified', { withTimezone: true, mode: 'string' }),
  dateCreated: timestamp('date_created', { withTimezone: true, mode: 'string' }),

  ...syncCols, // netsuiteInternalId ("Internal ID"), isActive ("Inactive" inverse), source, syncStatus, …
}, (t) => ({
  nsIdIdx:           uniqueIndex('bs_ns_id_idx').on(t.netsuiteInternalId),
  syncIdx:           index('bs_sync_idx').on(t.syncStatus),
  parentIdx:         index('bs_parent_idx').on(t.parentId),
  deptIdx:           index('bs_dept_idx').on(t.departmentId),
  forecastStatusIdx: index('bs_forecast_status_idx').on(t.forecastStatusId),
  nameIdx:           index('bs_name_idx').on(t.name),
}));

// ══════════════════════════════════════════════════════════════════
//  SYNC LOGS & CONFLICTS
// ══════════════════════════════════════════════════════════════════

export const syncLogs = pgTable('sync_logs', {
  id: serial('id').primaryKey(),
  entityType: varchar('entity_type', { length: 50 }).notNull(),
  entityId: integer('entity_id'),
  netsuiteInternalId: varchar('netsuite_internal_id', { length: 50 }),
  operation: operationEnum('operation').notNull(),
  direction: directionEnum('direction').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  attemptCount: integer('attempt_count').default(1),
  portalPayload: jsonb('portal_payload'),
  netsuiteResponse: jsonb('netsuite_response'),
  errorMessage: text('error_message'),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  entityIdx: index('sync_logs_entity_idx').on(t.entityType, t.entityId),
  statusIdx: index('sync_logs_status_idx').on(t.status),
  createdIdx: index('sync_logs_created_idx').on(t.createdAt),
}));

export const syncConflicts = pgTable('sync_conflicts', {
  id: serial('id').primaryKey(),
  entityType: varchar('entity_type', { length: 50 }).notNull(),
  entityId: integer('entity_id'),
  netsuiteInternalId: varchar('netsuite_internal_id', { length: 50 }),
  portalData: jsonb('portal_data').notNull(),
  netsuiteData: jsonb('netsuite_data').notNull(),
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  resolution: varchar('resolution', { length: 20 }),
  resolvedBy: integer('resolved_by').references(() => users.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

// ══════════════════════════════════════════════════════════════════
//  REVENUE ANALYTICS SNAPSHOT ENGINE
//  fact_revenue_snapshot → revenue_comparison → fact_revenue_change_log
//
//  These 3 tables are deliberately NOT linked to each other or to the 4
//  source tables (estimate_quote_search, sales_order_search, invoice_search,
//  budget_search) via `.references()` foreign keys. They're an append-only
//  analytical/fact layer: a comparison row is built by joining TWO different
//  fact_revenue_snapshot rows (a prior date + a current date) that share the
//  same anchor_id, which a single FK column cannot express. The join key
//  across all three tables — and back to the source tables — is the plain,
//  indexed `anchor_id` string (the originating Estimate's document number),
//  never a numeric FK.
// ══════════════════════════════════════════════════════════════════

// ─── 1. Revenue Snapshot ───────────────────────────────────────────
// Full historical copy of every active Pipeline/SO/Invoice/Budget record,
// appended (never updated) on every sync run. See Fact_Revenue_Snapshot tab
// of AI_FPA_DW_Change_Log_Rules_v4.xlsx for the source spec.
//
// NOTE: consolidated_customer, top_level_parent, department, sales_rep,
// project_name, status, and stage are stored as resolved DISPLAY TEXT here,
// not FK ids — the source tables store these as *_id FKs into master tables,
// so the insert code must resolve each id to its label before writing a
// snapshot row (this table is a denormalized fact table by design).
//
// NOTE: `internal_id` is varchar(50), not BIGINT as the source workbook
// specifies — changed to match the existing `netsuite_internal_id` convention
// used on every other table in this schema (estimates, estimate_quote_search,
// sales_order_search, invoice_search, budget_search all store it as
// varchar(50)), so joins/comparisons against those tables don't need casts.
export const factRevenueSnapshot = pgTable('fact_revenue_snapshot', {
  id: serial('id').primaryKey(),

  // Technical
  snapshotDate: date('snapshot_date').notNull(),
  snapshotTs: timestamp('snapshot_ts', { withTimezone: true }).notNull(),
  sourceType: varchar('source_type', { length: 20 }).notNull(), // PIPELINE / SO / INVOICE / BUDGET
  sourceName: varchar('source_name', { length: 100 }), // which NetSuite saved search produced this row — traceability
  internalId: varchar('internal_id', { length: 50 }).notNull(),
  anchorId: varchar('anchor_id', { length: 50 }),
  documentNumber: varchar('document_number', { length: 100 }),

  // Customer
  consolidatedCustomer: varchar('consolidated_customer', { length: 200 }),
  topLevelParent: varchar('top_level_parent', { length: 200 }),
  department: varchar('department', { length: 100 }),
  salesRep: varchar('sales_rep', { length: 100 }),
  projectName: varchar('project_name', { length: 250 }),
  subsidiary: varchar('subsidiary', { length: 100 }), // Pipeline/SO/Invoice only — Budget has no subsidiaryId source field

  // Commercial
  status: varchar('status', { length: 100 }),
  stage: varchar('stage', { length: 100 }),
  likelyToClose: varchar('likely_to_close', { length: 100 }), // Pipeline/SO/Invoice — used by the Original Baseline rule ("Likely to Close > 3")

  // Dates
  createdDate: date('created_date'),
  revenueDate: date('revenue_date'),
  revenuePeriod: date('revenue_period'), // DATE_TRUNC('month', revenue_date)

  // Amounts
  foreignAmount: numeric('foreign_amount', { precision: 18, scale: 2 }),
  currency: varchar('currency', { length: 10 }),
  exchangeRate: numeric('exchange_rate', { precision: 18, scale: 8 }),
  usdAmount: numeric('usd_amount', { precision: 18, scale: 2 }),

  // Derived
  changeDriver: varchar('change_driver', { length: 30 }), // BUSINESS / FX_ONLY / BUSINESS_AND_FX
  isActive: boolean('is_active').default(true).notNull(),
}, (t) => ({
  snapshotDateIdx: index('frs_snapshot_date_idx').on(t.snapshotDate),
  sourceTypeIdx: index('frs_source_type_idx').on(t.sourceType),
  internalIdIdx: index('frs_internal_id_idx').on(t.internalId),
  anchorIdx: index('frs_anchor_idx').on(t.anchorId),
  anchorSnapshotIdx: index('frs_anchor_snapshot_idx').on(t.anchorId, t.snapshotDate),
}));

// ─── 2. Revenue Comparison ─────────────────────────────────────────
// Wide/cross-tab layout — amounts and dates broken out per source type
// (Pipeline/Open SO/Invoice) as separate columns, rather than one generic
// prior/current pair — per the "Comparison Table" worked example in the
// Cons Rev & comparison tab (Partial Invoice Scenario, row 54) and the
// consolidated business-logic writeup. Replaces the earlier narrow/generic
// design (never applied to any database).
export const revenueComparison = pgTable('revenue_comparison', {
  id: serial('id').primaryKey(),

  anchorId: varchar('anchor_id', { length: 50 }).notNull(),
  reportType: varchar('report_type', { length: 10 }).notNull(), // DOD/WOW/MOM/QOQ

  priorSnapshotPeriod: date('prior_snapshot_period').notNull(),
  currentSnapshotPeriod: date('current_snapshot_period').notNull(),

  // Pipeline stage — broken out separately
  priorPipelineAmt: numeric('prior_pipeline_amt', { precision: 18, scale: 2 }),
  currentPipelineAmt: numeric('current_pipeline_amt', { precision: 18, scale: 2 }),
  pipelineAmountChange: numeric('pipeline_amount_change', { precision: 18, scale: 2 }),
  priorPipelineRevDate: date('prior_pipeline_rev_date'),
  currentPipelineRevDate: date('current_pipeline_rev_date'),
  pipelineRevenueDateChange: varchar('pipeline_revenue_date_change', { length: 50 }),

  // Open SO stage — broken out separately
  priorOpenSoAmt: numeric('prior_open_so_amt', { precision: 18, scale: 2 }),
  currentOpenSoAmt: numeric('current_open_so_amt', { precision: 18, scale: 2 }),
  openSoAmountChange: numeric('open_so_amount_change', { precision: 18, scale: 2 }),
  usdSoAmountChange: numeric('usd_so_amount_change', { precision: 18, scale: 2 }),
  priorSoRevDate: date('prior_so_rev_date'),
  currentSoRevDate: date('current_so_rev_date'),
  soRevenueDateChange: varchar('so_revenue_date_change', { length: 50 }),

  // Invoice stage — broken out separately
  priorInvoiceAmt: numeric('prior_invoice_amt', { precision: 18, scale: 2 }),
  currentInvoiceAmt: numeric('current_invoice_amt', { precision: 18, scale: 2 }),
  invoiceAmountChange: numeric('invoice_amount_change', { precision: 18, scale: 2 }),
  usdInvoiceAmountChange: numeric('usd_invoice_amount_change', { precision: 18, scale: 2 }),
  priorInvoiceDate: date('prior_invoice_date'),
  currentInvoiceDate: date('current_invoice_date'),
  invoiceRevenuePeriodSummary: varchar('invoice_revenue_period_summary', { length: 50 }),

  // Totals across all 3 stages
  totalPriorAmount: numeric('total_prior_amount', { precision: 18, scale: 2 }), // col K + col H
  totalCurrentAmount: numeric('total_current_amount', { precision: 18, scale: 2 }), // col M + col I
  totalAmountChange: numeric('total_amount_change', { precision: 18, scale: 2 }), // col O - col N
  usdTotalAmountChange: numeric('usd_total_amount_change', { precision: 18, scale: 2 }),

  // Reconciliation: total_amount_change should equal invoiceAmountChange + openSoAmountChange.
  // Anything other than TRUE here is a data/pipeline red flag, not a business event.
  checkFlag: boolean('check_flag'),

  lifecycleEvent: varchar('lifecycle_event', { length: 100 }), // includes DELETED — see fact_revenue_change_log notes
  revenueDateChangeSummary: varchar('revenue_date_change_summary', { length: 100 }),

  // Reporting attributes carried through
  customerName: varchar('customer_name', { length: 200 }), // Consolidated Customer
  parent: varchar('parent', { length: 200 }),
  projectName: varchar('project_name', { length: 250 }),
  salesRep: varchar('sales_rep', { length: 100 }), // Sales Rep / Account Manager
  department: varchar('department', { length: 100 }),
  subsidiary: varchar('subsidiary', { length: 100 }),
  currency: varchar('currency', { length: 10 }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  anchorIdx: index('rc_anchor_idx').on(t.anchorId),
  reportTypeIdx: index('rc_report_type_idx').on(t.reportType),
  currentSnapshotIdx: index('rc_current_snapshot_idx').on(t.currentSnapshotPeriod),
  anchorReportIdx: index('rc_anchor_report_idx').on(t.anchorId, t.reportType, t.currentSnapshotPeriod),
  // One row per (anchor, report type, date pair) — lets the builder upsert
  // instead of duplicating a row if it's ever re-run for the same comparison.
  anchorReportPeriodUidx: uniqueIndex('rc_anchor_report_period_uidx').on(t.anchorId, t.reportType, t.priorSnapshotPeriod, t.currentSnapshotPeriod),
  // Serves "every row for this report type as of this run" lookups.
  reportTypeCurrentIdx: index('rc_report_type_current_idx').on(t.reportType, t.currentSnapshotPeriod),
}));

// ─── 3. Revenue Change Log ─────────────────────────────────────────
// Reverted to the 32-column 4_Change Log Output-based design, per the
// consolidated business-logic writeup — this replaces the brief 14-column
// "13_Expected Outputs" sample-row version (never applied to any database).
// change_event_id / change_group_id are app-generated UUIDs
// (crypto.randomUUID()), not DB-default-generated, matching this schema's
// existing style of not relying on Postgres-side generation functions.
//
// change_type also carries the new DELETED event: fires only on the one
// comparison run where the prior snapshot still had the anchor_id and the
// current snapshot doesn't (change_driver = LIFECYCLE, prior_foreign_amount
// = last known value, current_foreign_amount = 0/null). A later run where
// the anchor is absent from both snapshots produces no row at all — that's
// correct behavior, not a gap, so DELETED never repeats on subsequent runs.
export const factRevenueChangeLog = pgTable('fact_revenue_change_log', {
  id: serial('id').primaryKey(),

  changeEventId: uuid('change_event_id').notNull(),
  changeGroupId: uuid('change_group_id').notNull(),
  changeType: varchar('change_type', { length: 50 }).notNull(), // includes DELETED
  changeDriver: varchar('change_driver', { length: 30 }).notNull(), // BUSINESS, FX_ONLY, BUSINESS_AND_FX, PERIOD, LIFECYCLE, DATA_QUALITY

  sourceType: varchar('source_type', { length: 20 }), // Pipeline, SO, or Invoice
  sourceRecordId: varchar('source_record_id', { length: 50 }),
  documentNumber: varchar('document_number', { length: 100 }),
  anchorId: varchar('anchor_id', { length: 50 }).notNull(),

  fromSnapshotDate: date('from_snapshot_date').notNull(),
  toSnapshotDate: date('to_snapshot_date').notNull(),

  currency: varchar('currency', { length: 10 }),

  originalForeignAmount: numeric('original_foreign_amount', { precision: 18, scale: 2 }),
  priorForeignAmount: numeric('prior_foreign_amount', { precision: 18, scale: 2 }),
  currentForeignAmount: numeric('current_foreign_amount', { precision: 18, scale: 2 }),
  foreignDeltaVsPrior: numeric('foreign_delta_vs_prior', { precision: 18, scale: 2 }),
  foreignDeltaVsOriginal: numeric('foreign_delta_vs_original', { precision: 18, scale: 2 }),

  originalReportedUsdAmount: numeric('original_reported_usd_amount', { precision: 18, scale: 2 }),
  priorReportedUsdAmount: numeric('prior_reported_usd_amount', { precision: 18, scale: 2 }),
  currentReportedUsdAmount: numeric('current_reported_usd_amount', { precision: 18, scale: 2 }),

  originalExchangeRate: numeric('original_exchange_rate', { precision: 18, scale: 8 }),
  priorExchangeRate: numeric('prior_exchange_rate', { precision: 18, scale: 8 }),
  currentExchangeRate: numeric('current_exchange_rate', { precision: 18, scale: 8 }),
  reportedUsdDeltaVsPrior: numeric('reported_usd_delta_vs_prior', { precision: 18, scale: 2 }),

  fxOnlyChangeFlag: boolean('fx_only_change_flag').default(false).notNull(),

  originalRevenuePeriod: date('original_revenue_period'),
  priorRevenuePeriod: date('prior_revenue_period'),
  currentRevenuePeriod: date('current_revenue_period'),
  monthsShiftedVsPrior: integer('months_shifted_vs_prior'),
  monthsShiftedVsOriginal: integer('months_shifted_vs_original'),

  changeDescription: text('change_description'),
  controlSeverity: varchar('control_severity', { length: 20 }), // INFO, REVIEW, WARNING, CRITICAL

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  anchorIdx: index('crl_anchor_idx').on(t.anchorId),
  groupIdx: index('crl_group_idx').on(t.changeGroupId),
  eventIdx: uniqueIndex('crl_event_idx').on(t.changeEventId),
  changeTypeIdx: index('crl_change_type_idx').on(t.changeType),
  changeDriverIdx: index('crl_change_driver_idx').on(t.changeDriver),
  snapshotRangeIdx: index('crl_snapshot_range_idx').on(t.fromSnapshotDate, t.toSnapshotDate),
}));

// ─── 3b. Revenue Change Log (anchor grain) ─────────────────────────
// Built off revenue_comparison rows rather than off fact_revenue_snapshot
// records — one row per meaningful business event per anchor, per report
// type, per snapshot date. See src/jobs/revenueChangeLog/revenueChangeLog.ts
// for the priority-ordered rule engine that populates it, and migration
// 0081 for how this relates to (and differs from) fact_revenue_change_log
// above: that one is per-source-record and DOD-only with snake_case codes;
// this one is per-anchor, covers all 4 report types, and stores prose
// change_type values so BI tools can read them directly.
//
// Never carries a "no change" row — if no rule matched, nothing is written.
export const revenueChangeLog = pgTable('revenue_change_log', {
  changeEventId: bigserial('change_event_id', { mode: 'number' }).primaryKey(),
  changeGroupId: uuid('change_group_id').notNull(), // one UUID per runChangeLogForBatch() call
  changeType: varchar('change_type', { length: 50 }).notNull(), // prose, e.g. 'Revenue Increase', 'SO partially invoiced'
  changeDriver: varchar('change_driver', { length: 30 }).notNull(), // BUSINESS / FX_ONLY / BUSINESS_AND_FX / PERIOD / LIFECYCLE / DATA_QUALITY

  sourceType: varchar('source_type', { length: 20 }),
  // BIGINT per the agreed column spec. fact_revenue_snapshot.internal_id is
  // varchar(50), so the job only populates this when that value is actually
  // numeric — non-numeric NetSuite ids resolve to null rather than throwing.
  sourceRecordId: bigint('source_record_id', { mode: 'number' }),
  documentNumber: varchar('document_number', { length: 50 }),
  anchorId: varchar('anchor_id', { length: 50 }).notNull(),

  fromSnapshotDate: date('from_snapshot_date').notNull(), // = revenue_comparison.prior_snapshot_period
  toSnapshotDate: date('to_snapshot_date').notNull(), // = revenue_comparison.current_snapshot_period
  reportType: varchar('report_type', { length: 10 }).notNull(), // DOD/WOW/MOM/QOQ

  originalForeignAmount: numeric('original_foreign_amount', { precision: 18, scale: 2 }),
  priorForeignAmount: numeric('prior_foreign_amount', { precision: 18, scale: 2 }),
  currentForeignAmount: numeric('current_foreign_amount', { precision: 18, scale: 2 }),
  foreignDeltaVsPrior: numeric('foreign_delta_vs_prior', { precision: 18, scale: 2 }),
  foreignDeltaVsOriginal: numeric('foreign_delta_vs_original', { precision: 18, scale: 2 }),

  originalReportedUsdAmount: numeric('original_reported_usd_amount', { precision: 18, scale: 2 }),
  priorReportedUsdAmount: numeric('prior_reported_usd_amount', { precision: 18, scale: 2 }),
  currentReportedUsdAmount: numeric('current_reported_usd_amount', { precision: 18, scale: 2 }),
  reportedUsdDeltaVsPrior: numeric('reported_usd_delta_vs_prior', { precision: 18, scale: 2 }),

  originalExchangeRate: numeric('original_exchange_rate', { precision: 18, scale: 8 }),
  priorExchangeRate: numeric('prior_exchange_rate', { precision: 18, scale: 8 }),
  currentExchangeRate: numeric('current_exchange_rate', { precision: 18, scale: 8 }),
  fxOnlyChangeFlag: boolean('fx_only_change_flag').default(false),

  originalRevenuePeriod: date('original_revenue_period'),
  priorRevenuePeriod: date('prior_revenue_period'),
  currentRevenuePeriod: date('current_revenue_period'),
  monthsShiftedVsPrior: integer('months_shifted_vs_prior'),
  monthsShiftedVsOriginal: integer('months_shifted_vs_original'),

  changeDescription: text('change_description'), // fully worded — dashboards read this as-is
  controlSeverity: varchar('control_severity', { length: 10 }), // INFO / REVIEW / WARNING / CRITICAL

  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  anchorIdx: index('idx_change_log_anchor').on(t.anchorId),
  severityIdx: index('idx_change_log_severity').on(t.controlSeverity, t.toSnapshotDate),
  // The ON CONFLICT DO NOTHING target that makes re-running a batch a no-op.
  // change_type is part of the key so rule 7's extra 'Revenue Shift' row can
  // coexist with the amount/FX row for the same anchor and date.
  reportAnchorDateTypeKey: unique('revenue_change_log_report_anchor_date_type_key')
    .on(t.reportType, t.anchorId, t.toSnapshotDate, t.changeType),
}));

// ─── 4. Revenue Sync Signal Log ─────────────────────────────────────
// Control table for the signal-driven snapshot job (src/jobs/revenueSnapshot/).
// NetSuite calls three endpoints — "sync start", "sync end", and "sync fail"
// — once per source per day; each call upserts one row here. sourceType is
// one of PIPELINE / SO / INVOICE / BUDGET for the 4 real sources, plus a 5th
// synthetic row per day with sourceType = 'ALL' that tracks the overall
// insert job's own lifecycle (pending -> scheduled -> running -> complete /
// failed) once all 4 real sources report 'completed'. If any real source
// reports 'failed', that day must not be used for comparisons — the insert
// never gets triggered, since allSourcesCompleted() only counts 'completed'
// rows. Not read by anything else in the app.
export const revenueSyncSignalLog = pgTable('revenue_sync_signal_log', {
  id: serial('id').primaryKey(),
  runDate: date('run_date').notNull(),
  sourceType: varchar('source_type', { length: 20 }).notNull(), // PIPELINE / SO / INVOICE / BUDGET / ALL
  status: varchar('status', { length: 20 }).default('pending').notNull(), // pending/started/completed/failed (sources) or pending/scheduled/running/complete/failed (ALL)
  recordCount: integer('record_count'), // how many records NetSuite reported syncing — sanity-check input
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  runDateSourceIdx: uniqueIndex('rssl_run_date_source_idx').on(t.runDate, t.sourceType),
}));

// ══════════════════════════════════════════════════════════════════
//  RELATIONS
// ══════════════════════════════════════════════════════════════════

export const subsidiariesRelations = relations(subsidiaries, ({ one, many }) => ({
  currency: one(currencies, { fields: [subsidiaries.currencyId], references: [currencies.id] }),
  customers: many(customers),
  contacts: many(contacts),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  subsidiary: one(subsidiaries, { fields: [customers.subsidiaryId], references: [subsidiaries.id] }),
  currency: one(currencies, { fields: [customers.currencyId], references: [currencies.id] }),
  podRegion: one(obcPodRegions, { fields: [customers.podRegionId], references: [obcPodRegions.id] }),
  salesRepManager: one(accountManagers, { fields: [customers.salesRepId], references: [accountManagers.id] }),
  contacts: many(contacts),
  addresses: many(addresses),
  estimates: many(estimates),
  projectNames: many(projectNames),
}));

export const obcPodRegionsRelations = relations(obcPodRegions, ({ many }) => ({
  customers: many(customers),
}));

// Country ↔ State: one country has many states; each state belongs to one country.
export const countriesRelations = relations(countries, ({ many }) => ({
  states: many(states),
}));

export const statesRelations = relations(states, ({ one }) => ({
  country: one(countries, { fields: [states.countryId], references: [countries.id] }),
}));

export const contactsRelations = relations(contacts, ({ one }) => ({
  subsidiary: one(subsidiaries, { fields: [contacts.subsidiaryId], references: [subsidiaries.id] }),
  currency: one(currencies, { fields: [contacts.currencyId], references: [currencies.id] }),
  customer: one(customers, { fields: [contacts.customerId], references: [customers.id] }),
}));

export const addressesRelations = relations(addresses, ({ one }) => ({
  customer: one(customers, { fields: [addresses.customerId], references: [customers.id] }),
  country: one(countries, { fields: [addresses.countryId], references: [countries.id] }),
  state: one(states, { fields: [addresses.stateId], references: [states.id] }),
}));

export const projectNamesRelations = relations(projectNames, ({ one }) => ({
  customer: one(customers, { fields: [projectNames.customerId], references: [customers.id] }),
  projectType: one(projectTypes, { fields: [projectNames.projectTypeId], references: [projectTypes.id] }),
}));

export const projectTypesRelations = relations(projectTypes, ({ many }) => ({
  projectNames: many(projectNames),
}));

export const vendorsRelations = relations(vendors, ({ many }) => ({
  vendorAddresses: many(vendorAddresses),
}));

export const factoriesRelations = relations(factories, () => ({}));

export const employeesRelations = relations(employees, ({ one }) => ({
  currency: one(currencies, { fields: [employees.currencyId], references: [currencies.id] }),
  subsidiary: one(subsidiaries, { fields: [employees.subsidiaryId], references: [subsidiaries.id] }),
  department: one(departments, { fields: [employees.departmentId], references: [departments.id] }),
}));

export const estimatesRelations = relations(estimates, ({ one, many }) => ({
  customer: one(customers, { fields: [estimates.customerId], references: [customers.id] }),
  contact: one(contacts, { fields: [estimates.customerContactId], references: [contacts.id] }),
  projectNameRel: one(projectNames, { fields: [estimates.projectNameId], references: [projectNames.id] }),
  sellCurrency: one(currencies, { fields: [estimates.sellCurrencyId], references: [currencies.id] }),
  acctManager: one(accountManagers, { fields: [estimates.acctManagerId], references: [accountManagers.id] }),
  esStatus: one(esStatus, { fields: [estimates.esStatusId], references: [esStatus.id] }),
  lineItems: many(estimateLineItems),
  quotes: many(estimateQuotes),
  createdByUser: one(users, { fields: [estimates.createdBy], references: [users.id] }),
}));

// One estimate → many quotes (each OTB conversion / NetSuite Quote).
// The FK already exists on estimate_quotes.estimate_id; this declares it to the
// ORM so estimates can be loaded with their quotes in a single relational query.
export const estimateQuotesRelations = relations(estimateQuotes, ({ one }) => ({
  estimate: one(estimates, { fields: [estimateQuotes.estimateId], references: [estimates.id] }),
}));

export const estimateLineItemsRelations = relations(estimateLineItems, ({ one, many }) => ({
  estimate: one(estimates, { fields: [estimateLineItems.estimateId], references: [estimates.id] }),
  parent: one(estimateLineItems, {
    fields: [estimateLineItems.parentLineItemId],
    references: [estimateLineItems.id],
    relationName: 'parent_child',
  }),
  components: many(estimateLineItems, { relationName: 'parent_child' }),
  vendor: one(vendors, { fields: [estimateLineItems.vendorId], references: [vendors.id] }),
  factory: one(factories, { fields: [estimateLineItems.factoryId], references: [factories.id] }),
  vendorCurrency: one(currencies, { fields: [estimateLineItems.vendorCurrencyId], references: [currencies.id] }),
  productClass: one(productClasses, { fields: [estimateLineItems.productClassId], references: [productClasses.id] }),
  productClassEu: one(productClassesEu, { fields: [estimateLineItems.productClassEuId], references: [productClassesEu.id] }),
  class: one(classes, { fields: [estimateLineItems.classId], references: [classes.id] }),
  componentKitItem: one(componentKitItems, { fields: [estimateLineItems.componentKitItemId], references: [componentKitItems.id] }),
}));

export const drayageRelations = relations(drayage, ({ many }) => ({
  freightGroups: many(estimateFreightGroups),
}));

export const estimateFreightGroupsRelations = relations(estimateFreightGroups, ({ one }) => ({
  estimate: one(estimates, { fields: [estimateFreightGroups.estimateId], references: [estimates.id] }),
  drayage: one(drayage, { fields: [estimateFreightGroups.drayageId], references: [drayage.id] }),
}));

export const estimateQuoteSearchRelations = relations(estimateQuoteSearch, ({ one }) => ({
  department:           one(departments,       { fields: [estimateQuoteSearch.departmentId],         references: [departments.id] }),
  customer:             one(customers,         { fields: [estimateQuoteSearch.customerId],           references: [customers.id] }),
  // consolidatedCustomer and status are now free-text columns (not FKs) — no relations.
  topLevelParent:       one(customers,         { fields: [estimateQuoteSearch.topLevelParentId],     references: [customers.id] }),
  currency:             one(currencies,        { fields: [estimateQuoteSearch.currencyId],           references: [currencies.id] }),
  subsidiary:           one(subsidiaries,      { fields: [estimateQuoteSearch.subsidiaryId],         references: [subsidiaries.id] }),
  projectName:          one(projectNames,      { fields: [estimateQuoteSearch.projectNameId],        references: [projectNames.id] }),
  businessVertical:     one(businessVerticals, { fields: [estimateQuoteSearch.businessVerticalId],   references: [businessVerticals.id] }),
  salesRep:             one(accountManagers,   { fields: [estimateQuoteSearch.salesRepId],           references: [accountManagers.id] }),
  likelyToClose:        one(likelyToClose,     { fields: [estimateQuoteSearch.likelyToCloseId],      references: [likelyToClose.id] }),
}));

export const salesOrderSearchRelations = relations(salesOrderSearch, ({ one }) => ({
  department:           one(departments,       { fields: [salesOrderSearch.departmentId],         references: [departments.id] }),
  customer:             one(customers,         { fields: [salesOrderSearch.customerId],           references: [customers.id] }),
  // consolidatedCustomer and status are now free-text columns (not FKs) — no relations.
  topLevelParent:       one(customers,         { fields: [salesOrderSearch.topLevelParentId],     references: [customers.id] }),
  currency:             one(currencies,        { fields: [salesOrderSearch.currencyId],           references: [currencies.id] }),
  subsidiary:           one(subsidiaries,      { fields: [salesOrderSearch.subsidiaryId],         references: [subsidiaries.id] }),
  projectName:          one(projectNames,      { fields: [salesOrderSearch.projectNameId],        references: [projectNames.id] }),
  businessVertical:     one(businessVerticals, { fields: [salesOrderSearch.businessVerticalId],   references: [businessVerticals.id] }),
  salesRep:             one(accountManagers,   { fields: [salesOrderSearch.salesRepId],           references: [accountManagers.id] }),
  likelyToClose:        one(likelyToClose,     { fields: [salesOrderSearch.likelyToCloseId],      references: [likelyToClose.id] }),
}));

export const invoiceSearchRelations = relations(invoiceSearch, ({ one }) => ({
  department:           one(departments,       { fields: [invoiceSearch.departmentId],         references: [departments.id] }),
  customer:             one(customers,         { fields: [invoiceSearch.customerId],           references: [customers.id] }),
  // consolidatedCustomer is now a free-text column (not a FK) — no relation.
  topLevelParent:       one(customers,         { fields: [invoiceSearch.topLevelParentId],     references: [customers.id] }),
  status:               one(estimateStatuses,  { fields: [invoiceSearch.statusId],             references: [estimateStatuses.id] }),
  currency:             one(currencies,        { fields: [invoiceSearch.currencyId],           references: [currencies.id] }),
  subsidiary:           one(subsidiaries,      { fields: [invoiceSearch.subsidiaryId],         references: [subsidiaries.id] }),
  projectName:          one(projectNames,      { fields: [invoiceSearch.projectNameId],        references: [projectNames.id] }),
  businessVertical:     one(businessVerticals, { fields: [invoiceSearch.businessVerticalId],   references: [businessVerticals.id] }),
  salesRep:             one(accountManagers,   { fields: [invoiceSearch.salesRepId],           references: [accountManagers.id] }),
  likelyToClose:        one(likelyToClose,     { fields: [invoiceSearch.likelyToCloseId],      references: [likelyToClose.id] }),
}));

export const budgetSearchRelations = relations(budgetSearch, ({ one }) => ({
  soQtr:                one(quarters,          { fields: [budgetSearch.soQtrId],                 references: [quarters.id] }),
  revenueQtr:           one(quarters,          { fields: [budgetSearch.revenueQtrId],            references: [quarters.id] }),
  forecastStatus:       one(forecastStatuses,  { fields: [budgetSearch.forecastStatusId],        references: [forecastStatuses.id] }),
  department:           one(departments,       { fields: [budgetSearch.departmentId],            references: [departments.id] }),
  parent:               one(customers,         { fields: [budgetSearch.parentId],                references: [customers.id] }),
  consolidatedCustomer: one(customers,         { fields: [budgetSearch.consolidatedCustomerId],  references: [customers.id] }),
  accountManager:       one(employees,         { fields: [budgetSearch.accountManagerId],        references: [employees.id] }),
}));

// ─── Export all tables as a map for generic service ───────────────

export const MASTER_TABLES = {
  subsidiaries,
  customers,
  obc_pod_regions: obcPodRegions,
  contacts,
  addresses,
  currencies,
  project_names: projectNames,
  project_types: projectTypes,
  likely_to_close: likelyToClose,
  departments,
  sales_channels: salesChannels,
  business_verticals: businessVerticals,
  business_types: businessTypes,
  employees,
  quarters,
  forecast_statuses: forecastStatuses,
  hk_partners: hkPartners,
  ops_partners: opsPartners,
  compliance_partners: compliancePartners,
  account_managers: accountManagers,
  product_developers: productDevelopers,
  incoterms: clientIncoterms,
  shipping_methods: clientShippingMethods,
  client_incoterms: clientIncoterms,
  client_shipping_methods: clientShippingMethods,
  vendors,
  vendor_addresses: vendorAddresses,
  vendor_incoterms: vendorIncoterms,
  factories,
  item_types: itemTypes,
  product_classes: productClasses,
  product_classes_eu: productClassesEu,
  classes,
  sustainability_options: sustainabilityOptions,
  component_kit_items: componentKitItems,
  closed_lost_reasons: closedLostReasons,
  client_pursuit_alternatives: clientPursuitAlternatives,
  estimate_statuses: estimateStatuses,
  shipping_groups: shippingGroups,
  cs_items: csItems,
  lcl_rates: lclRates,
  fcl_rates: fclRates,
  air_rates: airRates,
  additional_fees: additionalFees,
  drayage,
  es_status: esStatus,
  countries,
  states,
} as const;

export type MasterEntityKey = keyof typeof MASTER_TABLES;
