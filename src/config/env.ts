import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';

dotenv.config();

/**
 * Searches for an Apify API token in visible user-friendly files (apify-key.txt, config.json)
 * so users don't have to fiddle with hidden .env files.
 */
export function resolveApifyTokenFromFiles(): string {
  // 1. Check root apify-key.txt
  const keyTxtPath = path.resolve(process.cwd(), 'apify-key.txt');
  if (fs.existsSync(keyTxtPath)) {
    try {
      const raw = fs.readFileSync(keyTxtPath, 'utf-8');
      const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
      if (lines.length > 0 && lines[0] && !lines[0].includes('PASTE_YOUR_APIFY_TOKEN_HERE')) {
        return lines[0];
      }
    } catch {
      // ignore read error
    }
  }

  // 2. Check root config.json
  const configJsonPath = path.resolve(process.cwd(), 'config.json');
  if (fs.existsSync(configJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8'));
      const candidate = (parsed.APIFY_TOKEN || parsed.apifyToken || parsed.token || '').trim();
      if (candidate && !candidate.includes('PASTE_YOUR_APIFY_TOKEN_HERE')) {
        return candidate;
      }
    } catch {
      // ignore parse error
    }
  }

  return '';
}

/**
 * Persists an Apify key to apify-key.txt so non-technical users can see and update it easily.
 */
export function saveApifyKey(token: string): void {
  const cleanToken = token.trim();
  const keyTxtPath = path.resolve(process.cwd(), 'apify-key.txt');
  const content = `# ==============================================================================
# REEL RADAR — APIFY API KEY CONFIGURATION
# ==============================================================================
# You can update this token at any time.
${cleanToken}
`;
  fs.writeFileSync(keyTxtPath, content, 'utf-8');
  process.env.APIFY_TOKEN = cleanToken;
}

const EnvSchema = z.object({
  APIFY_TOKEN: z.string().optional().default(''),
  APIFY_REEL_ACTOR_ID: z.string().min(1).default('apify/instagram-reel-scraper'),
  APIFY_DISCOVERY_ACTOR_ID: z.string().min(1).default('apify/instagram-hashtag-scraper'),
  DATABASE_PATH: z.string().min(1).default('./data/reel-radar.sqlite'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(20).default(2),
  DEFAULT_RESULTS_PER_PROFILE: z.coerce.number().int().min(1).max(200).default(20),
  DEFAULT_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  MIN_VIDEOS_FOR_BASELINE: z.coerce.number().int().min(2).max(100).default(5),
  BASELINE_FLOOR_VIEWS: z.coerce.number().min(1).default(500),
  RECENCY_HALF_LIFE_DAYS: z.coerce.number().min(1).default(14),
  CACHE_TTL_MINUTES: z.coerce.number().min(0).default(60),
  MAX_DISCOVERY_DEPTH: z.coerce.number().int().min(1).max(5).default(1),
  MAX_NEW_ACCOUNTS_PER_RUN: z.coerce.number().int().min(1).max(100).default(10),
  MAX_TOTAL_ACCOUNTS_PER_NICHE: z.coerce.number().int().min(1).max(1000).default(50),
  MAX_DAILY_ESTIMATED_SPEND_USD: z.coerce.number().min(0.1).default(5.0),
  AUTO_APPROVE_CANDIDATES: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  LLM_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  OPENAI_API_KEY: z.string().optional().default(''),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  TRANSCRIPT_PROVIDER: z.enum(['none', 'mock', 'openai-whisper']).default('none'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(envSource: Record<string, string | undefined> = process.env): AppConfig {
  const mergedSource = { ...envSource };
  if (!mergedSource.APIFY_TOKEN || mergedSource.APIFY_TOKEN.trim() === '') {
    const fileToken = resolveApifyTokenFromFiles();
    if (fileToken) {
      mergedSource.APIFY_TOKEN = fileToken;
    }
  }

  const result = EnvSchema.safeParse(mergedSource);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration detected in environment variables:\n${errors}\n\nPlease inspect your .env file against .env.example.`
    );
  }
  return {
    ...result.data,
    DATABASE_PATH: path.resolve(result.data.DATABASE_PATH),
  };
}

export function requireApifyCredentials(config: AppConfig): string {
  const token = config.APIFY_TOKEN?.trim() || resolveApifyTokenFromFiles();
  if (!token) {
    throw new Error(
      'Missing Apify API Key.\nTo run live Apify scraping, you can simply:\n  1. Paste your key into "apify-key.txt" in this folder\n  2. Or click the "Set Apify Key" button in the Web UI\n  3. Or set APIFY_TOKEN in .env\nGet your key from: https://console.apify.com/account/integrations'
    );
  }
  return token;
}
