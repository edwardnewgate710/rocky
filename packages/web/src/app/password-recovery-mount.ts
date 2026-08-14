import type { GambitClient } from '../api/client.js';
import { PasswordResetController } from './password-reset-controller.js';
import type { PasswordResetCallbacks } from './password-reset-controller.js';

interface PasswordRecoveryElements {
  readonly requestView: HTMLElement | null;
  readonly confirmView: HTMLElement | null;
  readonly requestForm: HTMLFormElement | null;
  readonly confirmForm: HTMLFormElement | null;
  readonly requestInput: HTMLInputElement | null;
  readonly passwordInput: HTMLInputElement | null;
  readonly passwordConfirmInput: HTMLInputElement | null;
  readonly requestSubmit: HTMLButtonElement | null;
  readonly confirmSubmit: HTMLButtonElement | null;
  readonly status: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface PasswordRecoveryState {
  resetToken: string | null;
}

interface PasswordRecoveryMountOptions {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly resetToken: string | null;
  readonly onSessionInvalidated: () => void;
}

function passwordRecoveryElements(doc: Document): PasswordRecoveryElements {
  return {
    requestView: doc.getElementById('password-reset-request-view'),
    confirmView: doc.getElementById('password-reset-confirm-view'),
    requestForm: doc.getElementById('password-reset-request-form') as HTMLFormElement | null,
    confirmForm: doc.getElementById('password-reset-confirm-form') as HTMLFormElement | null,
    requestInput: doc.getElementById('password-reset-request-input') as HTMLInputElement | null,
    passwordInput: doc.getElementById('password-reset-confirm-password') as HTMLInputElement | null,
    passwordConfirmInput: doc.getElementById('password-reset-confirm-password-confirm') as HTMLInputElement | null,
    requestSubmit: doc.getElementById('password-reset-request-submit') as HTMLButtonElement | null,
    confirmSubmit: doc.getElementById('password-reset-confirm-submit') as HTMLButtonElement | null,
    status: doc.getElementById('password-reset-status'),
    error: doc.getElementById('password-reset-error'),
  };
}

function setPasswordRecoveryPending(elements: PasswordRecoveryElements, pending: boolean): void {
  if (elements.requestSubmit) {
    elements.requestSubmit.disabled = pending;
    elements.requestSubmit.textContent = pending ? 'Sending…' : 'Send reset link';
  }
  if (elements.confirmSubmit) {
    elements.confirmSubmit.disabled = pending;
    elements.confirmSubmit.textContent = pending ? 'Resetting…' : 'Reset password';
  }
  if (elements.requestInput) elements.requestInput.disabled = pending;
  if (elements.passwordInput) elements.passwordInput.disabled = pending;
  if (elements.passwordConfirmInput) elements.passwordConfirmInput.disabled = pending;
  if (elements.requestForm) elements.requestForm.setAttribute('aria-busy', String(pending));
  if (elements.confirmForm) elements.confirmForm.setAttribute('aria-busy', String(pending));
}

function resetPasswordRecoverySurface(
  elements: PasswordRecoveryElements,
  resetToken: string | null,
): void {
  if (elements.requestView) elements.requestView.hidden = resetToken !== null;
  if (elements.confirmView) elements.confirmView.hidden = resetToken === null;
  if (elements.status) elements.status.textContent = '';
  if (elements.error) elements.error.textContent = '';
  setPasswordRecoveryPending(elements, false);
}

function createPasswordResetCallbacks(
  elements: PasswordRecoveryElements,
  state: PasswordRecoveryState,
  onSessionInvalidated: () => void,
): PasswordResetCallbacks {
  return {
    onPending: (pending) => setPasswordRecoveryPending(elements, pending),
    onError: (message) => {
      if (elements.error) elements.error.textContent = message ?? '';
    },
    onSuccess: (message) => {
      if (elements.status) elements.status.textContent = message ?? '';
      if (!message || state.resetToken === null) return;
      state.resetToken = null;
      if (elements.passwordInput) elements.passwordInput.value = '';
      if (elements.passwordConfirmInput) elements.passwordConfirmInput.value = '';
      if (elements.confirmView) elements.confirmView.hidden = true;
    },
    onSessionInvalidated,
  };
}

function bindPasswordRecoveryForms(
  elements: PasswordRecoveryElements,
  state: PasswordRecoveryState,
  controller: PasswordResetController,
): void {
  if (elements.requestForm) {
    elements.requestForm.onsubmit = (event) => {
      event.preventDefault();
      void controller.requestReset(elements.requestInput?.value ?? '');
    };
  }
  if (elements.confirmForm) {
    elements.confirmForm.onsubmit = (event) => {
      event.preventDefault();
      if (!state.resetToken) return;
      void controller.confirmReset(
        state.resetToken,
        elements.passwordInput?.value ?? '',
        elements.passwordConfirmInput?.value ?? '',
      );
    };
  }
}

function disposePasswordRecoveryMount(
  elements: PasswordRecoveryElements,
  controller: PasswordResetController,
): void {
  if (elements.requestForm) elements.requestForm.onsubmit = null;
  if (elements.confirmForm) elements.confirmForm.onsubmit = null;
  controller.dispose();
  setPasswordRecoveryPending(elements, false);
}

export function mountPasswordRecovery(
  options: PasswordRecoveryMountOptions,
): { dispose: () => void } {
  const elements = passwordRecoveryElements(options.doc);
  const state: PasswordRecoveryState = { resetToken: options.resetToken };
  resetPasswordRecoverySurface(elements, state.resetToken);

  const controller = new PasswordResetController({
    client: options.client,
    callbacks: createPasswordResetCallbacks(elements, state, options.onSessionInvalidated),
  });
  bindPasswordRecoveryForms(elements, state, controller);

  return {
    dispose: () => disposePasswordRecoveryMount(elements, controller),
  };
}
