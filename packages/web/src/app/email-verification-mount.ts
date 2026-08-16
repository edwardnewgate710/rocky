import type { GambitClient } from '../api/client.js';
import { EmailVerificationController } from './email-verification-controller.js';
import type { EmailVerificationCallbacks } from './email-verification-controller.js';

interface EmailVerificationElements {
  readonly section: HTMLElement | null;
  readonly status: HTMLElement | null;
  readonly error: HTMLElement | null;
  readonly retry: HTMLButtonElement | null;
}

interface EmailVerificationState {
  token: string | null;
}

export interface EmailVerificationMountOptions {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly verificationToken: string | null;
}

function emailVerificationElements(doc: Document): EmailVerificationElements {
  return {
    section: doc.getElementById('email-verify'),
    status: doc.getElementById('email-verify-status'),
    error: doc.getElementById('email-verify-error'),
    retry: doc.getElementById('email-verify-retry') as HTMLButtonElement | null,
  };
}

function setEmailVerificationPending(elements: EmailVerificationElements, pending: boolean): void {
  if (elements.retry) elements.retry.disabled = pending;
  if (elements.section) elements.section.setAttribute('aria-busy', String(pending));
  if (elements.status && pending) {
    elements.status.textContent = 'Verifying your email address...';
  }
}

function resetEmailVerificationSurface(elements: EmailVerificationElements): void {
  if (elements.status) elements.status.textContent = '';
  if (elements.error) elements.error.textContent = '';
  if (elements.retry) elements.retry.hidden = true;
  setEmailVerificationPending(elements, false);
}

function createEmailVerificationCallbacks(
  elements: EmailVerificationElements,
  state: EmailVerificationState,
): EmailVerificationCallbacks {
  let wasRetryable = false;

  return {
    onPending: (pending) => {
      setEmailVerificationPending(elements, pending);
      if (pending) {
        wasRetryable = false;
        if (elements.error) elements.error.textContent = '';
      } else if (!wasRetryable) {
        state.token = null;
      }
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message ?? '';
      if (message && elements.status) {
        elements.status.textContent = '';
      }
    },
    onSuccess: (message) => {
      if (message) {
        if (elements.status) elements.status.textContent = message;
        if (elements.error) elements.error.textContent = '';
        state.token = null;
      }
    },
    onRetryable: (retryable) => {
      wasRetryable = retryable;
      if (elements.retry) elements.retry.hidden = !retryable;
    },
  };
}

function bindEmailVerificationActions(
  elements: EmailVerificationElements,
  state: EmailVerificationState,
  controller: EmailVerificationController,
): void {
  if (elements.retry) {
    elements.retry.onclick = () => {
      if (!state.token) return;
      void controller.verify(state.token);
    };
  }
}

function disposeEmailVerificationMount(
  elements: EmailVerificationElements,
  state: EmailVerificationState,
  controller: EmailVerificationController,
): void {
  if (elements.retry) elements.retry.onclick = null;
  controller.dispose();
  state.token = null;
  setEmailVerificationPending(elements, false);
}

export function mountEmailVerification(
  options: EmailVerificationMountOptions,
): { dispose: () => void } {
  let disposed = false;
  const elements = emailVerificationElements(options.doc);
  const state: EmailVerificationState = { token: options.verificationToken };
  resetEmailVerificationSurface(elements);

  const controller = new EmailVerificationController({
    client: options.client,
    callbacks: createEmailVerificationCallbacks(elements, state),
  });
  bindEmailVerificationActions(elements, state, controller);
  void controller.verify(state.token);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disposeEmailVerificationMount(elements, state, controller);
    },
  };
}
