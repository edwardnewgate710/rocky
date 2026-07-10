/**
 * Speech I/O ports for the Voice Coach (M8 increment 8).
 *
 * Voice is split into **logic** (built now, hermetic) and **delivery**
 * (deferred to the deployment layer via these ports).  A real TTS/STT
 * adapter implements these same interfaces in M13/M14 without touching
 * the Voice Coach feature.
 *
 * The fake adapters shipped here are text-based: the fake synthesizer
 * returns a deterministic representation of what *would* be spoken (so
 * tests assert the spoken text), and the fake recognizer maps canned
 * audio tokens to commands.  Neither produces or consumes real audio.
 */

// ---------------------------------------------------------------------------
// SpeechSynthesizer — text → audio
// ---------------------------------------------------------------------------

/**
 * A request to synthesize speech from text.
 */
export interface SynthesizeRequest {
  /** The text to synthesize. */
  readonly text: string;
  /** Optional: voice id (provider-specific). */
  readonly voiceId?: string;
  /** Optional: speech rate (1.0 = normal). */
  readonly rate?: number;
  /** Optional: pitch (1.0 = normal). */
  readonly pitch?: number;
  /** Optional: volume (0.0–1.0). */
  readonly volume?: number;
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * The result of speech synthesis.
 *
 * A real adapter returns audio bytes (Base64 or a URL); the fake
 * adapter returns a deterministic text representation so tests can
 * assert what *would* be spoken.
 */
export interface SynthesizeResult {
  /** The input text that was synthesized. */
  readonly text: string;
  /**
   * Audio data: a Base64-encoded string (real adapter) or a deterministic
   * text placeholder (fake adapter).  The caller treats this as opaque.
 */
  readonly audio: string;
  /** Audio format hint (e.g. `'mp3'`, `'wav'`, `'text'`). */
  readonly format: string;
  /** Provider id (e.g. `'fake-tts'`, `'openai-tts'`). */
  readonly providerId: string;
  /** Wall-clock latency in ms. */
  readonly latencyMs: number;
}

/**
 * Port: text → audio.
 *
 * A real TTS adapter (OpenAI TTS, Azure Speech, browser SpeechSynthesis)
 * implements this interface in the deployment layer.  The fake adapter
 * shipped here returns a deterministic text representation for hermetic
 * testing.
 */
export interface SpeechSynthesizer {
  /** Synthesize speech from text. */
  synthesize(request: SynthesizeRequest): Promise<SynthesizeResult>;
}

// ---------------------------------------------------------------------------
// SpeechRecognizer — audio → text/command
// ---------------------------------------------------------------------------

/**
 * A request to recognize speech from audio.
 *
 * A real adapter receives audio bytes; the fake adapter receives canned
 * audio tokens that it maps to commands.
 */
export interface RecognizeRequest {
  /** Audio data (Base64 string or a canned token for the fake adapter). */
  readonly audio: string;
  /** Audio format hint (e.g. `'mp3'`, `'wav'`, `'token'`). */
  readonly format?: string;
  /** Optional: expected language / locale. */
  readonly language?: string;
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * The result of speech recognition.
 */
export interface RecognizeResult {
  /** The recognized text (transcript). */
  readonly text: string;
  /** A structured voice command parsed from the transcript, or `null`. */
  readonly command: VoiceCommand | null;
  /** Confidence score (0.0–1.0). */
  readonly confidence: number;
  /** Provider id (e.g. `'fake-stt'`, `'openai-whisper'`). */
  readonly providerId: string;
  /** Wall-clock latency in ms. */
  readonly latencyMs: number;
}

/**
 * A structured voice command parsed from recognized speech.
 *
 * The Voice Coach can interpret these to drive hands-free interaction
 * (e.g. "explain that move", "next puzzle", "stop").
 */
export type VoiceCommand =
  | { readonly kind: 'explain' }
  | { readonly kind: 'hint' }
  | { readonly kind: 'next' }
  | { readonly kind: 'repeat' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'unknown'; readonly text: string };

/**
 * Port: audio → text/command.
 *
 * A real STT adapter (OpenAI Whisper, Azure Speech, browser
 * SpeechRecognition) implements this interface in the deployment layer.
 * The fake adapter shipped here maps canned audio tokens to commands
 * for hermetic testing.
 */
export interface SpeechRecognizer {
  /** Recognize speech from audio. */
  recognize(request: RecognizeRequest): Promise<RecognizeResult>;
}

// ---------------------------------------------------------------------------
// Fake adapters (for hermetic testing)
// ---------------------------------------------------------------------------

/**
 * Fake speech synthesizer for hermetic testing.
 *
 * Returns a deterministic text representation of what *would* be spoken.
 * The `audio` field is `[SPOKEN: "<text>"]` — a stable, assertable string.
 * No real audio is produced.
 */
export class FakeSpeechSynthesizer implements SpeechSynthesizer {
  readonly providerId = 'fake-tts';
  private readonly latencyMs: number;

  constructor(options?: { latencyMs?: number }) {
    this.latencyMs = options?.latencyMs ?? 0;
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResult> {
    return {
      text: request.text,
      audio: `[SPOKEN: "${request.text}"]`,
      format: 'text',
      providerId: this.providerId,
      latencyMs: this.latencyMs,
    };
  }
}

/**
 * Fake speech recognizer for hermetic testing.
 *
 * Maps canned audio tokens to commands.  The mapping is deterministic:
 *
 * | Token | Command |
 * |---|---|
 * | `'explain'` | `{ kind: 'explain' }` |
 * | `'hint'` | `{ kind: 'hint' }` |
 * | `'next'` | `{ kind: 'next' }` |
 * | `'repeat'` | `{ kind: 'repeat' }` |
 * | `'stop'` | `{ kind: 'stop' }` |
 * | anything else | `{ kind: 'unknown', text: <token> }` |
 *
 * No real audio is consumed.
 */
export class FakeSpeechRecognizer implements SpeechRecognizer {
  readonly providerId = 'fake-stt';
  private readonly latencyMs: number;

  constructor(options?: { latencyMs?: number }) {
    this.latencyMs = options?.latencyMs ?? 0;
  }

  async recognize(request: RecognizeRequest): Promise<RecognizeResult> {
    const token = request.audio;
    const command = this.parseCommand(token);
    return {
      text: token,
      command,
      confidence: 1.0,
      providerId: this.providerId,
      latencyMs: this.latencyMs,
    };
  }

  private parseCommand(token: string): VoiceCommand {
    switch (token.toLowerCase()) {
      case 'explain': return { kind: 'explain' };
      case 'hint': return { kind: 'hint' };
      case 'next': return { kind: 'next' };
      case 'repeat': return { kind: 'repeat' };
      case 'stop': return { kind: 'stop' };
      default: return { kind: 'unknown', text: token };
    }
  }
}
