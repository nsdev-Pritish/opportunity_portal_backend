/**
 * List Routes — Sub-router
 * Base prefix: /api/v1/netsuite/list
 *
 *  /quarters           → quarters.ts
 *  /forecast-statuses  → forecastStatuses.ts
 *  /employees          → employees.ts
 */

import { FastifyInstance } from 'fastify';
import quarterRoutes        from './quarters.js';
import forecastStatusRoutes from './forecastStatuses.js';
import employeeListRoutes   from './employees.js';

export default async function listRoutes(app: FastifyInstance) {
  await app.register(quarterRoutes,        { prefix: '/quarters' });
  await app.register(forecastStatusRoutes, { prefix: '/forecast-statuses' });
  await app.register(employeeListRoutes,   { prefix: '/employees' });
}
