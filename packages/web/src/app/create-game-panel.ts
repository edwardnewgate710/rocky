/**
 * Create-a-game panel — the lobby's focused Web V1 seek builder.
 *
 * The collapsed trigger opens one short form: four approved time controls,
 * Casual/Rated, and a single Create seek action. The component owns only DOM
 * and form state; the lobby wiring remains responsible for the network request.
 */
import type { TimeControl } from '../api/models.js';
import type { KeyValueStorage } from '../net/session.js';
import {
  CREATE_GAME_PRESETS,
  DEFAULT_PRESET_ID,
  presetToTimeControl,
} from './time-presets.js';
import {
  PREFS_STORAGE_KEY,
  parseCreateGamePrefs,
  serializeCreateGamePrefs,
  type CreateGamePrefs,
  type SeekMode,
} from './create-game-prefs.js';
import { el } from './dom.js';

/** The validated settings sent through the existing seek-creation path. */
export interface CreateGameParams {
  readonly variant: 'standard';
  readonly timeControl: TimeControl;
  readonly rated: boolean;
}

export interface CreateGamePanelCallbacks {
  /** Post the seek. Resolve true when created, false when the form should stay open. */
  onSubmit: (params: CreateGameParams) => Promise<boolean>;
  /** Surface an action error, or clear it with null. */
  onError: (message: string | null) => void;
}

export interface CreateGamePanelOptions {
  readonly doc: Document;
  readonly mount: HTMLElement;
  readonly callbacks: CreateGamePanelCallbacks;
  readonly initialAuthenticated?: boolean;
  /** Persists the last successful V1 time control and mode. */
  readonly storage?: KeyValueStorage;
}

export class CreateGamePanel {
  private readonly doc: Document;
  private readonly callbacks: CreateGamePanelCallbacks;
  private readonly trigger: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly submitBtn: HTMLButtonElement;
  private readonly storage: KeyValueStorage | undefined;

  private expanded = false;
  private pending = false;

  constructor(opts: CreateGamePanelOptions) {
    this.doc = opts.doc;
    this.callbacks = opts.callbacks;
    this.storage = opts.storage;
    const prefs = this.readPrefs();
    this.trigger = this.createTrigger();
    this.submitBtn = el(this.doc, 'button', { type: 'submit', class: 'cg-submit' });
    this.submitBtn.textContent = 'Create seek';
    const cancelBtn = el(this.doc, 'button', { type: 'button', class: 'cg-cancel' });
    cancelBtn.textContent = 'Cancel';
    this.form = el(this.doc, 'form', {
      id: 'create-game-form',
      class: 'cg-form',
      'aria-label': 'Create a game',
      hidden: '',
    });
    this.form.append(
      this.createTimeField(prefs?.time ?? DEFAULT_PRESET_ID),
      this.createModeField(prefs?.mode ?? 'casual'),
      el(this.doc, 'div', { class: 'cg-actions' }, this.submitBtn, cancelBtn),
    );
    this.bindEvents(cancelBtn);
    opts.mount.replaceChildren(this.trigger, this.form);
    this.setAuthenticated(opts.initialAuthenticated ?? false);
  }

  private createTrigger(): HTMLButtonElement {
    const trigger = el(this.doc, 'button', {
      id: 'create-seek',
      type: 'button',
      class: 'cg-trigger',
      'aria-expanded': 'false',
      'aria-controls': 'create-game-form',
    });
    trigger.textContent = 'Create a game';
    return trigger;
  }

  private createTimeField(initialTimeId: string): HTMLFieldSetElement {
    const presets = el(this.doc, 'div', { class: 'cg-presets' });
    for (const preset of CREATE_GAME_PRESETS) {
      presets.append(this.radio('cg-time', preset.id, preset.id, preset.id === initialTimeId));
    }
    return el(
      this.doc,
      'fieldset',
      { class: 'cg-field' },
      el(this.doc, 'legend', {}, 'Time'),
      presets,
    );
  }

  private createModeField(initialMode: SeekMode): HTMLFieldSetElement {
    const modeHint = el(
      this.doc,
      'p',
      { class: 'cg-hint', id: 'cg-mode-hint' },
      'Rated games affect your rating; casual games don’t.',
    );
    const modes = el(
      this.doc,
      'div',
      { class: 'cg-segmented' },
      this.radio('cg-mode', 'casual', 'Casual', initialMode === 'casual'),
      this.radio('cg-mode', 'rated', 'Rated', initialMode === 'rated'),
    );
    const modeField = el(
      this.doc,
      'fieldset',
      { class: 'cg-field' },
      el(this.doc, 'legend', {}, 'Mode'),
      modes,
      modeHint,
    );
    for (const radio of modes.querySelectorAll<HTMLInputElement>('input[name="cg-mode"]')) {
      radio.setAttribute('aria-describedby', 'cg-mode-hint');
    }
    return modeField;
  }

  private bindEvents(cancelBtn: HTMLButtonElement): void {
    this.trigger.addEventListener('click', () => this.setExpanded(true));
    cancelBtn.addEventListener('click', () => this.setExpanded(false));
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.form.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.pending) return;
      event.preventDefault();
      this.setExpanded(false);
    });
  }

  private radio(
    name: 'cg-time' | 'cg-mode',
    value: string,
    label: string,
    checked: boolean,
  ): HTMLLabelElement {
    const className = name === 'cg-time' ? 'cg-chip' : 'cg-seg';
    const input = el(this.doc, 'input', { type: 'radio', name, value });
    if (checked) input.checked = true;
    return el(
      this.doc,
      'label',
      { class: className },
      input,
      el(this.doc, 'span', { class: className === 'cg-chip' ? 'cg-chip-label' : 'cg-seg-label' }, label),
    );
  }

  private readChecked(name: string): string | null {
    return this.form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? null;
  }

  private gather(): CreateGameParams {
    const selected = this.readChecked('cg-time');
    const preset =
      CREATE_GAME_PRESETS.find((candidate) => candidate.id === selected) ??
      CREATE_GAME_PRESETS.find((candidate) => candidate.id === DEFAULT_PRESET_ID)!;

    return {
      variant: 'standard',
      timeControl: presetToTimeControl(preset.minutes, preset.increment),
      rated: this.readChecked('cg-mode') === 'rated',
    };
  }

  private readPrefs(): CreateGamePrefs | null {
    if (!this.storage) return null;
    try {
      return parseCreateGamePrefs(this.storage.getItem(PREFS_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  private savePrefs(): void {
    if (!this.storage) return;
    const selected = this.readChecked('cg-time');
    const preset = CREATE_GAME_PRESETS.find((candidate) => candidate.id === selected);
    const prefs: CreateGamePrefs = {
      time: preset?.id ?? DEFAULT_PRESET_ID,
      mode: this.readChecked('cg-mode') === 'rated' ? 'rated' : 'casual',
    };
    try {
      this.storage.setItem(PREFS_STORAGE_KEY, serializeCreateGamePrefs(prefs));
    } catch {
      // Storage can be unavailable in private browsing; seek creation still succeeds.
    }
  }

  private async submit(): Promise<void> {
    if (this.pending) return;
    this.callbacks.onError(null);
    this.setPending(true);
    try {
      const created = await this.callbacks.onSubmit(this.gather());
      if (created) {
        this.savePrefs();
        this.setExpanded(false);
      }
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error.message : String(error));
    } finally {
      this.setPending(false);
    }
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.trigger.setAttribute('aria-expanded', String(expanded));
    this.trigger.hidden = expanded;
    this.form.hidden = !expanded;
    if (expanded) {
      this.form.querySelector<HTMLInputElement>('input[name="cg-time"]:checked')?.focus();
    } else {
      this.callbacks.onError(null);
      if (!this.trigger.disabled) this.trigger.focus();
    }
  }

  setAuthenticated(authenticated: boolean): void {
    this.trigger.disabled = !authenticated;
    this.trigger.title = authenticated ? '' : 'Sign in to create a seek';
    if (!authenticated && this.expanded) this.setExpanded(false);
  }

  setPending(pending: boolean): void {
    this.pending = pending;
    this.submitBtn.disabled = pending;
    this.submitBtn.textContent = pending ? 'Creating…' : 'Create seek';
  }

}
