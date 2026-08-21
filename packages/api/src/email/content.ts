export type EmailPurpose = 'password_reset' | 'email_verify';

export interface EmailContent {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly url: string;
}

function link(origin: string, path: string, token: string): string {
  return `${origin}${path}#token=${encodeURIComponent(token)}`;
}

function htmlLink(url: string, label: string): string {
  return `<p><a href="${url}">${label}</a></p>`;
}

export function buildEmailContent(
  purpose: EmailPurpose,
  publicWebOrigin: string,
  token: string,
): EmailContent {
  if (purpose === 'password_reset') {
    const url = link(publicWebOrigin, '/password-reset', token);
    return {
      subject: 'Reset your Shatarang password',
      text: `Use this link to reset your Shatarang password. It expires in 30 minutes.\n\n${url}`,
      html: `<p>Use this link to reset your Shatarang password. It expires in 30 minutes.</p>${htmlLink(url, 'Reset password')}`,
      url,
    };
  }

  const url = link(publicWebOrigin, '/email-verify', token);
  return {
    subject: 'Verify your Shatarang email address',
    text: `Use this link to verify your Shatarang email address.\n\n${url}`,
    html: `<p>Use this link to verify your Shatarang email address.</p>${htmlLink(url, 'Verify email')}`,
    url,
  };
}
