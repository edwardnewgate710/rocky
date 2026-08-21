export type EmailDeliveryConfig =
  | { readonly provider: 'console' }
  | {
      readonly provider: 'resend';
      readonly apiKey: string;
      readonly from: string;
      readonly publicWebOrigin: string;
      readonly timeoutMs: number;
    };

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const SINGLE_EMAIL = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Resend email delivery`);
  return value;
}

function publicWebOrigin(raw: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PUBLIC_WEB_ORIGIN must be an absolute http/https origin');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_WEB_ORIGIN must use http or https');
  }
  if (production && url.protocol !== 'https:') {
    throw new Error('PUBLIC_WEB_ORIGIN must use https in production');
  }
  if (url.username || url.password) throw new Error('PUBLIC_WEB_ORIGIN must not contain credentials');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_WEB_ORIGIN must not contain a path, query, or fragment');
  }
  return url.origin;
}

function timeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 100 || value > MAX_TIMEOUT_MS) {
    throw new Error(`EMAIL_TIMEOUT_MS must be an integer between 100 and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

export function resolveEmailDeliveryConfig(env: Environment = process.env): EmailDeliveryConfig {
  const production = env['NODE_ENV'] === 'production';
  const provider = env['EMAIL_PROVIDER']?.trim().toLowerCase();
  if (!provider) throw new Error('EMAIL_PROVIDER is required');
  if (provider === 'console') {
    if (production) throw new Error('EMAIL_PROVIDER must be "resend" in production');
    return { provider: 'console' };
  }
  if (provider !== 'resend') throw new Error('EMAIL_PROVIDER must be "resend" or "console"');

  const from = required(env, 'EMAIL_FROM');
  if (!SINGLE_EMAIL.test(from)) throw new Error('EMAIL_FROM must be one plain email address');

  return {
    provider: 'resend',
    apiKey: required(env, 'RESEND_API_KEY'),
    from,
    publicWebOrigin: publicWebOrigin(required(env, 'PUBLIC_WEB_ORIGIN'), production),
    timeoutMs: timeoutMs(env['EMAIL_TIMEOUT_MS']),
  };
}
