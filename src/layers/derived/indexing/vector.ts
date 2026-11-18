import { validateEmbeddingVector } from './ranking.js'

/** Cosine search is scale-invariant. Normalize in Float64 before compact storage
 * so finite provider values never overflow or all underflow during conversion. */
export function compactRetrievalVector(input: ArrayLike<number>): Float32Array {
  const dimensions = validateEmbeddingVector(input)
  let scale = 0
  for (let index = 0; index < dimensions; index++) scale = Math.max(scale, Math.abs(input[index]!))
  let squaredNorm = 0
  for (let index = 0; index < dimensions; index++) squaredNorm += (input[index]! / scale) ** 2
  const norm = Math.sqrt(squaredNorm)
  const vector = new Float32Array(dimensions)
  for (let index = 0; index < dimensions; index++) vector[index] = (input[index]! / scale) / norm
  return vector
}
