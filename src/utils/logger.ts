import pino from 'pino';

export function createLogger(level: string = process.env.LOG_LEVEL || 'info') {
  return pino({
    level,
    redact: {
      paths: [
        'apifyToken',
        'APIFY_TOKEN',
        'OPENAI_API_KEY',
        'token',
        'authorization',
        '*.videoUrl',
        '*.mediaUrl',
      ],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const logger = createLogger();
