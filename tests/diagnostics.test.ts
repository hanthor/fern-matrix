import { describe, expect, it } from 'vitest'
import { state, diagnostics } from '../src/store'

describe('credential-safe diagnostics', () => {
  it('exports counts and connection states without secrets or content', () => {
    state.error = 'Login failed for token syt_fake_secret_123'
    const text = JSON.stringify(diagnostics())
    expect(diagnostics().app).toMatch(/^\d+\.\d+\.\d+$/)
    expect(diagnostics().accounts.length).toBeGreaterThan(0)
    for (const account of diagnostics().accounts) {
      expect(Object.keys(account).sort()).toEqual(['connection', 'messages', 'rooms', 'userId'])
      expect(typeof account.rooms).toBe('number')
      expect(typeof account.messages).toBe('number')
    }
    expect(text).not.toContain('syt_fake_secret_123')
    expect(text).not.toContain('passphrase')
    expect(text).not.toContain('Good morning, everyone')
    expect(text).not.toContain('Personal draft')
    state.error = ''
  })
  it('counts rooms and messages per account', () => {
    const home = diagnostics().accounts.find(account => account.userId === '@alex:matrix.org')
    expect(home?.rooms).toBe(state.rooms.filter(room => room.accountId === 'demo-home').length)
  })
})
