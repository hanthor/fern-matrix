import { describe, expect, it } from 'vitest'
import { shieldOf } from '../src/sdk/engine'
import type { ShieldState } from '../src/sdk/generated/matrix_sdk_ffi'

describe('authenticity shield mapping', () => {
  it('presents red shields with the SDK explanation', () => {
    expect(shieldOf({ tag: 'Red', inner: { code: 'UnverifiedIdentity', message: 'Sender identity changed' } } as unknown as ShieldState))
      .toEqual({ level: 'red', message: 'Sender identity changed' })
  })
  it('marks grey shields without details', () => {
    expect(shieldOf({ tag: 'Grey' } as unknown as ShieldState)).toEqual({ level: 'grey' })
  })
  it('shows nothing for clear or missing shields', () => {
    expect(shieldOf({ tag: 'None' } as unknown as ShieldState)).toBeUndefined()
    expect(shieldOf(undefined)).toBeUndefined()
  })
})
