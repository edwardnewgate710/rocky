/**
 * Theme toggle — a pure, DOM-free controller for light/dark theme switching.
 *
 * Manages the user's color scheme preference, persisting it to an injectable
 * key-value store (localStorage in production, a fake in tests). The
 * controller exposes callbacks for theme changes and provides the current
 * theme as a value. It never touches the DOM directly; the bootstrap layer
 * applies the `dark` class to the document element.
 */
import type { KeyValueStorage } from '../net/session.js';

export type Theme = 'light' | 'dark';

/** Callbacks the bootstrap wires to DOM elements. */
export interface ThemeCallbacks {
  onTheme: (theme: Theme) => void;
}

export interface ThemeToggleOptions {
  readonly callbacks: ThemeCallbacks;
  /** Injected storage (defaults to localStorage). */
  readonly storage?: KeyValueStorage;
  /** Storage key for the theme preference. */
  readonly storageKey?: string;
  /** Initial theme override (takes precedence over storage/system). */
  readonly initial?: Theme;
}

const DEFAULT_KEY = 'gambit-theme';

/**
 * Manages the light/dark theme preference.
 *
 * The controller is framework-independent and DOM-free. It reads the initial
 * theme from (1) an explicit override, (2) the persisted preference, or
 * (3) the system's `prefers-color-scheme`. It persists changes to the
 * injected storage and notifies via callbacks.
 */
export class ThemeToggle {
  private readonly callbacks: ThemeCallbacks;
  private readonly storage: KeyValueStorage | undefined;
  private readonly storageKey: string;
  private theme: Theme;

  constructor(opts: ThemeToggleOptions) {
    this.callbacks = opts.callbacks;
    this.storage = opts.storage;
    this.storageKey = opts.storageKey ?? DEFAULT_KEY;
    this.theme = opts.initial ?? this.resolveInitial();
  }

  /** Current theme. */
  get current(): Theme {
    return this.theme;
  }

  /** Toggle between light and dark. */
  toggle(): void {
    this.set(this.theme === 'light' ? 'dark' : 'light');
  }

  /** Set the theme explicitly, persist, and notify. */
  set(theme: Theme): void {
    this.theme = theme;
    if (this.storage) {
      try {
        this.storage.setItem(this.storageKey, theme);
      } catch {
        // Storage may be unavailable (private browsing, etc.) — ignore.
      }
    }
    this.callbacks.onTheme(theme);
  }

  /** Emit the current theme to callbacks (useful on init). */
  emit(): void {
    this.callbacks.onTheme(this.theme);
  }

  private resolveInitial(): Theme {
    // 1. Check persisted preference.
    if (this.storage) {
      try {
        const stored = this.storage.getItem(this.storageKey);
        if (stored === 'light' || stored === 'dark') return stored;
      } catch {
        // Storage unavailable — fall through.
      }
    }
    // 2. Check system preference.
    if (typeof matchMedia !== 'undefined') {
      try {
        return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch {
        // matchMedia unavailable — fall through.
      }
    }
    // 3. Default.
    return 'dark';
  }
}
