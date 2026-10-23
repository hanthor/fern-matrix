/**
 * Barnsley's four affine transforms. A seeded generator keeps the artwork
 * stable across mounts and screenshots; paths batch points into 24 SVG nodes.
 */
export function fernPaths(count = 6000): string[] {
  const total = Math.max(0, Math.min(6000, Math.floor(Number.isFinite(count) ? count : 0)))
  const paths = Array.from({ length: 24 }, () => '')
  let seed = 0xfe12
  let x = 0, y = 0
  for (let i = 0; i < total + 32; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const r = seed / 4294967296
    const oldX = x
    if (r < 0.01) { x = 0; y *= 0.16 }
    else if (r < 0.86) { x = 0.85 * x + 0.04 * y; y = -0.04 * oldX + 0.85 * y + 1.6 }
    else if (r < 0.93) { x = 0.2 * x - 0.26 * y; y = 0.23 * oldX + 0.22 * y + 1.6 }
    else { x = -0.15 * x + 0.28 * y; y = 0.26 * oldX + 0.24 * y + 0.44 }
    if (i < 32) continue
    // True fern bounds are asymmetric about its stem; center the silhouette.
    const px = 100 + (x - 0.237) * 22
    const py = 230 - y * 22
    const band = Math.min(23, Math.max(0, Math.floor(y / 10 * 24)))
    paths[band] += `M${px.toFixed(2)} ${py.toFixed(2)}h.65`
  }
  return paths
}
