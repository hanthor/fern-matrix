import { describe, expect, it } from 'vitest'
import { applyDiffs } from '../src/diff'
describe('Rust SDK timeline vector updates', () => {
  it('keeps earlier messages and local echoes ordered across a batched sync', () => {
    const before = ['remote-1', 'local-2']
    const after = applyDiffs(before, [
      { tag: 'PushFront', inner: { value: 'older-1' } },
      { tag: 'Set', inner: { index: 2, value: 'remote-2' } },
      { tag: 'Append', inner: { values: ['remote-3', 'remote-4'] } },
      { tag: 'Remove', inner: { index: 3 } },
    ])
    expect(after).toEqual(['older-1', 'remote-1', 'remote-2', 'remote-4'])
    expect(before).toEqual(['remote-1', 'local-2'])
  })
  it('handles reset, insertion, truncation and both ends without gaps', () => {
    expect(applyDiffs<number>([], [
      { tag: 'Reset', inner: { values: [1, 3] } }, { tag: 'Insert', inner: { index: 1, value: 2 } },
      { tag: 'PushBack', inner: { value: 4 } }, { tag: 'Truncate', inner: { length: 3 } },
      { tag: 'PopFront' }, { tag: 'PopBack' },
    ])).toEqual([2])
    expect(applyDiffs([1, 2], [{ tag: 'Clear' }])).toEqual([])
    expect(applyDiffs([1], [{ tag: 'Truncate', inner: { length: 5 } }])).toEqual([1])
  })
})
