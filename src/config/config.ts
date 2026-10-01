import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().or(z.literal('')),

  OPENAI_API_KEY: z.string().optional().or(z.literal('')),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),

  OWNER_WHATSAPP_NUMBERS: z.string().optional().or(z.literal('')),
  ADMIN_WHATSAPP_NUMBERS: z.string().optional().or(z.literal('')),

  WHATSAPP_AUTH_DIR: z.string().default('./auth'),
  WHATSAPP_ENABLED: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value === '' ? true : value.toLowerCase() === 'true',
    ),
  WHATSAPP_RECONNECT_BASE_MS: z.coerce.number().int().positive().default(2000),
  WHATSAPP_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(60_000),

  APP_VERSION: z.string().optional().or(z.literal('')),
});

function parseNumberList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  const supabaseConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  const openaiConfigured = Boolean(env.OPENAI_API_KEY);

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    appVersion: env.APP_VERSION || (process.env.npm_package_version ?? '0.0.0'),

    supabase: {
      url: env.SUPABASE_URL || undefined,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || undefined,
      configured: supabaseConfigured,
    },

    openai: {
      apiKey: env.OPENAI_API_KEY || undefined,
      model: env.OPENAI_MODEL,
      configured: openaiConfigured,
    },

    whatsapp: {
      enabled: env.WHATSAPP_ENABLED,
      authDir: env.WHATSAPP_AUTH_DIR,
      reconnectBaseMs: env.WHATSAPP_RECONNECT_BASE_MS,
      reconnectMaxMs: env.WHATSAPP_RECONNECT_MAX_MS,
    },

    authorization: {
      ownerNumbers: parseNumberList(env.OWNER_WHATSAPP_NUMBERS),
      adminNumbers: parseNumberList(env.ADMIN_WHATSAPP_NUMBERS),
    },
  } as const;
}

export type AppConfig = ReturnType<typeof loadConfig>;

export const config: AppConfig = loadConfig();
