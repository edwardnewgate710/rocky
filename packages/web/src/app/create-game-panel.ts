/**
 * Create-a-game panel — the lobby's inline seek builder.
 *
 * A collapsed "Create a game" trigger expands into a compact form: a time-control
 * preset grid (plus Custom), Casual/Rated, a White/Random/Black color choice, and
 * an optional "More options" disclosure for variant and rating range. The 90%
 * path is preset → Create.
 *
 * The component owns its DOM and internal form state only. It never talks to the
 * network: it hands a validated {@link CreateGameParams} to `onSubmit` and lets
 * the caller (the lobby wiring) post the seek. Progressive disclosure, native
 * radio groups (free keyboard + screen-reader grouping), and a single teal accent
 * for "selected" keep it on the Grandmaster's Study system.
 */
import type { TimeControl, Variant, SeekColor } from '../api/models.js';
import { VARIANTS } from '../api/models.js';
import {
  TIME_PRESETS,
  DEFAULT_PRESET_ID,
  CUSTOM_LIMITS,
  presetToTimeControl,
  estimateSpeed,
} from './time-presets.js';

/** The validated seek settings a submit produces. */
export interface CreateGameParams {
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly rated: boolean;
  readonly color: SeekColor;
  readonly minRating: number | null;
  readonly maxRating: number | null;
}

export interface CreateGamePanelCallbacks {
  /** Post the seek. Resolve `true` when created (panel collapses), `false` otherwise. */
  onSubmit: (params: CreateGameParams) => Promise<boolean>;
  /** Surface (or clear, with `null`) a validation/action message. */
  onError: (message: string | null) => void;
}

export interface CreateGamePanelOptions {
  readonly doc: Document;
  readonly mount: HTMLElement;
  readonly callbacks: CreateGamePanelCallbacks;
  readonly initialAuthenticated?: boolean;
}

/** Human labels for the contract's variant codes. */
const VARIANT_LABELS: Record<Variant, string> = {
  standard: 'Standard',
  chess960: 'Chess960',
  kingofthehill: 'King of the Hill',
  atomic: 'Atomic',
  crazyhouse: 'Crazyhouse',
  threecheck: 'Three-check',
  horde: 'Horde',
  racingkings: 'Racing Kings',
};

interface ColorOption {
  readonly value: SeekColor;
  readonly label: string;
  readonly glyph: string;
}
const COLOR_OPTIONS: readonly ColorOption[] = [
  { value: 'white', label: 'White', glyph: '♔' },
  { value: 'random', label: 'Random', glyph: '½' },
  { value: 'black', label: 'Black', glyph: '♚' },
];

type Attrs = Record<string, string>;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export class CreateGamePanel {
  private readonly doc: Document;
  private readonly callbacks: CreateGamePanelCallbacks;

  private readonly trigger: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly customBox: HTMLElement;
  private readonly minutesInput: HTMLInputElement;
  private readonly incrementInput: HTMLInputElement;
  private readonly moreToggle: HTMLButtonElement;
  private readonly advanced: HTMLElement;
  private readonly variantSelect: HTMLSelectElement;
  private readonly minRatingInput: HTMLInputElement;
  private readonly maxRatingInput: HTMLInputElement;
  private readonly ratingError: HTMLParagraphElement;
  private readonly submitBtn: HTMLButtonElement;

  private expanded = false;
  private pending = false;
  private ratingInvalid = false;

  constructor(opts: CreateGamePanelOptions) {
    this.doc = opts.doc;
    this.callbacks = opts.callbacks;
    const d = this.doc;

    // --- Trigger (keeps the id the auth gating targets) ---
    this.trigger = el(d, 'button', {
      id: 'create-seek',
      type: 'button',
      class: 'cg-trigger',
      'aria-expanded': 'false',
      'aria-controls': 'create-game-form',
    });
    this.trigger.textContent = 'Create a game';

    // --- Time control ---
    const timeField = el(d, 'fieldset', { class: 'cg-field' }, el(d, 'legend', {}, 'Time control'));
    const presets = el(d, 'div', { class: 'cg-presets' });
    for (const p of TIME_PRESETS) {
      const speed = estimateSpeed(presetToTimeControl(p.minutes, p.increment));
      presets.append(
        this.chip('cg-time', p.id, p.id, p.id === DEFAULT_PRESET_ID, speed),
      );
    }
    presets.append(this.chip('cg-time', 'custom', 'Custom', false));
    timeField.append(presets);

    this.minutesInput = el(d, 'input', {
      id: 'cg-minutes',
      type: 'number',
      inputmode: 'decimal',
      min: String(CUSTOM_LIMITS.minMinutes),
      max: String(CUSTOM_LIMITS.maxMinutes),
      step: '0.5',
      value: '5',
    });
    this.incrementInput = el(d, 'input', {
      id: 'cg-increment',
      type: 'number',
      inputmode: 'numeric',
      min: String(CUSTOM_LIMITS.minIncrement),
      max: String(CUSTOM_LIMITS.maxIncrement),
      step: '1',
      value: '0',
    });
    this.customBox = el(
      d,
      'div',
      { class: 'cg-custom', hidden: '' },
      el(d, 'label', { class: 'cg-num', for: 'cg-minutes' }, 'Minutes', this.minutesInput),
      el(d, 'label', { class: 'cg-num', for: 'cg-increment' }, 'Increment (sec)', this.incrementInput),
    );
    timeField.append(this.customBox);

    // --- Mode ---
    const modeField = el(
      d,
      'fieldset',
      { class: 'cg-field' },
      el(d, 'legend', {}, 'Mode'),
      el(
        d,
        'div',
        { class: 'cg-segmented' },
        this.segment('cg-mode', 'casual', 'Casual', true),
        this.segment('cg-mode', 'rated', 'Rated', false),
      ),
      el(d, 'p', { class: 'cg-hint' }, 'Rated games affect your rating.'),
    );

    // --- Color ---
    const colorSeg = el(d, 'div', { class: 'cg-segmented' });
    for (const c of COLOR_OPTIONS) {
      colorSeg.append(
        this.segment('cg-color', c.value, c.label, c.value === 'random', c.glyph),
      );
    }
    const colorField = el(
      d,
      'fieldset',
      { class: 'cg-field' },
      el(d, 'legend', {}, 'Color'),
      colorSeg,
    );

    // --- More options (variant + rating range) ---
    this.moreToggle = el(d, 'button', {
      type: 'button',
      class: 'cg-more-toggle',
      'aria-expanded': 'false',
      'aria-controls': 'cg-advanced',
    });
    this.moreToggle.textContent = 'More options';

    this.variantSelect = el(d, 'select', { id: 'cg-variant', class: 'cg-select' });
    for (const v of VARIANTS) {
      const opt = el(d, 'option', { value: v }, VARIANT_LABELS[v]);
      if (v === 'standard') opt.selected = true;
      this.variantSelect.append(opt);
    }

    this.minRatingInput = el(d, 'input', {
      id: 'cg-min-rating',
      type: 'number',
      inputmode: 'numeric',
      min: '0',
      max: '4000',
      step: '50',
      placeholder: 'Any',
    });
    this.maxRatingInput = el(d, 'input', {
      id: 'cg-max-rating',
      type: 'number',
      inputmode: 'numeric',
      min: '0',
      max: '4000',
      step: '50',
      placeholder: 'Any',
    });

    this.ratingError = el(d, 'p', {
      class: 'cg-field-error',
      id: 'cg-rating-error',
      role: 'alert',
      hidden: '',
    });
    this.minRatingInput.setAttribute('aria-describedby', 'cg-rating-error');
    this.maxRatingInput.setAttribute('aria-describedby', 'cg-rating-error');

    this.advanced = el(
      d,
      'div',
      { id: 'cg-advanced', class: 'cg-advanced', hidden: '' },
      el(d, 'label', { class: 'cg-row', for: 'cg-variant' }, 'Variant', this.variantSelect),
      el(
        d,
        'fieldset',
        { class: 'cg-field cg-rating' },
        el(d, 'legend', {}, 'Rating range'),
        el(
          d,
          'div',
          { class: 'cg-rating-inputs' },
          el(d, 'label', { class: 'cg-num', for: 'cg-min-rating' }, 'Min', this.minRatingInput),
          el(d, 'label', { class: 'cg-num', for: 'cg-max-rating' }, 'Max', this.maxRatingInput),
        ),
        this.ratingError,
      ),
    );
    const moreBox = el(d, 'div', { class: 'cg-more' }, this.moreToggle, this.advanced);

    // --- Actions ---
    this.submitBtn = el(d, 'button', { type: 'submit', class: 'cg-submit' });
    this.submitBtn.textContent = 'Create seek';
    const cancelBtn = el(d, 'button', { type: 'button', class: 'cg-cancel' });
    cancelBtn.textContent = 'Cancel';
    const actions = el(d, 'div', { class: 'cg-actions' }, this.submitBtn, cancelBtn);

    // --- Form ---
    this.form = el(d, 'form', {
      id: 'create-game-form',
      class: 'cg-form',
      'aria-label': 'Create a game',
      hidden: '',
    });
    this.form.append(timeField, modeField, colorField, moreBox, actions);

    // --- Events ---
    this.trigger.addEventListener('click', () => this.setExpanded(true));
    cancelBtn.addEventListener('click', () => this.setExpanded(false));
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
    this.form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.setExpanded(false);
      }
    });
    this.form.addEventListener('change', (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.name === 'cg-time') {
        this.syncCustom();
      }
    });
    this.moreToggle.addEventListener('click', () => {
      const open = this.advanced.hidden;
      this.advanced.hidden = !open;
      this.moreToggle.setAttribute('aria-expanded', String(open));
    });
    // Rating range: validate live (min ≤ max) and clamp to 0–4000 on commit,
    // so an invalid range is blocked before submit rather than after.
    for (const input of [this.minRatingInput, this.maxRatingInput]) {
      input.addEventListener('input', () => this.validateRating());
      input.addEventListener('change', () => {
        this.clampField(input);
        this.validateRating();
      });
    }

    opts.mount.replaceChildren(this.trigger, this.form);
    this.setAuthenticated(opts.initialAuthenticated ?? false);
    this.syncCustom();
  }

  /** A time-preset chip (a styled radio) with an optional speed tag. */
  private chip(name: string, value: string, label: string, checked: boolean, speed?: string): HTMLLabelElement {
    const d = this.doc;
    const input = el(d, 'input', { type: 'radio', name, value });
    if (checked) input.checked = true;
    const parts: (Node | string)[] = [input, el(d, 'span', { class: 'cg-chip-label' }, label)];
    if (speed) parts.push(el(d, 'span', { class: 'cg-chip-speed' }, speed));
    return el(d, 'label', { class: 'cg-chip' }, ...parts);
  }

  /** A segmented-control option (a styled radio) with an optional leading glyph. */
  private segment(name: string, value: string, label: string, checked: boolean, glyph?: string): HTMLLabelElement {
    const d = this.doc;
    const input = el(d, 'input', { type: 'radio', name, value });
    if (checked) input.checked = true;
    const inner = el(d, 'span', { class: 'cg-seg-label' });
    if (glyph) inner.append(el(d, 'span', { class: 'cg-seg-glyph', 'aria-hidden': 'true' }, glyph));
    inner.append(label);
    return el(d, 'label', { class: 'cg-seg' }, input, inner);
  }

  /** Toggle the custom-time inputs based on the selected preset. */
  private syncCustom(): void {
    const custom = this.readChecked('cg-time') === 'custom';
    this.customBox.hidden = !custom;
    if (custom) this.minutesInput.focus();
  }

  private readChecked(name: string): string | null {
    const input = this.form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
    return input ? input.value : null;
  }

  /** Parse a rating field to an integer clamped to the valid 0–4000 band, or null. */
  private parseRating(raw: string): number | null {
    const t = raw.trim();
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return Math.min(4000, Math.max(0, Math.round(n)));
  }

  /** Snap a rating field's visible value to the clamped, parsed value on commit. */
  private clampField(input: HTMLInputElement): void {
    const parsed = this.parseRating(input.value);
    input.value = parsed === null ? '' : String(parsed);
  }

  /** Live-validate the rating range and reflect the result on submit + a11y. */
  private validateRating(): void {
    const min = this.parseRating(this.minRatingInput.value);
    const max = this.parseRating(this.maxRatingInput.value);
    const invalid = min !== null && max !== null && min > max;
    this.ratingInvalid = invalid;
    this.ratingError.textContent = invalid ? 'Minimum rating can’t exceed the maximum.' : '';
    this.ratingError.hidden = !invalid;
    this.minRatingInput.setAttribute('aria-invalid', String(invalid));
    this.maxRatingInput.setAttribute('aria-invalid', String(invalid));
    this.updateSubmitState();
  }

  /** Submit is disabled while a request is in flight or the rating range is invalid. */
  private updateSubmitState(): void {
    this.submitBtn.disabled = this.pending || this.ratingInvalid;
  }

  /** Read + validate the form. Returns null (and surfaces a message) when invalid. */
  private gather(): CreateGameParams | null {
    const timeVal = this.readChecked('cg-time') ?? DEFAULT_PRESET_ID;
    let timeControl: TimeControl;
    if (timeVal === 'custom') {
      const minutes = Number(this.minutesInput.value);
      const increment = Number(this.incrementInput.value);
      const { minMinutes, maxMinutes, minIncrement, maxIncrement } = CUSTOM_LIMITS;
      if (!Number.isFinite(minutes) || minutes < minMinutes || minutes > maxMinutes) {
        this.callbacks.onError(`Minutes must be between ${minMinutes} and ${maxMinutes}.`);
        this.minutesInput.focus();
        return null;
      }
      if (!Number.isFinite(increment) || increment < minIncrement || increment > maxIncrement) {
        this.callbacks.onError(`Increment must be between ${minIncrement} and ${maxIncrement} seconds.`);
        this.incrementInput.focus();
        return null;
      }
      timeControl = presetToTimeControl(minutes, increment);
    } else {
      const preset =
        TIME_PRESETS.find((p) => p.id === timeVal) ??
        TIME_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!;
      timeControl = presetToTimeControl(preset.minutes, preset.increment);
    }

    const rated = this.readChecked('cg-mode') === 'rated';
    const color = (this.readChecked('cg-color') ?? 'random') as SeekColor;
    const variant = this.variantSelect.value as Variant;
    const minRating = this.parseRating(this.minRatingInput.value);
    const maxRating = this.parseRating(this.maxRatingInput.value);
    if (minRating !== null && maxRating !== null && minRating > maxRating) {
      this.callbacks.onError('Minimum rating can’t exceed the maximum.');
      this.minRatingInput.focus();
      return null;
    }

    return { variant, timeControl, rated, color, minRating, maxRating };
  }

  private async submit(): Promise<void> {
    if (this.pending) return;
    const params = this.gather();
    if (!params) return;
    this.callbacks.onError(null);
    const created = await this.callbacks.onSubmit(params);
    if (created) this.setExpanded(false);
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.trigger.setAttribute('aria-expanded', String(expanded));
    this.trigger.hidden = expanded;
    this.form.hidden = !expanded;
    if (expanded) {
      const checked = this.form.querySelector<HTMLInputElement>('input[name="cg-time"]:checked');
      checked?.focus();
    } else {
      this.callbacks.onError(null);
      if (!this.trigger.disabled) this.trigger.focus();
    }
  }

  /** Enable/disable the trigger to reflect sign-in state. */
  setAuthenticated(authed: boolean): void {
    this.trigger.disabled = !authed;
    this.trigger.title = authed ? '' : 'Sign in to create a seek';
    if (!authed && this.expanded) this.setExpanded(false);
  }

  /** Reflect an in-flight create request on the submit button. */
  setPending(pending: boolean): void {
    this.pending = pending;
    this.submitBtn.textContent = pending ? 'Creating…' : 'Create seek';
    this.updateSubmitState();
  }

  /** Collapse the panel (e.g. after a successful create driven elsewhere). */
  collapse(): void {
    if (this.expanded) this.setExpanded(false);
  }
}
