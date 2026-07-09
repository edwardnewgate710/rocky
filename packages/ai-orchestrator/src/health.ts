/**
 * Health monitoring for AI providers.  Tracks a rolling window of
 * request outcomes (latency, success/failure) and computes health
 * state.  The circuit breaker uses this data to open/close.
 */

import type { HealthState, ProviderHealth } from './types.js';
import type { CircuitBreakerConfig } from './config.js';
import { DEFAULTS } from './config.js';

interface Outcome {
  readonly success: boolean;
  readonly latencyMs: number;
  readonly timestamp: number;
}

/**
 * Per-provider health tracker.  Maintains a rolling window of outcomes
 * and computes aggregate stats on demand.
 *
 * Circuit breaker states:
 * - **closed**: requests flow normally.
 * - **open**: all requests are blocked; the breaker waits for a reset
 *   timeout before allowing a probe.
 * - **half-open**: a single probe request is allowed; if it succeeds,
 *   the breaker closes; if it fails, the breaker re-opens.
 */
export class HealthTracker {
  private readonly outcomes: Outcome[] = [];
  private readonly windowSize: number;
  private consecutiveFailures = 0;
  private lastError: string | undefined;
  private lastSuccessMs: number | undefined;
  private circuitOpen = false;
  private circuitOpenedAt = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;
  private successSinceHalfOpen = 0;
  private halfOpen = false;

  constructor(
    windowSize = DEFAULTS.health.windowSize,
    breakerConfig?: CircuitBreakerConfig,
  ) {
    this.windowSize = windowSize;
    this.failureThreshold = breakerConfig?.failureThreshold ?? DEFAULTS.circuitBreaker.failureThreshold;
    this.resetTimeoutMs = breakerConfig?.resetTimeoutMs ?? DEFAULTS.circuitBreaker.resetTimeoutMs;
    this.successThreshold = breakerConfig?.successThreshold ?? DEFAULTS.circuitBreaker.successThreshold;
  }

  /** Record a successful request. */
  recordSuccess(latencyMs: number): void {
    this.outcomes.push({ success: true, latencyMs, timestamp: Date.now() });
    this.trim();
    this.consecutiveFailures = 0;
    this.lastSuccessMs = Date.now();
    if (this.halfOpen) {
      this.successSinceHalfOpen++;
      if (this.successSinceHalfOpen >= this.successThreshold) {
        this.circuitOpen = false;
        this.halfOpen = false;
        this.successSinceHalfOpen = 0;
      }
    }
  }

  /** Record a failed request. */
  recordFailure(errorMessage?: string): void {
    this.outcomes.push({ success: false, latencyMs: 0, timestamp: Date.now() });
    this.trim();
    this.consecutiveFailures++;
    this.lastError = errorMessage;
    if (this.halfOpen) {
      // Probe failed — re-open the circuit.
      this.circuitOpen = true;
      this.halfOpen = false;
      this.successSinceHalfOpen = 0;
      this.circuitOpenedAt = Date.now();
    } else if (this.consecutiveFailures >= this.failureThreshold && !this.circuitOpen) {
      this.circuitOpen = true;
      this.circuitOpenedAt = Date.now();
    }
  }

  /**
   * Check if the circuit breaker is open (should block requests).
   * This is a pure query — it does NOT mutate state.  Call
   * {@link tryEnterHalfOpen} to attempt the half-open transition.
   */
  isCircuitOpen(): boolean {
    if (!this.circuitOpen) return false;
    if (this.halfOpen) return false; // half-open allows a probe
    // Check if reset timeout has elapsed.
    if (Date.now() - this.circuitOpenedAt > this.resetTimeoutMs) {
      return false; // not open — caller should call tryEnterHalfOpen
    }
    return true;
  }

  /**
   * Attempt to enter the half-open state.  Returns true if the breaker
   * transitioned from open to half-open (allowing a probe request).
   * Returns false if the breaker is still open (reset timeout not
   * elapsed) or already closed/half-open.
   */
  tryEnterHalfOpen(): boolean {
    if (!this.circuitOpen || this.halfOpen) return false;
    if (Date.now() - this.circuitOpenedAt <= this.resetTimeoutMs) return false;
    this.halfOpen = true;
    this.successSinceHalfOpen = 0;
    return true;
  }

  /** Compute current health snapshot. */
  snapshot(providerId: string): ProviderHealth {
    const recent = this.outcomes;
    const requestCount = recent.length;
    const successes = recent.filter((o) => o.success);
    const successRate = requestCount > 0 ? successes.length / requestCount : 1;
    const avgLatencyMs = successes.length > 0
      ? Math.round(successes.reduce((sum, o) => sum + o.latencyMs, 0) / successes.length)
      : 0;

    let state: HealthState = 'healthy';
    if (this.isCircuitOpen() || successRate < 0.3) {
      state = 'unhealthy';
    } else if (successRate < 0.8 || this.consecutiveFailures > 0) {
      state = 'degraded';
    }

    return {
      providerId,
      state,
      avgLatencyMs,
      successRate,
      requestCount,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: this.isCircuitOpen(),
      lastError: this.lastError,
      lastSuccessMs: this.lastSuccessMs,
    };
  }

  /** Reset all tracked data. */
  reset(): void {
    this.outcomes.length = 0;
    this.consecutiveFailures = 0;
    this.lastError = undefined;
    this.lastSuccessMs = undefined;
    this.circuitOpen = false;
    this.halfOpen = false;
    this.successSinceHalfOpen = 0;
  }

  private trim(): void {
    while (this.outcomes.length > this.windowSize) {
      this.outcomes.shift();
    }
  }
}
