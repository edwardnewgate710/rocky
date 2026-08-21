import test from 'node:test';
import assert from 'node:assert/strict';
import {
  puzzleGenerationEnabled,
  puzzleGenerationSupportsVariant,
} from '../src/app/capabilities-nav.js';

test('puzzle generation fails closed when its capability is absent or false', () => {
  assert.equal(puzzleGenerationEnabled(null), false);
  assert.equal(puzzleGenerationEnabled({ capabilities: { analysis: true } }), false);
  assert.equal(
    puzzleGenerationEnabled({ capabilities: { analysis: true, puzzleGeneration: false } }),
    false,
  );
});

test('puzzle variant support reads the feature-specific advertised list', () => {
  const capabilities = {
    capabilities: { analysis: true, puzzleGeneration: true },
    analysisVariants: ['standard', 'atomic'],
    puzzleVariants: ['standard'],
  };
  assert.equal(puzzleGenerationSupportsVariant(capabilities, 'standard'), true);
  assert.equal(
    puzzleGenerationSupportsVariant(capabilities, 'atomic'),
    false,
    'generic analysis support must not imply puzzle support',
  );
  assert.equal(puzzleGenerationSupportsVariant(capabilities, null), false);
  assert.equal(
    puzzleGenerationSupportsVariant(
      { capabilities: { puzzleGeneration: true } },
      'standard',
    ),
    false,
    'a puzzle flag without its stricter variant list must not imply universal support',
  );
  assert.equal(
    puzzleGenerationSupportsVariant(
      { capabilities: { puzzleGeneration: true }, puzzleVariants: ['standard', 1] },
      'standard',
    ),
    false,
    'one malformed list entry invalidates the partial capability response',
  );
});
