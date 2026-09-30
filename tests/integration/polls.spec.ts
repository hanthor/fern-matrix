import { test, expect, type Page, type Browser } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'

interface FixtureUser { username: string; password: string; userId: string; token: string }
interface Fixture { base: string; version: string; users: FixtureUser[] }
declare global {
  interface Window {
    matrixTest: { engine: MatrixEngine; accounts: Record<string, Account>; rooms: Record<string, Room[]>;
      messages: Record<string, Message[]>; typing: Record<string, string[]>; errors: string[]; stops: (() => void)[];
      verification: { status: string; emojis?: { symbol: string; description: string }[]; numbers?: number[] }[] }
  }
}
const fixture: Fixture = JSON.parse(readFileSync(process.env.FERN_MATRIX_FIXTURE!, 'utf8'))
const [alice, bob, reference] = fixture.users

class NioPeer {
  private child: ChildProcessWithoutNullStreams
  private nextId = 0
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  private closed: Promise<void>
  constructor() {
    this.child = spawn(process.env.FERN_SYNAPSE_PYTHON ?? 'python3', ['tests/integration/nio_peer.py'], { stdio: 'pipe' })
    this.child.stderr.resume()
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      let response: { id?: string; error?: string } & Record<string, unknown>
      try { response = JSON.parse(line) }
      catch { return }
      if (!response.id) return
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      if (response.error) pending.reject(new Error(response.error))
      else pending.resolve(response)
    })
    this.closed = new Promise(resolve => this.child.once('close', () => resolve()))
    this.child.once('error', error => {
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
    this.child.once('close', code => {
      if (code === 0) return
      for (const pending of this.pending.values()) pending.reject(new Error('Independent Matrix test client stopped unexpectedly.'))
      this.pending.clear()
    })
  }
  command(action: string, values: Record<string, unknown> = {}, timeoutMs = 45_000) {
    const id = String(++this.nextId)
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Independent Matrix test client timed out.'))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value) },
        reject: error => { clearTimeout(timeout); reject(error) },
      })
      this.child.stdin.write(JSON.stringify({ id, action, ...values }) + '\n')
    })
  }
  async stop() {
    try { await this.command('stop') } finally { await this.closed }
  }
}

async function boot(page: Page) {
  await page.goto('http://127.0.0.1:5173/tests/integration/client.html')
  await page.evaluate(async () => {
    // @ts-expect-error This path is resolved by Vite in the browser.
    const { MatrixEngine } = await import('/src/sdk/engine.ts')
    const state = { engine: undefined as unknown as MatrixEngine,
      accounts: {}, rooms: {}, messages: {}, typing: {}, errors: [], stops: [], verification: [] } as Window['matrixTest']
    state.engine = new MatrixEngine({
      account: (account: Account) => { state.accounts[account.id] = account },
      rooms: (accountId: string, rooms: Room[]) => { state.rooms[accountId] = rooms },
      error: () => {},
    })
    window.matrixTest = state
  })
}
async function login(page: Page, user: FixtureUser) {
  return page.evaluate(({ base, username, password }) => window.matrixTest.engine.login(base, username, password),
    { base: fixture.base, username: user.username, password: user.password })
}
async function watch(page: Page, accountId: string, roomId: string) {
  await expect.poll(() => page.evaluate(({ accountId, roomId }) =>
    window.matrixTest.rooms[accountId]?.some(room => room.id === roomId && room.membership === 'joined') ?? false,
  { accountId, roomId })).toBe(true)
  await page.evaluate(async ({ accountId, roomId }) => {
    const state = window.matrixTest
    const key = accountId + '/' + roomId
    state.stops.push(await state.engine.watchRoom(accountId, roomId,
      messages => { state.messages[key] = messages }, () => {}))
  }, { accountId, roomId })
}
async function watchThread(page: Page, accountId: string, roomId: string, rootId: string) {
  await page.evaluate(async ({ accountId, roomId, rootId }) => {
    const state = window.matrixTest
    state.stops.push(await state.engine.watchThread(accountId, roomId, rootId,
      messages => { state.messages[accountId + '/' + roomId + '/' + rootId] = messages }))
  }, { accountId, roomId, rootId })
}
function pollOf(page: Page, accountId: string, roomId: string, eventId: string) {
  return page.evaluate(({ accountId, roomId, eventId }) => window.matrixTest.messages[accountId + '/' + roomId]!
    .find(message => message.id === eventId)!.poll!, { accountId, roomId, eventId })
}
async function waitPoll(page: Page, accountId: string, roomId: string, question: string) {
  // Remote-echo replacement swaps the local id for the server id: only the
  // server-echoed item ($ id) is stable enough to vote, end or redact.
  await expect.poll(() => page.evaluate(({ accountId, roomId, question }) =>
    window.matrixTest.messages[accountId + '/' + roomId]?.some(message => message.kind === 'poll' && message.poll?.question === question && message.id.startsWith('$')) ?? false,
  { accountId, roomId, question })).toBe(true)
  return page.evaluate(({ accountId, roomId, question }) => window.matrixTest.messages[accountId + '/' + roomId]!
    .find(message => message.kind === 'poll' && message.poll?.question === question && message.id.startsWith('$'))!, { accountId, roomId, question })
}

test('disclosed and undisclosed polls with votes, withdraw and end', async ({ browser }: { browser: Browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, bob)
    const roomId = await pa.evaluate(({ id, invite }) =>
      window.matrixTest.engine.createRoom(id, 'Polls fixture', 'poll fixture', invite), { id: a, invite: bob.userId })
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id: b, roomId })
    await watch(pa, a, roomId); await watch(pb, b, roomId)

    // Disclosed create replicates to the second account with answers intact.
    await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.poll(id, roomId, 'Lunch?', ['Ramen', 'Salad']),
      { id: a, roomId })
    const created = await waitPoll(pa, a, roomId, 'Lunch?')
    expect(created.poll!.kind).toBe('disclosed')
    expect(created.poll!.ended).toBe(false)
    expect(created.poll!.answers.map(answer => answer.text)).toEqual(['Ramen', 'Salad'])
    expect(created.poll!.answers.every(answer => answer.count === 0)).toBe(true)
    await waitPoll(pb, b, roomId, 'Lunch?')
    const pollId = created.id

    // Vote, change and withdraw replicate across accounts.
    const ramen = (await pollOf(pa, a, roomId, pollId)).answers[0].id
    const salad = (await pollOf(pa, a, roomId, pollId)).answers[1].id
    await pb.evaluate(({ id, roomId, eventId, answer }) =>
      window.matrixTest.engine.vote(id, roomId, eventId, answer), { id: b, roomId, eventId: pollId, answer: ramen })
    await expect.poll(() => pollOf(pa, a, roomId, pollId).then(poll => poll.answers[0].count)).toBe(1)
    expect((await pollOf(pb, b, roomId, pollId)).voted).toBe(ramen)
    await pb.evaluate(({ id, roomId, eventId, answer }) =>
      window.matrixTest.engine.vote(id, roomId, eventId, answer), { id: b, roomId, eventId: pollId, answer: salad })
    await expect.poll(() => pollOf(pa, a, roomId, pollId).then(poll => poll.answers[1].count)).toBe(1)
    expect((await pollOf(pa, a, roomId, pollId)).answers[0].count).toBe(0)
    await pb.evaluate(({ id, roomId, eventId }) => window.matrixTest.engine.withdrawVote(id, roomId, eventId),
      { id: b, roomId, eventId: pollId })
    await expect.poll(() => pollOf(pa, a, roomId, pollId).then(poll => poll.answers[1].count)).toBe(0)
    expect((await pollOf(pb, b, roomId, pollId)).voted).toBeUndefined()

    // Undisclosed create maps the kind on both sides.
    await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.poll(id, roomId, 'Secret?', ['X', 'Y'], 'undisclosed'),
      { id: a, roomId })
    const secret = await waitPoll(pa, a, roomId, 'Secret?')
    expect(secret.poll!.kind).toBe('undisclosed')
    await waitPoll(pb, b, roomId, 'Secret?')
    expect((await pollOf(pb, b, roomId, secret.id)).kind).toBe('undisclosed')

    // Ending replicates; the homeserver accepts any member's end event, so
    // the creator-or-moderator rule is enforced in the Fern UI, not the wire.
    await pa.evaluate(({ id, roomId, eventId }) => window.matrixTest.engine.endPoll(id, roomId, eventId),
      { id: a, roomId, eventId: pollId })
    await expect.poll(() => pollOf(pa, a, roomId, pollId).then(poll => poll.ended)).toBe(true)
    await expect.poll(() => pollOf(pb, b, roomId, pollId).then(poll => poll.ended)).toBe(true)
    await pb.evaluate(({ id, roomId, eventId }) => window.matrixTest.engine.endPoll(id, roomId, eventId),
      { id: b, roomId, eventId: secret.id })
    await expect.poll(() => pollOf(pa, a, roomId, secret.id).then(poll => poll.ended)).toBe(true)
    await pa.evaluate(id => window.matrixTest.engine.dispose(), a)
    await pb.evaluate(id => window.matrixTest.engine.dispose(), b)
  } finally {
    await ca.close(); await cb.close()
  }
})

test('poll interop, edits, redaction and threads', async ({ browser }: { browser: Browser }) => {
  const ca = await browser.newContext()
  const pa = await ca.newPage()
  const nio = new NioPeer()
  let nioStarted = false
  try {
    await boot(pa)
    const a = await login(pa, alice)
    await nio.command('start', { homeserver: fixture.base, username: reference.username, password: reference.password })
    nioStarted = true
    const roomId = await pa.evaluate(({ id, invite }) =>
      window.matrixTest.engine.createRoom(id, 'Poll interop', 'poll interop', invite), { id: a, invite: reference.userId })
    await watch(pa, a, roomId)
    await nio.command('join', { roomId })

    // Independent client -> Fern: raw poll start, response and edit parse.
    await nio.command('send_poll', { roomId, question: 'Nio asks?', answers: [{ id: 'a', text: 'Alpha' }, { id: 'b', text: 'Beta' }] })
    const incoming = await waitPoll(pa, a, roomId, 'Nio asks?')
    expect(incoming.poll!.kind).toBe('disclosed')
    expect(incoming.poll!.answers.map(answer => answer.text)).toEqual(['Alpha', 'Beta'])
    await nio.command('send_poll_response', { roomId, eventId: incoming.id, answers: ['b'] })
    await expect.poll(() => pollOf(pa, a, roomId, incoming.id).then(poll => poll.answers[1].count)).toBe(1)
    await nio.command('send_poll_edit', { roomId, eventId: incoming.id, question: 'Nio asks (edited)?',
      answers: [{ id: 'a', text: 'Alpha' }, { id: 'b', text: 'Beta' }] })
    await expect.poll(() => pollOf(pa, a, roomId, incoming.id).then(poll => poll.edited)).toBe(true)
    await expect.poll(() => pollOf(pa, a, roomId, incoming.id).then(poll => poll.question)).toBe('Nio asks (edited)?')

    // Fern -> independent client: poll start, undisclosed kind and end
    // arrive decrypted on the wire.
    await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.poll(id, roomId, 'Fern asks?', ['Yes', 'No']),
      { id: a, roomId })
    const outgoing = await waitPoll(pa, a, roomId, 'Fern asks?')
    const started = await nio.command('wait_poll', { roomId, type: 'org.matrix.msc3381.poll.start', question: 'Fern asks?' })
    expect(started.decrypted).toBe(true)
    await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.poll(id, roomId, 'Fern secret?', ['S1', 'S2'], 'undisclosed'),
      { id: a, roomId })
    await waitPoll(pa, a, roomId, 'Fern secret?')
    const quiet = await nio.command('wait_poll', { roomId, type: 'org.matrix.msc3381.poll.start', question: 'Fern secret?' })
    expect((((quiet.match as Record<string, Record<string, { kind: string }>>).upoll) as unknown as { kind: string }).kind)
      .toBe('org.matrix.msc3381.poll.undisclosed')
    await pa.evaluate(({ id, roomId, eventId }) => window.matrixTest.engine.endPoll(id, roomId, eventId),
      { id: a, roomId, eventId: outgoing.id })
    const ended = await nio.command('wait_poll', { roomId, type: 'org.matrix.msc3381.poll.end', relatesTo: outgoing.id })
    expect(ended.decrypted).toBe(true)

    // Redacting the start collapses the poll into a removed notice.
    await pa.evaluate(({ id, roomId, messageId }) => window.matrixTest.engine.remove(id, roomId, messageId),
      { id: a, roomId, messageId: incoming.id })
    await expect.poll(() => pa.evaluate(({ id, roomId, eventId }) => window.matrixTest.messages[id + '/' + roomId]!
      .find(message => message.id === eventId)?.body, { id: a, roomId, eventId: incoming.id })).toBe('Message removed')

    // Thread-associated polls: created inside the thread, voted from the
    // room timeline, visible in the thread watch.
    await pa.evaluate(({ id, roomId, body }) => window.matrixTest.engine.send(id, roomId, body),
      { id: a, roomId, body: 'Thread root for polls' })
    await expect.poll(() => pa.evaluate(({ id, roomId }) => window.matrixTest.messages[id + '/' + roomId]
      ?.some(message => message.body === 'Thread root for polls' && message.id.startsWith('$')) ?? false,
    { id: a, roomId })).toBe(true)
    const root = await pa.evaluate(({ id, roomId }) => window.matrixTest.messages[id + '/' + roomId]!
      .find(message => message.body === 'Thread root for polls')!.id, { id: a, roomId })
    await watchThread(pa, a, roomId, root)
    await pa.evaluate(({ id, roomId, rootId }) => window.matrixTest.engine.threadPoll(id, roomId, rootId, 'Thread poll?', ['T1', 'T2']),
      { id: a, roomId, rootId: root })
    await expect.poll(() => pa.evaluate(({ id, roomId, rootId }) =>
      window.matrixTest.messages[id + '/' + roomId + '/' + rootId]?.some(message => message.kind === 'poll' && message.id.startsWith('$')) ?? false,
    { id: a, roomId, rootId: root })).toBe(true)
    const threaded = await pa.evaluate(({ id, roomId, rootId }) => window.matrixTest.messages[id + '/' + roomId + '/' + rootId]!
      .find(message => message.kind === 'poll' && message.id.startsWith('$'))!, { id: a, roomId, rootId: root })
    await pa.evaluate(({ id, roomId, rootId, eventId, answer }) =>
      window.matrixTest.engine.threadVote(id, roomId, rootId, eventId, answer),
    { id: a, roomId, rootId: root, eventId: threaded.id, answer: threaded.poll!.answers[0].id })
    await expect.poll(() => pa.evaluate(({ id, roomId, rootId, eventId }) =>
      window.matrixTest.messages[id + '/' + roomId + '/' + rootId]!.find(message => message.id === eventId)!.poll!.answers[0].count,
    { id: a, roomId, rootId: root, eventId: threaded.id })).toBe(1)
    await pa.evaluate(id => window.matrixTest.engine.dispose(), a)
  } finally {
    if (nioStarted) await nio.stop()
    await ca.close()
  }
})
