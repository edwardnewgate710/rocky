/**
 * Capability discovery, engine fingerprinting, and version negotiation. Behaviour is
 * driven by what an engine *advertises* during the `uci` handshake — never by matching
 * on the engine's name. Adding a new engine therefore requires no changes here.
 */
import { createHash } from 'node:crypto';
import type { EngineCapabilities, UciOptionSpec } from './types.js';
import { EngineVersionError } from './errors.js';

/** Pull a version-like token (e.g. `16.1`, `14`, `240` for a dev build) out of `id name`. */
export function extractVersion(engineName: string): string {
  const match = /(\d+(?:\.\d+){0,3}[a-z]?)/i.exec(engineName);
  return match ? match[1] : 'unknown';
}

/**
 * A stable identity for an engine *build*: `sha256(name + version + sorted option names)`.
 * Attached to every result and used to namespace the analysis cache so results from two
 * different builds can never silently mix.
 */
export function computeFingerprint(name: string, version: string, optionNames: readonly string[]): string {
  const canonical = `${name}\u0000${version}\u0000${[...optionNames].sort().join(',')}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function buildCapabilities(
  idName: string,
  idAuthor: string,
  specs: readonly UciOptionSpec[],
): EngineCapabilities {
  const options = new Map<string, UciOptionSpec>();
  for (const spec of specs) options.set(spec.name, spec);

  const version = extractVersion(idName);
  const fingerprint = computeFingerprint(idName, version, [...options.keys()]);

  const variants = new Set<string>();
  const variantOption = options.get('UCI_Variant');
  if (variantOption?.vars && variantOption.vars.length > 0) {
    for (const variant of variantOption.vars) variants.add(variant);
  } else {
    variants.add('chess');
    if (options.has('UCI_Chess960')) variants.add('chess960');
  }

  const threads = options.get('Threads');
  const hash = options.get('Hash');

  return {
    engineName: idName,
    engineAuthor: idAuthor,
    version,
    fingerprint,
    variants,
    options,
    supportsMultiPv: options.has('MultiPV'),
    supportsLimitStrength: options.has('UCI_LimitStrength'),
    supportsSkillLevel: options.has('Skill Level'),
    supportsPonder: options.has('Ponder'),
    ...(threads?.max !== undefined ? { maxThreads: threads.max } : {}),
    ...(hash?.max !== undefined ? { maxHashMb: hash.max } : {}),
  };
}

function normalize(part: number | undefined): number {
  return part === undefined || Number.isNaN(part) ? 0 : part;
}

/** Semantic-ish comparison of dotted numeric versions. Returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10));
  const pb = b.split('.').map((x) => parseInt(x, 10));
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const x = normalize(pa[i]);
    const y = normalize(pb[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Enforce a minimum engine version. An unparseable version cannot be proven to violate
 * the floor, so it is allowed (the caller may treat it as a degraded-health signal),
 * but a parseable version below the floor is rejected outright.
 */
export function negotiateVersion(caps: EngineCapabilities, minVersion: string): void {
  if (caps.version === 'unknown') return;
  if (compareVersions(caps.version, minVersion) < 0) {
    throw new EngineVersionError(
      `Engine "${caps.engineName}" version ${caps.version} is below the required minimum ${minVersion}.`,
    );
  }
}
