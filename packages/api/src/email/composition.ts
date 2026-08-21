import type { EmailSender } from '../ports/email.js';
import { ConsoleEmailSender } from '../ports/email.js';
import type { Metrics } from '../ports/metrics.js';
import { resolveEmailDeliveryConfig } from './config.js';
import { ResendEmailSender } from './resend-email-sender.js';

type Environment = Readonly<Record<string, string | undefined>>;

/** Build the configured sender. Configuration validation deliberately happens before startup. */
export function createEmailSenderFromEnv(
  env: Environment = process.env,
  metrics?: Metrics,
): EmailSender {
  const config = resolveEmailDeliveryConfig(env);
  if (config.provider === 'console') return new ConsoleEmailSender();
  return new ResendEmailSender({
    apiKey: config.apiKey,
    from: config.from,
    publicWebOrigin: config.publicWebOrigin,
    timeoutMs: config.timeoutMs,
    ...(metrics ? { metrics } : {}),
  });
}
