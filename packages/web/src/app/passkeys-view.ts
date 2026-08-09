/**
 * DOM rendering for the passkeys section.
 *
 * Uses the standard `.panel-list`/`.panel-row` composition and `renderEmpty` helper.
 */
import type { PasskeyView } from '../api/models.js';
import { appendPanelRow, renderEmpty } from './render-helpers.js';

export function renderPasskeys(
  container: HTMLElement,
  passkeys: readonly PasskeyView[],
  onDelete: (id: string) => void,
  busy: boolean,
): void {
  container.innerHTML = '';
  if (passkeys.length === 0) {
    renderEmpty(container, {
      title: 'No passkeys registered yet',
      body: 'Add a passkey for fast, passwordless sign-in.',
      inline: true,
    });
    return;
  }

  for (const passkey of passkeys) {
    const createdDate = passkey.createdAt.slice(0, 10);
    const label = `${passkey.name || 'Passkey'} (${createdDate})`;
    appendPanelRow(
      container,
      label,
      [{ label: 'Delete', run: () => onDelete(passkey.id) }],
      busy,
    );
  }
}
