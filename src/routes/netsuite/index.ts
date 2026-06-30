/**
 * NetSuite Routes — Main Index
 * Base prefix: /api/v1/netsuite
 * Auth: X-API-Key header on every request.
 *
 * Every record type has its OWN file and its OWN URL.
 *
 * PRIMARY INFORMATION (primary/)
 * primary/customers.ts    → /customers
 * primary/projectNames.ts → /project-names
 * primary/projectTypes.ts → /project-types
 * primary/likelyToClose.ts → /likely-to-close
 * primary/contacts.ts     → /contacts
 * primary/currencies.ts   → /currencies
 *
 * CLASSIFICATION (classification/)
 * classification/departments.ts          → /departments
 * classification/salesChannels.ts        → /sales-channels
 * classification/businessVerticals.ts    → /business-verticals
 * classification/businessTypes.ts        → /business-types
 * classification/hkPartners.ts           → /hk-partners
 * classification/opsPartners.ts          → /ops-partners
 * classification/compliancePartners.ts   → /compliance-partners
 * classification/accountManager.ts       → /account-managers
 * classification/productDeveloper.ts     → /product-developers
 *
 * CLIENT SHIPPING & BILLING (client-shipping-billing/)
 * client-shipping-billing/billingAddresses.ts    → /client-billing-addresses
 * client-shipping-billing/shippingAddresses.ts   → /client-shipping-addresses
 * client-shipping-billing/clientIncoterms.ts     → /client-incoterms
 * client-shipping-billing/clientShippingMethods.ts → /client-shipping-methods
 *
 * FREIGHT COST (freight-cost/)
 * freight-cost/lclRates.ts        → /freight-cost/lcl-rates
 * freight-cost/fclRates.ts        → /freight-cost/fcl-rates
 * freight-cost/airRates.ts        → /freight-cost/air-rates
 * freight-cost/additionalFees.ts  → /freight-cost/additional-fees
 *
 * OTHER FILES
 * subsidiaries.ts         → /subsidiaries
 * vendors.ts              → /vendors
 * employees.ts            → /employees
 * incoterms.ts            → /incoterms
 * shippingMethods.ts      → /shipping-methods
 * itemTypes.ts            → /item-types
 * productClasses.ts       → /product-classes
 * sustainabilityOptions.ts        → /sustainability-options
 * shippingGroups.ts              → /shipping-groups
 * closedLostReasons.ts           → /closed-lost-reasons
 * clientPursuitAlternatives.ts   → /client-pursuit-alternatives
 * estimateStatuses.ts            → /estimate-statuses
 * estimates.ts                   → /estimates
 * lineItems.ts            → /estimates/:nsId/line-items
 */

import { FastifyInstance } from 'fastify';
import { apiKeyAuth } from '../../middleware/apiKeyAuth.js';

import subsidiaryRoutes         from './subsidiaries.js';
import vendorRoutes             from './vendors.js';
import employeeRoutes           from './employees.js';
import departmentRoutes         from './classification/departments.js';
import salesChannelRoutes       from './classification/salesChannels.js';
import businessVerticalRoutes   from './classification/businessVerticals.js';
import businessTypeRoutes       from './classification/businessTypes.js';
import hkPartnerRoutes          from './classification/hkPartners.js';
import opsPartnerRoutes         from './classification/opsPartners.js';
import compliancePartnerRoutes  from './classification/compliancePartners.js';
import accountManagerRoutes     from './classification/accountManager.js';
import productDeveloperRoutes   from './classification/productDeveloper.js';
import itemTypeRoutes           from './itemTypes.js';
import productClassRoutes       from './productClasses.js';
import sustainabilityRoutes     from './sustainabilityOptions.js';
import shippingGroupRoutes             from './shippingGroups.js';
import closedLostReasonRoutes          from './closedLostReasons.js';
import clientPursuitAlternativeRoutes  from './clientPursuitAlternatives.js';
import estimateStatusRoutes            from './estimateStatuses.js';
import obcPodRegionRoutes              from './obcPodRegions.js';
import estimateNsRoutes                from './estimates.js';
import lineItemNsRoutes                from './lineItems.js';
import estimateQuoteNsRoutes           from './estimateQuotes.js';

// Primary Information imports
import customerRoutes           from './primary/customers.js';
import projectNameRoutes        from './primary/projectNames.js';
import projectTypeRoutes        from './primary/projectTypes.js';
import likelyToCloseRoutes      from './primary/likelyToClose.js';
import contactRoutes            from './primary/contacts.js';
import currencyRoutes           from './primary/currencies.js';

// Client Shipping & Billing imports
import billingAddressRoutes         from './client-shipping-billing/billingAddresses.js';
import shippingAddressRoutes        from './client-shipping-billing/shippingAddresses.js';
import clientIncotermRoutes         from './client-shipping-billing/clientIncoterms.js';
import clientShippingMethodRoutes   from './client-shipping-billing/clientShippingMethods.js';

// List imports (Quarter / Forecast Status / Employee)
import listRoutes from './list/index.js';

// Cost Sheet imports
import costSheetRoutes from './cost-sheet/index.js';

// Freight Cost imports
import freightCostRoutes from './freight-cost/index.js';

export default async function netsuiteRoutes(app: FastifyInstance) {
  // app.addHook('preHandler', apiKeyAuth);

  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  await app.register(subsidiaryRoutes,        { prefix: '/subsidiaries' });
  await app.register(customerRoutes,          { prefix: '/customers' });
  await app.register(contactRoutes,           { prefix: '/contacts' });
  await app.register(vendorRoutes,            { prefix: '/vendors' });
  await app.register(employeeRoutes,          { prefix: '/employees' });
  await app.register(currencyRoutes,          { prefix: '/currencies' });
  await app.register(departmentRoutes,        { prefix: '/departments' });
  await app.register(salesChannelRoutes,      { prefix: '/sales-channels' });
  await app.register(businessVerticalRoutes,  { prefix: '/business-verticals' });
  await app.register(businessTypeRoutes,      { prefix: '/business-types' });
  await app.register(projectNameRoutes,       { prefix: '/project-names' });
  await app.register(projectTypeRoutes,       { prefix: '/project-types' });
  await app.register(likelyToCloseRoutes,     { prefix: '/likely-to-close' });
  await app.register(hkPartnerRoutes,         { prefix: '/hk-partners' });
  await app.register(opsPartnerRoutes,        { prefix: '/ops-partners' });
  await app.register(compliancePartnerRoutes, { prefix: '/compliance-partners' });
  await app.register(accountManagerRoutes,    { prefix: '/account-managers' });
  await app.register(productDeveloperRoutes,  { prefix: '/product-developers' });
  await app.register(itemTypeRoutes,          { prefix: '/item-types' });
  await app.register(productClassRoutes,      { prefix: '/product-classes' });
  await app.register(sustainabilityRoutes,    { prefix: '/sustainability-options' });
  await app.register(shippingGroupRoutes,             { prefix: '/shipping-groups' });
  await app.register(closedLostReasonRoutes,          { prefix: '/closed-lost-reasons' });
  await app.register(clientPursuitAlternativeRoutes,  { prefix: '/client-pursuit-alternatives' });
  await app.register(estimateStatusRoutes,            { prefix: '/estimate-statuses' });
  await app.register(obcPodRegionRoutes,              { prefix: '/obc-pod-regions' });
  await app.register(estimateNsRoutes,                { prefix: '/estimates' });
  await app.register(lineItemNsRoutes,        { prefix: '/estimates/:nsId/line-items' });
  await app.register(estimateQuoteNsRoutes,   { prefix: '/estimate-quotes' });

  // Client Shipping & Billing
  await app.register(billingAddressRoutes,        { prefix: '/client-billing-addresses' });
  await app.register(shippingAddressRoutes,        { prefix: '/client-shipping-addresses' });
  await app.register(clientIncotermRoutes,          { prefix: '/client-incoterms' });
  await app.register(clientShippingMethodRoutes,    { prefix: '/client-shipping-methods' });

  // List (Quarter / Forecast Status / Employee)
  await app.register(listRoutes, { prefix: '/list' });

  // Cost Sheet
  await app.register(costSheetRoutes, { prefix: '/cost-sheet' });

  // Freight Cost
  await app.register(freightCostRoutes, { prefix: '/freight-cost' });
}
