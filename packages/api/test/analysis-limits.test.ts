import test from 'node:test';
import assert from 'node:assert/strict';
import type { RequestedAnalysisLimits } from '../src/analysis/limits';
import {
  applyAnalysisLimits,
  DEFAULT_ANALYSIS_LIMITS,
} from '../src/analysis/limits';

test('applyAnalysisLimits: request with only depth still includes unconditional movetimeMs wall-clock ceiling', () => {
  const applied = applyAnalysisLimits({ depth: 15 });

  assert.equal(applied.depth, 15);
  assert.equal(applied.movetimeMs, DEFAULT_ANALYSIS_LIMITS.defaultTimeMs);
  assert.equal(applied.multiPv, 1);
  assert.equal(applied.nodes, undefined);
  assert.equal('nodes' in applied, false);
});

test('applyAnalysisLimits: clamps fields down to policy ceilings and never up', () => {
  const requested: RequestedAnalysisLimits = {
    depth: 999,
    nodes: 99_000_000,
    movetimeMs: 100_000,
    multiPv: 50,
  };

  const applied = applyAnalysisLimits(requested, DEFAULT_ANALYSIS_LIMITS);

  assert.equal(applied.depth, DEFAULT_ANALYSIS_LIMITS.maxDepth);
  assert.equal(applied.nodes, DEFAULT_ANALYSIS_LIMITS.maxNodes);
  assert.equal(applied.movetimeMs, DEFAULT_ANALYSIS_LIMITS.maxTimeMs);
  assert.equal(applied.multiPv, DEFAULT_ANALYSIS_LIMITS.maxMultiPv);

  const customPolicy = {
    maxDepth: 10,
    maxNodes: 10_000,
    maxTimeMs: 500,
    maxMultiPv: 2,
    defaultDepth: 8,
    defaultTimeMs: 250,
  };
  const appliedCustom = applyAnalysisLimits({ depth: 15, movetimeMs: 2000, multiPv: 4, nodes: 50_000 }, customPolicy);
  assert.equal(appliedCustom.depth, 10);
  assert.equal(appliedCustom.nodes, 10_000);
  assert.equal(appliedCustom.movetimeMs, 500);
  assert.equal(appliedCustom.multiPv, 2);
});

test('applyAnalysisLimits: absent input yields policy defaults', () => {
  const applied = applyAnalysisLimits({});

  assert.equal(applied.depth, DEFAULT_ANALYSIS_LIMITS.defaultDepth);
  assert.equal(applied.movetimeMs, DEFAULT_ANALYSIS_LIMITS.defaultTimeMs);
  assert.equal(applied.multiPv, 1);
  assert.equal('nodes' in applied, false);
});

test('applyAnalysisLimits: NaN, Infinity, 0, negative, and fractional values fall back or clamp safely', () => {
  const nonFiniteInput: RequestedAnalysisLimits = {
    depth: NaN,
    nodes: Infinity,
    movetimeMs: NaN,
    multiPv: NaN,
  };
  const appliedNonFinite = applyAnalysisLimits(nonFiniteInput);
  assert.equal(appliedNonFinite.depth, DEFAULT_ANALYSIS_LIMITS.defaultDepth);
  assert.equal('nodes' in appliedNonFinite, false);
  assert.equal(appliedNonFinite.movetimeMs, DEFAULT_ANALYSIS_LIMITS.defaultTimeMs);
  assert.equal(appliedNonFinite.multiPv, 1);

  const negativeInput: RequestedAnalysisLimits = {
    depth: -10,
    nodes: -500,
    movetimeMs: -100,
    multiPv: -2,
  };
  const appliedNegative = applyAnalysisLimits(negativeInput);
  assert.equal(appliedNegative.depth, 1);
  assert.equal(appliedNegative.nodes, 1);
  assert.equal(appliedNegative.movetimeMs, 1);
  assert.equal(appliedNegative.multiPv, 1);

  const zeroInput: RequestedAnalysisLimits = {
    depth: 0,
    movetimeMs: 0,
    multiPv: 0,
    nodes: 0,
  };
  const appliedZero = applyAnalysisLimits(zeroInput);
  assert.equal(appliedZero.depth, 1);
  assert.equal(appliedZero.movetimeMs, 1);
  assert.equal(appliedZero.multiPv, 1);
  assert.equal(appliedZero.nodes, 1);

  const fractionalInput: RequestedAnalysisLimits = {
    depth: 12.8,
    movetimeMs: 500.9,
    multiPv: 3.2,
    nodes: 1000.7,
  };
  const appliedFractional = applyAnalysisLimits(fractionalInput);
  assert.equal(appliedFractional.depth, 12);
  assert.equal(appliedFractional.movetimeMs, 500);
  assert.equal(appliedFractional.multiPv, 3);
  assert.equal(appliedFractional.nodes, 1000);

  for (const val of Object.values(appliedFractional)) {
    assert.ok(typeof val === 'number');
    assert.ok(Number.isFinite(val));
    assert.ok(!Number.isNaN(val));
  }
});

test('applyAnalysisLimits: unknown extra properties on input do not appear on result', () => {
  const untrustedInput = {
    depth: 10,
    movetimeMs: 800,
    unknownField: 'malicious-string',
    adminBypass: true,
    dangerousPayload: { execute: true },
  };

  const applied = applyAnalysisLimits(untrustedInput as unknown as RequestedAnalysisLimits);

  assert.deepEqual(Object.keys(applied).sort(), ['depth', 'movetimeMs', 'multiPv']);
  assert.equal(Object.prototype.hasOwnProperty.call(applied, 'unknownField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(applied, 'adminBypass'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(applied, 'dangerousPayload'), false);
});
