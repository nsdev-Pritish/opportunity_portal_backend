import pino from 'pino';

// Logger configuration for Fastify
export const loggerConfig = {
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
  base: { service: 'prism-backend' },
  redact: ['req.headers.authorization', '*.password', '*.passwordHash'],
};

// Standalone logger instance for non-Fastify code
export const logger = pino(loggerConfig);
