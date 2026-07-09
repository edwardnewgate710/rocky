# @chess-platform/ai-features

AI-powered chess features built on the M5 engine bridge
(`@chess-platform/engine`) and M7 AI orchestrator
(`@chess-platform/ai-orchestrator`).

## M8 Increment 1: Move Explanation

The `MoveExplainer` produces a natural-language explanation of a chess
move, **grounded in real engine analysis** — not free-form LLM
speculation.

### Usage

```typescript
import { MoveExplainer } from '@chess-platform/ai-features';
import { FakeEngineTransport, UciEngineInstance } from '@chess-platform/engine';
import { FakeProvider } from '@chess-platform/ai-orchestrator';

const explainer = new MoveExplainer({
  engine: myAnalysisProvider,  // M5 AnalysisProvider (inject a real or fake one)
  ai: myAiProvider,            // M7 AiProvider (inject a real or fake one)
});

const result = await explainer.explain({
  fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
  move: 'e7e5',
  side: 'black',
});

// result.explanation  → natural-language prose
// result.citation     → structured engine citation (eval, best line, depth)
// result.citation.evalLabel  → "-0.35"
// result.citation.bestLine   → ["e7e5", "g1f3", "b8c6", "f1b5"]
```

### Design

- **Everything behind ports:** Both the engine (`AnalysisProvider`) and
  the AI provider (`AiProvider`) are constructor-injected.
- **Engine grounding:** Engine results are converted to
  `EngineGrounding` via `engineResultsToGrounding()`, then passed
  through `buildGroundedMessages()` to produce provider-agnostic
  grounded prompts.
- **Structured citation:** The `EngineCitation` field carries the
  engine's eval (cp/mate), best line, and depth as distinct, testable
  values — not prose the test has to parse.
- **Hermetically testable:** `FakeEngineTransport` + `FakeProvider`
  drive the full path with zero external dependencies.

### Architecture

See `docs/adr/0006-ai-features.md` for the full ADR.

## Build & Test

```bash
cd packages/ai-features
npm install
npm run build
npm test          # hermetic suite (no keys, no binary, no network)
npm run lint      # strict typecheck
```

Env-gated integration tests (skip without API keys):

```bash
OPENAI_API_KEY=sk-... npm test
ANTHROPIC_API_KEY=sk-ant-... npm test
```
