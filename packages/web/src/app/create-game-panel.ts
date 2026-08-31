/**
 * Create-a-game panel — the lobby's focused seek builder.
 *
 * The collapsed trigger opens one short form for time, variant, mode, and color.
 * The component owns only DOM and form state; the lobby wiring remains
 * responsible for the network request.
 */
import {
  OFFERED_VARIANTS,
  SEEK_COLORS,
  type SeekColor,
  type TimeControl,
  type Variant,
} from '../api/models.js';
import type { KeyValueStorage } from '../net/session.js';
import {
  CREATE_GAME_PRESETS,
  CUSTOM_LIMITS,
  CUSTOM_PRESET_ID,
  DEFAULT_PRESET_ID,
  estimateSpeed,
  presetToTimeControl,
  validateCustomTime,
} from './time-presets.js';
import {
  DEFAULT_CREATE_GAME_COLOR,
  DEFAULT_CREATE_GAME_VARIANT,
  PREFS_STORAGE_KEY,
  isOfferedVariant,
  isSeekColor,
  parseCreateGamePrefs,
  serializeCreateGamePrefs,
  type CreateGamePrefs,
  type SeekMode,
} from './create-game-prefs.js';
import { el } from './dom.js';
import { VARIANT_LABELS } from './variant-labels.js';

const CREATE_GAME_COLORS: readonly SeekColor[] = [
  DEFAULT_CREATE_GAME_COLOR,
  ...SEEK_COLORS.filter((color) => color !== DEFAULT_CREATE_GAME_COLOR),
];

const COLOR_LABELS: Record<SeekColor, string> = {
  random: 'Random',
  white: 'White',
  black: 'Black',
};

/** The validated settings sent through the existing seek-creation path. */
export interface CreateGameParams {
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly rated: boolean;
  readonly color: SeekColor;
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
  /** Persists the last successful V3 settings. */
  readonly storage?: KeyValueStorage;
}

export class CreateGamePanel {
  private readonly doc: Document;
  private readonly callbacks: CreateGamePanelCallbacks;
  private readonly trigger: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly submitBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly customFields: HTMLDivElement;
  private readonly customMinutes: HTMLInputElement;
  private readonly customIncrement: HTMLInputElement;
  private readonly customError: HTMLParagraphElement;
  private readonly timeSummary: HTMLParagraphElement;
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
    this.cancelBtn = el(this.doc, 'button', { type: 'button', class: 'cg-cancel' });
    this.cancelBtn.textContent = 'Cancel';
    this.customMinutes = this.numberInput(
      'cg-minutes',
      {
        min: CUSTOM_LIMITS.minMinutes,
        max: CUSTOM_LIMITS.maxMinutes,
        step: CUSTOM_LIMITS.minuteStep,
      },
      'decimal',
    );
    this.customIncrement = this.numberInput(
      'cg-increment',
      {
        min: CUSTOM_LIMITS.minIncrement,
        max: CUSTOM_LIMITS.maxIncrement,
        step: 1,
      },
      'numeric',
    );
    this.customError = el(this.doc, 'p', {
      class: 'cg-field-error',
      id: 'cg-custom-error',
      role: 'alert',
      hidden: '',
    });
    this.customFields = this.createCustomFields(
      prefs?.time === CUSTOM_PRESET_ID ? prefs.minutes : 5,
      prefs?.time === CUSTOM_PRESET_ID ? prefs.increment : 0,
    );
    this.timeSummary = el(this.doc, 'p', { class: 'cg-time-summary', 'aria-live': 'polite' });
    this.form = el(this.doc, 'form', {
      id: 'create-game-form',
      class: 'cg-form',
      'aria-label': 'Create a game',
      novalidate: '',
      hidden: '',
    });
    this.form.append(
      this.createTimeField(prefs?.time ?? DEFAULT_PRESET_ID),
      this.createVariantField(prefs?.variant ?? DEFAULT_CREATE_GAME_VARIANT),
      this.createModeField(prefs?.mode ?? 'casual'),
      this.createColorField(prefs?.color ?? DEFAULT_CREATE_GAME_COLOR),
      el(this.doc, 'div', { class: 'cg-actions' }, this.submitBtn, this.cancelBtn),
    );
    this.bindEvents();
    this.syncTimeSelection(false);
    opts.mount.replaceChildren(this.trigger, this.form);
    this.setAuthenticated(opts.initialAuthenticated ?? false);
  }

  /** Build the collapsed entry point that owns the form disclosure state. */
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

  /** Build the time-control radio group with one guaranteed initial choice. */
  private createTimeField(initialTimeId: string): HTMLFieldSetElement {
    const presets = el(this.doc, 'div', { class: 'cg-presets' });
    for (const preset of CREATE_GAME_PRESETS) {
      const speed = estimateSpeed(presetToTimeControl(preset.minutes, preset.increment));
      presets.append(this.radio('cg-time', preset.id, preset.id, preset.id === initialTimeId, speed));
    }
    presets.append(
      this.radio('cg-time', CUSTOM_PRESET_ID, 'Custom', initialTimeId === CUSTOM_PRESET_ID),
    );
    return el(
      this.doc,
      'fieldset',
      { class: 'cg-field' },
      el(this.doc, 'legend', {}, 'Time'),
      presets,
      el(this.doc, 'div', { class: 'cg-time-detail' }, this.timeSummary, this.customFields),
    );
  }

  /** Build bounded custom time inputs without changing the existing API contract. */
  private createCustomFields(minutes: number, increment: number): HTMLDivElement {
    this.customMinutes.value = String(minutes);
    this.customIncrement.value = String(increment);
    this.customMinutes.setAttribute('aria-describedby', 'cg-custom-error');
    this.customIncrement.setAttribute('aria-describedby', 'cg-custom-error');
    return el(
      this.doc,
      'div',
      { class: 'cg-custom', hidden: '' },
      el(
        this.doc,
        'label',
        { class: 'cg-num' },
        el(this.doc, 'span', {}, 'Minutes'),
        this.customMinutes,
      ),
      el(
        this.doc,
        'label',
        { class: 'cg-num' },
        el(this.doc, 'span', {}, 'Increment (seconds)'),
        this.customIncrement,
      ),
      this.customError,
    );
  }

  /** Create one constrained number input whose browser hints mirror validation. */
  private numberInput(
    id: string,
    limits: { readonly min: number; readonly max: number; readonly step: number },
    inputMode: 'decimal' | 'numeric',
  ): HTMLInputElement {
    return el(this.doc, 'input', {
      id,
      type: 'number',
      min: String(limits.min),
      max: String(limits.max),
      step: String(limits.step),
      inputmode: inputMode,
      autocomplete: 'off',
    });
  }

  /** Build the mutually exclusive Casual/Rated radio group and its explanation. */
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

  /** Build the canonical player-facing variant choices. */
  private createVariantField(initialVariant: Variant): HTMLFieldSetElement {
    const variants = el(this.doc, 'div', { class: 'cg-variants' });
    for (const variant of OFFERED_VARIANTS) {
      variants.append(
        this.radio('cg-variant', variant, VARIANT_LABELS[variant], variant === initialVariant),
      );
    }
    return el(
      this.doc,
      'fieldset',
      { class: 'cg-field' },
      el(this.doc, 'legend', {}, 'Variant'),
      variants,
    );
  }

  /** Build the color preference choices in their player-facing order. */
  private createColorField(initialColor: SeekColor): HTMLFieldSetElement {
    const colors = el(this.doc, 'div', { class: 'cg-colors' });
    for (const color of CREATE_GAME_COLORS) {
      colors.append(this.radio('cg-color', color, COLOR_LABELS[color], color === initialColor));
    }
    return el(
      this.doc,
      'fieldset',
      { class: 'cg-field' },
      el(this.doc, 'legend', {}, 'Color'),
      colors,
    );
  }

  /** Bind disclosure, cancellation, submission, and Escape behavior once. */
  private bindEvents(): void {
    this.trigger.addEventListener('click', () => this.setExpanded(true));
    this.cancelBtn.addEventListener('click', () => this.setExpanded(false));
    for (const radio of this.form.querySelectorAll<HTMLInputElement>('input[name="cg-time"]')) {
      radio.addEventListener('change', () => this.syncTimeSelection(true));
    }
    this.customMinutes.addEventListener('input', () => this.clearCustomError(this.customMinutes));
    this.customIncrement.addEventListener('input', () => this.clearCustomError(this.customIncrement));
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

  /** Create a native radio wrapped by the visual chip or segmented-control label. */
  private radio(
    name: 'cg-time' | 'cg-variant' | 'cg-mode' | 'cg-color',
    value: string,
    label: string,
    checked: boolean,
    secondary?: string,
  ): HTMLLabelElement {
    const isChip = name === 'cg-time' || name === 'cg-variant';
    const className = isChip ? 'cg-chip' : 'cg-seg';
    const labelClass = name === 'cg-time' ? 'cg-chip-label' : 'cg-option-label';
    const input = el(this.doc, 'input', { type: 'radio', name, value });
    if (checked) input.checked = true;
    return el(
      this.doc,
      'label',
      { class: className },
      input,
      el(
        this.doc,
        'span',
        {
          class: className === 'cg-chip' ? labelClass : 'cg-seg-label',
          ...(name === 'cg-time' ? { dir: 'ltr' } : {}),
        },
        label,
      ),
      ...(secondary ? [el(this.doc, 'span', { class: 'cg-chip-speed' }, secondary)] : []),
    );
  }

  /** Read the selected value from a named native radio group. */
  private readChecked(name: string): string | null {
    return this.form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? null;
  }

  /** Convert validated selections into the exact existing seek request contract. */
  private gather(): { readonly params: CreateGameParams; readonly prefs: CreateGamePrefs } | null {
    const selected = this.readChecked('cg-time');
    const mode = this.readChecked('cg-mode') === 'rated' ? 'rated' : 'casual';
    const variant = this.readChecked('cg-variant');
    const color = this.readChecked('cg-color');
    if (!isOfferedVariant(variant) || !isSeekColor(color)) return null;
    if (selected === CUSTOM_PRESET_ID) {
      const minutes = this.customMinutes.value.trim() === '' ? Number.NaN : Number(this.customMinutes.value);
      const increment =
        this.customIncrement.value.trim() === '' ? Number.NaN : Number(this.customIncrement.value);
      const validation = validateCustomTime(minutes, increment);
      if (!validation.ok) {
        this.showCustomError(validation.message, validation.field);
        return null;
      }
      return {
        params: {
          variant,
          timeControl: validation.timeControl,
          rated: mode === 'rated',
          color,
        },
        prefs: {
          time: CUSTOM_PRESET_ID,
          minutes,
          increment,
          mode,
          variant,
          color,
        },
      };
    }

    const preset = CREATE_GAME_PRESETS.find((candidate) => candidate.id === selected);
    if (!preset) return null;

    return {
      params: {
        variant,
        timeControl: presetToTimeControl(preset.minutes, preset.increment),
        rated: mode === 'rated',
        color,
      },
      prefs: {
        time: preset.id,
        mode,
        variant,
        color,
      },
    };
  }

  /** Read only preferences that still belong to the approved choice sets. */
  private readPrefs(): CreateGamePrefs | null {
    if (!this.storage) return null;
    try {
      return parseCreateGamePrefs(this.storage.getItem(PREFS_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  /** Persist successful choices without making storage a creation dependency. */
  private savePrefs(prefs: CreateGamePrefs): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(PREFS_STORAGE_KEY, serializeCreateGamePrefs(prefs));
    } catch {
      // Storage can be unavailable in private browsing; seek creation still succeeds.
    }
  }

  /** Run one creation attempt, preserving selections and retryability on failure. */
  private async submit(): Promise<void> {
    if (this.pending) return;
    this.callbacks.onError(null);
    const submission = this.gather();
    if (!submission) return;
    this.setPending(true);
    try {
      const created = await this.callbacks.onSubmit(submission.params);
      if (created) {
        this.savePrefs(submission.prefs);
        this.setExpanded(false);
      }
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error.message : String(error));
    } finally {
      this.setPending(false);
    }
  }

  /** Keep disclosure state, focus, and error clearing synchronized. */
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

  /** Gate the entire flow and collapse it immediately when authentication is lost. */
  setAuthenticated(authenticated: boolean): void {
    this.trigger.disabled = !authenticated;
    this.trigger.title = authenticated ? '' : 'Sign in to create a seek';
    if (!authenticated && this.expanded) this.setExpanded(false);
  }

  /** Reflect the controller's in-flight state while preventing duplicate submission. */
  setPending(pending: boolean): void {
    this.pending = pending;
    this.form.setAttribute('aria-busy', String(pending));
    this.submitBtn.disabled = pending;
    this.cancelBtn.disabled = pending;
    for (const name of ['cg-time', 'cg-variant', 'cg-mode', 'cg-color']) {
      for (const radio of this.form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
        radio.disabled = pending;
      }
    }
    this.syncTimeSelection(false);
    this.submitBtn.textContent = pending ? 'Creating…' : 'Create seek';
  }

  /** Synchronize custom-field visibility and a stable summary region. */
  private syncTimeSelection(focusCustom: boolean): void {
    const selected = this.readChecked('cg-time');
    const isCustom = selected === CUSTOM_PRESET_ID;
    this.customFields.hidden = !isCustom;
    this.timeSummary.hidden = isCustom;
    this.customMinutes.disabled = this.pending || !isCustom;
    this.customIncrement.disabled = this.pending || !isCustom;
    if (isCustom) {
      this.timeSummary.textContent = '';
      if (focusCustom && !this.pending) this.customMinutes.focus();
      return;
    }
    this.clearCustomError();
    const preset = CREATE_GAME_PRESETS.find((candidate) => candidate.id === selected);
    if (!preset) return;
    const speed = estimateSpeed(presetToTimeControl(preset.minutes, preset.increment));
    const minutes = preset.minutes === 1 ? '1 minute' : `${preset.minutes} minutes`;
    const increment = preset.increment === 0 ? 'no increment' : `${preset.increment} second increment`;
    this.timeSummary.textContent = `${speed} — ${minutes} per side, ${increment}.`;
  }

  /** Surface one custom validation error at the field that needs correction. */
  private showCustomError(message: string, field: 'minutes' | 'increment'): void {
    this.customError.textContent = message;
    this.customError.hidden = false;
    this.customMinutes.removeAttribute('aria-invalid');
    this.customIncrement.removeAttribute('aria-invalid');
    const input = field === 'minutes' ? this.customMinutes : this.customIncrement;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }

  /** Clear custom validation state without affecting the lobby-level error region. */
  private clearCustomError(input?: HTMLInputElement): void {
    if (input && !input.hasAttribute('aria-invalid')) return;
    this.customError.textContent = '';
    this.customError.hidden = true;
    if (input) {
      input.removeAttribute('aria-invalid');
    } else {
      this.customMinutes.removeAttribute('aria-invalid');
      this.customIncrement.removeAttribute('aria-invalid');
    }
  }

}
