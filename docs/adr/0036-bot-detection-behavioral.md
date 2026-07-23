# ADR-0036 — Anti-Cheat Behavioral Bot Detection (Move-Time Analyzer)

| Field      | Value                           |
|------------|---------------------------------|
| **Status** | Accepted                        |
| **Date**   | 2026-07-23                      |
| **Scope**  | `@chess-platform/anti-cheat` (M12) |

---

## Context

Milestone 12 anti-cheat engine-correlation increments (Increments 1–7) measure move *quality* against Stockfish evaluations to detect engine assistance. However, engine correlation alone does not detect automated bot scripts playing at human rating levels or using randomized engine outputs.

Per ARCHITECTURE §7, anti-cheat consists of engine-correlation scoring plus behavioral bot detection. Behavioral bot detection analyzes move-time distributions to identify automated execution. This provides an orthogonal screening signal feeding a human review queue (never auto-banning silently).

## Decision

We introduce a pure, dependency-free behavioral move-time analyzer module `analyzeBotBehavior` in `@chess-platform/anti-cheat`.

### 1. Timing Data Structure (`TimedMove`)

- Represents per-move wall-clock elapsed time: `ms: number` (>= 0).
- Optional `isBook?: boolean`: opening-book and pre-theory moves are excluded from timing statistics.

### 2. Move-Time Metrics & Thresholds

The analyzer measures two independent timing signals over non-book moves (`sampleSize`):

1. **Coefficient of Variation (`coefficientOfVariation`):**
   - Population standard deviation (`stdevMs`) divided by mean move time (`meanMs`).
   - Measures pacing uniformity. Low values indicate suspiciously constant delay (bot-like timing).
   - `CV_HIGH = 0.25`: CV at or below this triggers `high` suspicion.
   - `CV_REVIEW = 0.5`: CV at or below this triggers `review` suspicion.

2. **Near-Instant Reply Fraction (`instantFraction`):**
   - Fraction of non-book moves executed in `ms <= INSTANT_MOVE_MS` (150ms).
   - Measures inhuman reaction speeds. High fractions indicate automated API or script play.
   - `INSTANT_FRACTION_HIGH = 0.9`: near-instant fraction at or above 90% triggers `high` suspicion.
   - `INSTANT_FRACTION_REVIEW = 0.7`: near-instant fraction at or above 70% triggers `review` suspicion.

### 3. Confidence Gate & Suspicion Banding

- **Low-Confidence Gate (`BOT_MIN_SAMPLE_SIZE = 10`):** Samples with fewer than 10 non-book moves set `lowConfidence: true` and force suspicion to `clean`. Thin samples must never escalate suspicion.
- **Max Banding:** When confident (`lowConfidence: false`), the overall `suspicion` takes the more severe of the CV band and Instant band (`high` > `review` > `clean`).

### 4. Known Limitations

- **Time-Trouble / Premoves:** A human player in severe time trouble (bullet/blitz scrambles) or making sequential premoves may exhibit fast, uniform move times. To prevent false positives, thresholds are set conservatively (`CV_HIGH = 0.25`, `INSTANT_FRACTION_HIGH = 0.9`), and reports serve strictly as screening signals for human moderation review, never auto-bans.

### 5. Deferrals

- **Timing Extraction:** Extracting move timings from real-time clock events and game history is deferred to a subsequent increment.
- **Cross-Game Aggregation & Persistence:** Aggregating timing signals across multiple games per account, persisting timing reports in Postgres, REST moderation endpoints, and automated triggering pipelines are deferred to later increments.

## Consequences

- **Orthogonal Bot Screening:** Establishes a pure domain foundation for detecting automated bots based on pacing and reaction speed, independent of engine evaluation quality.
- **Package Purity & Safety:** Pure function with no side effects, zero external dependencies, and deterministic behavior.
- **Human Moderation Policy:** Maintains strict adherence to ARCHITECTURE §7 — flags feed a review queue and never auto-ban.
