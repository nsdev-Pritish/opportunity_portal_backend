# PRISM Backend

**OBC Commercialization Platform — Backend API**

---

## How It Works

```
NetSuite (SuiteScript calls our APIs)    PRISM Backend         PostgreSQL
  POST /netsuite/customers  ──────────►  saves customer  ────► DB
  POST /netsuite/estimates  ──────────►  saves estimate  ────► DB
  PUT  /netsuite/customers/123  ───────►  updates         ────► DB

Portal UI (reads through JWT-protected routes)
  GET /master/customers  ◄────────────  reads from DB  ◄──── DB
  GET /estimates         ◄────────────  reads from DB  ◄──── DB
```

---

## Quick Start

### 1. Install
```bash
npm install
```

### 2. Configure
```bash
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, and NS_API_KEY
```

Generate `NS_API_KEY`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
**Give this key to your NetSuite integration team.** They add it as a header in every SuiteScript request:
```javascript
request.setHeader('X-API-Key', 'your-key-here');
```

### 3. Start infrastructure
```bash
docker-compose up postgres redis -d
```

### 4. Run migrations
```bash
npm run db:generate
npm run db:migrate
```

### 5. Start server
```bash
npm run dev          # development (hot reload)
npm run build && npm start   # production
```

---

## API Overview

### NetSuite Routes `/api/v1/netsuite/*`
Auth: `X-API-Key` header

Every record type has its own file and its own URL. Each supports:
- `GET /` — list active records
- `GET /:nsId` — single record
- `POST /` — create (idempotent)
- `PUT /:nsId` — update
- `PATCH /:nsId/status` — activate/deactivate

| URL | File |
|-----|------|
| `/netsuite/customers` | `customers.ts` |
| `/netsuite/contacts` | `contacts.ts` |
| `/netsuite/vendors` | `vendors.ts` |
| `/netsuite/employees` | `employees.ts` |
| `/netsuite/currencies` | `currencies.ts` |
| `/netsuite/departments` | `departments.ts` |
| `/netsuite/sales-channels` | `salesChannels.ts` |
| `/netsuite/business-verticals` | `businessVerticals.ts` |
| `/netsuite/business-types` | `businessTypes.ts` |
| `/netsuite/project-types` | `projectTypes.ts` |
| `/netsuite/likely-to-close` | `likelyToClose.ts` |
| `/netsuite/hk-partners` | `hkPartners.ts` |
| `/netsuite/ops-partners` | `opsPartners.ts` |
| `/netsuite/compliance-partners` | `compliancePartners.ts` |
| `/netsuite/incoterms` | `incoterms.ts` |
| `/netsuite/shipping-methods` | `shippingMethods.ts` |
| `/netsuite/item-types` | `itemTypes.ts` |
| `/netsuite/product-classes` | `productClasses.ts` |
| `/netsuite/sustainability-options` | `sustainabilityOptions.ts` |
| `/netsuite/shipping-groups` | `shippingGroups.ts` |
| `/netsuite/estimates` | `estimates.ts` |
| `/netsuite/estimates/:nsId/line-items` | `lineItems.ts` |

### Portal Routes `/api/v1/*`
Auth: `Authorization: Bearer <JWT token>`

- `POST /auth/register` — register portal user
- `POST /auth/login` — login, get JWT
- `GET /master/:entity` — dropdown data for UI
- `PATCH /master/:entity/:id/status` — activate/deactivate from UI
- `GET /estimates` — list estimates
- `POST /estimates` — create from portal
- `GET /estimates/:id` — single estimate
- `PATCH /estimates/:id` — update from portal

---

## Key Rules for NetSuite Developer

**Always send `netsuiteInternalId`** (the NS internalId of the record):
```json
POST /api/v1/netsuite/customers
{ "netsuiteInternalId": "1234", "name": "Acme Corp", "email": "x@acme.com" }
```

**Push customers before estimates** — estimates reference customer by `customerNsId`:
```json
POST /api/v1/netsuite/estimates
{ "netsuiteInternalId": "EST-001", "projectName": "Q3", "customerNsId": "1234" }
```

**Idempotent** — calling POST twice with same `netsuiteInternalId` updates, does not duplicate.

**Deactivate** with status route:
```json
PATCH /api/v1/netsuite/customers/1234/status
{ "isActive": false }
```
