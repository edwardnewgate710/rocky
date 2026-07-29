export type Vector = readonly number[];

function assertFinite(v: Vector): void {
  for (let i = 0; i < v.length; i++) {
    const val = v[i];
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new RangeError(`Vector element at index ${i} is non-finite: ${val}`);
    }
  }
}

/**
 * Computes the dot product of two vectors of equal dimension.
 * Throws RangeError if dimensions mismatch or if any component is non-finite.
 */
export function dot(a: Vector, b: Vector): number {
  assertFinite(a);
  assertFinite(b);
  if (a.length !== b.length) {
    throw new RangeError(`Vector dimension mismatch: ${a.length} !== ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/** Largest absolute component, used to scale away overflow before squaring. See cosineSimilarity. */
function maxAbs(v: Vector): number {
  let max = 0;
  for (let i = 0; i < v.length; i++) {
    const abs = Math.abs(v[i]);
    if (abs > max) {
      max = abs;
    }
  }
  return max;
}

/**
 * Computes the Euclidean (L2) norm of a vector.
 * Throws RangeError if any component is non-finite.
 *
 * May return Infinity when the true norm exceeds Number.MAX_VALUE (e.g. [MAX_VALUE, MAX_VALUE]);
 * that is the honest IEEE-754 answer for a value that does not fit a double. Callers that only
 * need a RATIO of magnitudes must not go through this function — see cosineSimilarity/normalize,
 * which scale first so the ratio stays exact.
 */
export function magnitude(v: Vector): number {
  assertFinite(v);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i] * v[i];
  }
  return Math.sqrt(sum);
}

/**
 * Computes the cosine similarity of two vectors of equal dimension, returning a value in [-1, 1].
 * Returns 0 if either vector has zero magnitude or if vectors are empty.
 * Throws RangeError if dimensions mismatch or if any component is non-finite.
 *
 * Each vector is divided by its largest absolute component before anything is squared. Squaring
 * first overflows for perfectly finite inputs — [MAX_VALUE, MAX_VALUE] gives an infinite norm and
 * an Infinity/Infinity score of NaN, which would then poison the ranking that assertFinite exists
 * to protect. Scaling cancels out of the ratio, so the result is unchanged for ordinary inputs;
 * after scaling every component is in [-1, 1], so the sums cannot overflow. The single fused pass
 * also keeps this cheap: it is the inner loop of every semantic query.
 */
export function cosineSimilarity(a: Vector, b: Vector): number {
  assertFinite(a);
  assertFinite(b);
  if (a.length !== b.length) {
    throw new RangeError(`Vector dimension mismatch: ${a.length} !== ${b.length}`);
  }
  const scaleA = maxAbs(a);
  const scaleB = maxAbs(b);
  if (scaleA === 0 || scaleB === 0) {
    return 0;
  }

  let dotSum = 0;
  let sumSqA = 0;
  let sumSqB = 0;
  for (let i = 0; i < a.length; i++) {
    const scaledA = a[i] / scaleA;
    const scaledB = b[i] / scaleB;
    dotSum += scaledA * scaledB;
    sumSqA += scaledA * scaledA;
    sumSqB += scaledB * scaledB;
  }

  // One sqrt of the product, not a product of two sqrts: sqrt(2)*sqrt(2) is 2.0000000000000004,
  // which would make a vector's similarity with itself 0.9999999999999998 instead of exactly 1.
  // After scaling both sums are at most the dimension count, so their product cannot overflow.
  const sim = dotSum / Math.sqrt(sumSqA * sumSqB);
  return Math.min(1, Math.max(-1, sim));
}

/**
 * Returns the L2-normalized unit vector.
 * Returns a zero vector of equal length if input vector has zero magnitude.
 * Returns [] for an empty vector.
 * Throws RangeError if any component is non-finite.
 *
 * Scales by the largest absolute component first, for the same reason as cosineSimilarity: an
 * overflowing norm would divide every component by Infinity and silently hand back a zero vector
 * for a perfectly good input.
 */
export function normalize(v: Vector): Vector {
  assertFinite(v);
  const scale = maxAbs(v);
  if (scale === 0) {
    return new Array(v.length).fill(0);
  }

  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const scaled = v[i] / scale;
    sumSq += scaled * scaled;
  }
  const scaledMagnitude = Math.sqrt(sumSq);

  return v.map((x) => x / scale / scaledMagnitude);
}
