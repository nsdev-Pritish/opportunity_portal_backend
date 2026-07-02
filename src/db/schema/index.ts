import {
  pgTable, serial, varchar, boolean, timestamp, integer,
  numeric, text, jsonb, date, index, uniqueIndex, pgEnum, AnyPgColumn,
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
  state: varchar('state', { length: 100 }),
  country: varchar('country', { length: 100 }),
  postalCode: varchar('postal_code', { length: 20 }),
  ...syncCols,
}, (t) => ({
  nsIdIdx: uniqueIndex('addresses_ns_id_idx').on(t.netsuiteInternalId),
  customerIdx: index('addresses_customer_idx').on(t.customerId),
  typeIdx: index('addresses_type_idx').on(t.type),
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
  expectedCloseDate: date('expected_close_date'),
  promiseDate: date('promise_date'),
  likelyToCloseId: integer('likely_to_close_id').references(() => likelyToClose.id),
  sellCurrencyId: integer('sell_currency_id').references(() => currencies.id),
  projectedTotalAmt: numeric('projected_total_amt', { precision: 15, scale: 2 }),
  estimatedQty: integer('estimated_qty'),

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

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // NOTE: the old chosen_type, sort_order and rate-ref columns from the original
  // estimate_freight_groups table still exist physically in the DB but are intentionally
  // not mapped here — they are unused by the current freight-group model.
}, (t) => ({
  estimateIdx: index('efg_estimate_idx').on(t.estimateId),
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

  departmentId: integer('department_id').references(() => departments.id),

  customerId: integer('customer_id').references(() => customers.id),
  consolidatedCustomerId: integer('consolidated_customer_id').references(() => customers.id),
  topLevelParentId: integer('top_level_parent_id').references(() => customers.id),

  statusId: integer('status_id').references(() => estimateStatuses.id),

  tranDate: date('tran_date'),
  expectedCloseDate: date('expected_close_date'),
  promisedDeliveryDate: date('promised_delivery_date'),

  projectedTotal: numeric('projected_total'),
  exchangeRate: numeric('exchange_rate'),

  currencyId: integer('currency_id').references(() => currencies.id),
  subsidiaryId: integer('subsidiary_id').references(() => subsidiaries.id),
  projectNameId: integer('project_name_id').references(() => projectNames.id),
  businessVerticalId: integer('business_vertical_id').references(() => businessVerticals.id),
  salesRepId: integer('sales_rep_id').references(() => accountManagers.id),
  likelyToCloseId: integer('likely_to_close_id').references(() => likelyToClose.id),

  ...syncCols,
}, (t) => ({
  nsIdIdx:     uniqueIndex('sos_ns_id_idx').on(t.netsuiteInternalId),
  syncIdx:     index('sos_sync_idx').on(t.syncStatus),
  customerIdx: index('sos_customer_idx').on(t.customerId),
  statusIdx:   index('sos_status_idx').on(t.statusId),
  docNumIdx:   index('sos_doc_num_idx').on(t.documentNumber),
}));

// ══════════════════════════════════════════════════════════════════
//  INVOICE SAVED SEARCH (mirror of the NetSuite saved search)
//  Same column set as estimate_quote_search; FK ids for mastered columns.
// ══════════════════════════════════════════════════════════════════

export const invoiceSearch = pgTable('invoice_search', {
  id: serial('id').primaryKey(),

  documentNumber: varchar('document_number', { length: 100 }),

  departmentId: integer('department_id').references(() => departments.id),

  customerId: integer('customer_id').references(() => customers.id),
  consolidatedCustomerId: integer('consolidated_customer_id').references(() => customers.id),
  topLevelParentId: integer('top_level_parent_id').references(() => customers.id),

  statusId: integer('status_id').references(() => estimateStatuses.id),

  tranDate: date('tran_date'),
  expectedCloseDate: date('expected_close_date'),
  promisedDeliveryDate: date('promised_delivery_date'),

  projectedTotal: numeric('projected_total'),
  exchangeRate: numeric('exchange_rate'),

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

export const contactsRelations = relations(contacts, ({ one }) => ({
  subsidiary: one(subsidiaries, { fields: [contacts.subsidiaryId], references: [subsidiaries.id] }),
  currency: one(currencies, { fields: [contacts.currencyId], references: [currencies.id] }),
  customer: one(customers, { fields: [contacts.customerId], references: [customers.id] }),
}));

export const addressesRelations = relations(addresses, ({ one }) => ({
  customer: one(customers, { fields: [addresses.customerId], references: [customers.id] }),
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
  lineItems: many(estimateLineItems),
  createdByUser: one(users, { fields: [estimates.createdBy], references: [users.id] }),
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
  componentKitItem: one(componentKitItems, { fields: [estimateLineItems.componentKitItemId], references: [componentKitItems.id] }),
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
  consolidatedCustomer: one(customers,         { fields: [salesOrderSearch.consolidatedCustomerId], references: [customers.id] }),
  topLevelParent:       one(customers,         { fields: [salesOrderSearch.topLevelParentId],     references: [customers.id] }),
  status:               one(estimateStatuses,  { fields: [salesOrderSearch.statusId],             references: [estimateStatuses.id] }),
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
  consolidatedCustomer: one(customers,         { fields: [invoiceSearch.consolidatedCustomerId], references: [customers.id] }),
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
} as const;

export type MasterEntityKey = keyof typeof MASTER_TABLES;
