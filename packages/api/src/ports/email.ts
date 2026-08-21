/**
 * @packageDocumentation
 * The email sender port for outbound messaging (e.g. password reset, email verification).
 */

export type EmailDeliveryOutcome =
  | 'success'
  | 'suppressed'
  | 'timeout'
  | 'provider_rejected'
  | 'provider_throttled'
  | 'provider_error';

export interface EmailDeliveryResult {
  readonly outcome: EmailDeliveryOutcome;
}

export interface EmailSender {
  sendPasswordReset(to: string, token: string): Promise<EmailDeliveryResult>;
  sendEmailVerification(to: string, token: string): Promise<EmailDeliveryResult>;
}

export class InMemoryEmailSender implements EmailSender {
  public readonly sent: { to: string; token: string; type: 'password_reset' | 'email_verify' }[] = [];

  async sendPasswordReset(to: string, token: string): Promise<EmailDeliveryResult> {
    this.sent.push({ to, token, type: 'password_reset' });
    return { outcome: 'success' };
  }

  async sendEmailVerification(to: string, token: string): Promise<EmailDeliveryResult> {
    this.sent.push({ to, token, type: 'email_verify' });
    return { outcome: 'success' };
  }
}

export class ConsoleEmailSender implements EmailSender {
  async sendPasswordReset(_to: string, _token: string): Promise<EmailDeliveryResult> {
    // Deliberately no recipient, token, or completed URL. Console delivery is a development-only
    // wiring check, not a mailbox; use InMemoryEmailSender when a test needs the raw token.
    // eslint-disable-next-line no-console
    console.log('[EMAIL:DEV] password_reset delivery suppressed');
    return { outcome: 'suppressed' };
  }

  async sendEmailVerification(_to: string, _token: string): Promise<EmailDeliveryResult> {
    // eslint-disable-next-line no-console
    console.log('[EMAIL:DEV] email_verify delivery suppressed');
    return { outcome: 'suppressed' };
  }
}
