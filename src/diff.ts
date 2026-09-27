import type { VectorDiff } from './types'
/** Apply the complete Rust SDK vector-diff protocol in order. */
export function applyDiffs<T>(previous: readonly T[], updates: readonly VectorDiff<T>[]): T[] {
  let next = [...previous]
  for (const { tag, inner: value } of updates) {
    switch (tag) {
      case 'Append': next.push(...value!.values!); break
      case 'Clear': next = []; break
      case 'PushFront': next.unshift(value!.value!); break
      case 'PushBack': next.push(value!.value!); break
      case 'PopFront': next.shift(); break
      case 'PopBack': next.pop(); break
      case 'Insert': next.splice(value!.index!, 0, value!.value!); break
      case 'Set': next[value!.index!] = value!.value!; break
      case 'Remove': next.splice(value!.index!, 1); break
      case 'Truncate': next.length = Math.min(next.length, value!.length!); break
      case 'Reset': next = [...value!.values!]; break
      default: throw new Error(`Unsupported SDK vector update: ${tag}`)
    }
  }
  return next
}
