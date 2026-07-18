/**
 * @packageDocumentation
 * The email sender port for outbound messaging (e.g. password reset, email verification).
 */

export interface EmailSender {
  sendPasswordReset(to: string, token: string): Promise<void>;
  sendEmailVerification(to: string, token: string): Promise<void>;
}

export class InMemoryEmailSender implements EmailSender {
  public readonly sent: { to: string; token: string; type: 'password_reset' | 'email_verify' }[] = [];

  async sendPasswordReset(to: string, token: string): Promise<void> {
    this.sent.push({ to, token, type: 'password_reset' });
  }

  async sendEmailVerification(to: string, token: string): Promise<void> {
    this.sent.push({ to, token, type: 'email_verify' });
  }
}

export class ConsoleEmailSender implements EmailSender {
  async sendPasswordReset(to: string, token: string): Promise<void> {
    console.log(`[EMAIL] Password Reset sent to ${to}. Token: ${token}`);
  }

  async sendEmailVerification(to: string, token: string): Promise<void> {
    console.log(`[EMAIL] Email Verification sent to ${to}. Token: ${token}`);
  }
}
