// Plain-text markdown composition and allowlist HTML sanitizing for Matrix
// formatted messages. Dependency-free and DOM-free so the same code runs in
// the browser and in Node unit tests. The sanitizer is a generator (it emits
// canonical escaped HTML for recognized tags) rather than a DOM round trip.

export interface Permalink {
  kind: 'room' | 'user' | 'event'
  target: string
  eventId?: string
  via: string[]
}

export interface Mentions {
  userIds: string[]
  room: boolean
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ESCAPES[char])
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  colon: ':', semi: ';', tab: '\t', NewLine: '\n',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') || body.startsWith('#X') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return match
      try { return String.fromCodePoint(code) } catch { return match }
    }
    return NAMED_ENTITIES[body] ?? match
  })
}

function isSafeUrl(raw: string): boolean {
  const cleaned = decodeEntities(raw).replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  return cleaned.startsWith('https://') || cleaned.startsWith('http://') || cleaned.startsWith('matrix:')
}

const AUTOLINK = /(^|[\s(>])((?:https?:\/\/)[^\s<>()]+?)([.,;:!?)\]]?(?=[\s<]|$))/g

function inlineMarkdown(source: string, placeholders: string[]): string {
  let working = escapeHtml(source)
  working = working.replace(/`([^`\n]+)`/g, (_, code: string) => {
    placeholders.push(`<code>${code}</code>`)
    return `\u0000${placeholders.length - 1}\u0000`
  })
  working = working.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, href: string) => {
    if (!isSafeUrl(decodeEntities(href))) return match
    return `<a href="${escapeHtml(decodeEntities(href))}">${text}</a>`
  })
  working = working.replace(AUTOLINK, (_, prefix: string, url: string, trail: string) =>
    `${prefix}<a href="${url}">${url}</a>${trail}`)
  working = working.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  working = working.replace(/(^|[\s(>])\*([^*\n]+)\*([)\s.,;:!?]|$)/g, '$1<em>$2</em>$3')
  working = working.replace(/(^|\W)_([^_\n]+)_(\W|$)/g, '$1<em>$2</em>$3')
  working = working.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  return working.replace(/\u0000(\d+)\u0000/g, (_, index: string) => placeholders[Number(index)])
}

function hasMarkdown(source: string): boolean {
  return /`[^`\n]+`|```|\*\*[^*]+\*|~~[^~\n]+~~|\[[^\]]+\]\([^)\s]+\)|^>\s|^- |\n- |^\d+\. |https?:\/\/\S|(^|[\s(>])\*[^*\n]+\*|(^|\W)_[^_\n]+_/.test(source)
}

/** Convert composer markdown to Element-style HTML, or undefined for plain text. */
export function markdownToHtml(source: string): string | undefined {
  if (!hasMarkdown(source)) return undefined
  const placeholders: string[] = []
  const lines = source.split('\n')
  const blocks: string[] = []
  let index = 0
  const flushParagraph = (buffer: string[]) => {
    if (buffer.length) blocks.push(`<p>${inlineMarkdown(buffer.join('<br>'), placeholders)}</p>`)
  }
  let paragraph: string[] = []
  while (index < lines.length) {
    const line = lines[index]
    if (line.startsWith('```')) {
      flushParagraph(paragraph); paragraph = []
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index].startsWith('```')) { code.push(lines[index]); index += 1 }
      index += 1
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}\n</code></pre>`)
      continue
    }
    if (/^\s*$/.test(line)) { flushParagraph(paragraph); paragraph = []; index += 1; continue }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      flushParagraph(paragraph); paragraph = []
      const quoted: string[] = [quote[1]]
      index += 1
      while (index < lines.length) {
        const next = lines[index].match(/^>\s?(.*)$/)
        if (!next) break
        quoted.push(next[1]); index += 1
      }
      blocks.push(`<blockquote>${inlineMarkdown(quoted.join('<br>'), placeholders)}</blockquote>`)
      continue
    }
    const list = line.match(/^(-|\d+\.)\s+(.*)$/)
    if (list) {
      flushParagraph(paragraph); paragraph = []
      const ordered = list[1] !== '-'
      const items: string[] = []
      while (index < lines.length) {
        const next = lines[index].match(/^(-|\d+\.)\s+(.*)$/)
        if (!next) break
        items.push(`<li>${inlineMarkdown(next[2], placeholders)}</li>`); index += 1
      }
      blocks.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }
    paragraph.push(line); index += 1
  }
  flushParagraph(paragraph)
  return blocks.join('')
}

const TAG_MAP: Record<string, string> = {
  b: 'strong', strong: 'strong', i: 'em', em: 'em', u: 'u', s: 'del', strike: 'del', del: 'del',
  code: 'code', pre: 'pre', blockquote: 'blockquote', p: 'p', br: 'br', ul: 'ul', ol: 'ol', li: 'li',
  hr: 'hr', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6', sub: 'sub', sup: 'sup',
  font: 'font', span: 'span', a: 'a',
}
// Elements whose whole subtree is dropped (active content or metadata).
const DROP_SUBTREE = new Set(['script', 'style', 'svg', 'math', 'iframe', 'object', 'embed', 'form',
  'input', 'button', 'select', 'textarea', 'img', 'video', 'audio', 'link', 'meta', 'title', 'head',
  'mx-reply', 'html', 'body'])
const VOID = new Set(['br', 'hr'])
const NAMED_COLORS = new Set(['red', 'green', 'blue', 'orange', 'purple', 'teal', 'pink', 'brown',
  'black', 'white', 'gray', 'grey', 'yellow', 'cyan', 'magenta', 'lime', 'navy', 'olive', 'maroon'])

function parseAttributes(raw: string): [string, string][] {
  const attrs: [string, string][] = []
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) attrs.push([match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? ''])
  return attrs
}

/** Reduce arbitrary HTML to the reviewed Matrix formatting subset. */
export function sanitizeHtml(html: string): string {
  let output = ''
  const stack: string[] = []
  let dropDepth = 0
  let position = 0
  const closeOpen = (name?: string) => {
    while (stack.length) {
      const open = stack.pop()!
      output += `</${open}>`
      if (!name || open === name) break
    }
  }
  while (position < html.length) {
    const next = html.indexOf('<', position)
    if (next < 0) {
      if (!dropDepth) output += escapeHtml(decodeEntities(html.slice(position)))
      break
    }
    if (!dropDepth) output += escapeHtml(decodeEntities(html.slice(position, next)))
    if (html.startsWith('<!--', next)) {
      const end = html.indexOf('-->', next + 4)
      position = end < 0 ? html.length : end + 3
      continue
    }
    const end = html.indexOf('>', next + 1)
    if (end < 0) {
      if (!dropDepth) output += escapeHtml(decodeEntities(html.slice(next)))
      break
    }
    const raw = html.slice(next + 1, end)
    position = end + 1
    const closing = raw.startsWith('/')
    const name = (closing ? raw.slice(1) : raw).trim().split(/[\s/>]/, 1)[0].toLowerCase()
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)?$/.test(name)) continue
    if (closing) {
      if (DROP_SUBTREE.has(name)) { if (dropDepth) dropDepth -= 1; continue }
      if (!dropDepth && TAG_MAP[name] && !VOID.has(TAG_MAP[name])) closeOpen(TAG_MAP[name])
      continue
    }
    if (DROP_SUBTREE.has(name)) {
      if (!raw.trim().endsWith('/') && !['img', 'input', 'link', 'meta', 'br', 'hr'].includes(name)) dropDepth += 1
      continue
    }
    if (dropDepth) continue
    const mapped = TAG_MAP[name]
    if (!mapped) continue
    if (mapped === 'span' || mapped === 'div') {
      if (mapped === 'span') {
        const spoiler = parseAttributes(raw).find(([key]) => key === 'data-mx-spoiler')
        if (!spoiler) continue
        output += `<span data-mx-spoiler="${escapeHtml(decodeEntities(spoiler[1]))}">`
        stack.push('span')
      }
      continue
    }
    if (mapped === 'a') {
      const href = parseAttributes(raw).find(([key]) => key === 'href')?.[1] ?? ''
      const decoded = decodeEntities(href)
      if (!href || !isSafeUrl(href)) continue
      output += `<a href="${escapeHtml(decoded)}" target="_blank" rel="noopener">`
      stack.push('a')
      continue
    }
    if (mapped === 'font') {
      const color = parseAttributes(raw).find(([key]) => key === 'color')?.[1] ?? ''
      const decoded = decodeEntities(color).trim().toLowerCase()
      if (!NAMED_COLORS.has(decoded) && !/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(decoded)) continue
      output += `<font color="${escapeHtml(decoded)}">`
      stack.push('font')
      continue
    }
    if (mapped === 'ol') {
      const start = parseAttributes(raw).find(([key]) => key === 'start')?.[1] ?? ''
      output += /^\d+$/.test(start) && start !== '1' ? `<ol start="${start}">` : '<ol>'
      stack.push('ol')
      continue
    }
    if (VOID.has(mapped)) { output += `<${mapped}>`; continue }
    output += `<${mapped}>`
    stack.push(mapped)
  }
  closeOpen()
  return output
}

/** Escape plain text and linkify URLs, room aliases and user IDs. */
export function linkifyText(text: string): string {
  const escaped = escapeHtml(text)
  return escaped
    .replace(/((?:https?:\/\/)[^\s<>()]+?)([.,;:!?)\]]?(?=[\s<]|$))/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>$2')
    .replace(/(^|[\s(>])(#[^\s<>:]+:[^\s<>,;:!?)\]]+)/g,
      '$1<a href="https://matrix.to/#/$2" target="_blank" rel="noopener">$2</a>')
    .replace(/(^|[\s(>])(@[^\s<>:]+:[^\s<>,;:!?)\]]+)/g,
      '$1<a href="https://matrix.to/#/$2" target="_blank" rel="noopener">$2</a>')
}

/** Remove the Matrix reply-fallback quote prefix from a plain-text body. */
export function stripReplyFallback(body: string): string {
  const lines = body.split('\n')
  if (!/^> <@[^:>\s]+:[^>\s]+> /.test(lines[0] ?? '')) return body
  let index = 0
  while (index < lines.length && lines[index].startsWith('> ')) index += 1
  while (index < lines.length && lines[index].trim() === '') index += 1
  return lines.slice(index).join('\n')
}

/** Parse a matrix.to permalink into a routable target. */
export function parsePermalink(url: string): Permalink | undefined {
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'matrix.to') return undefined
  const hash = parsed.hash.replace(/^#\/?/, '')
  const [path, query] = hash.split('?')
  const segments = path.split('/').map(segment => { try { return decodeURIComponent(segment) } catch { return segment } })
  const via = query ? query.split('&').map(part => part.split('=')) .filter(([key]) => key === 'via').map(([, value]) => value ?? '') : []
  const [first, second] = segments
  if (!first || !/^[@#!+$]/.test(first)) return undefined
  if (first.startsWith('@')) return { kind: 'user', target: first, via }
  if (first.startsWith('#') || first.startsWith('!')) {
    if (second && second.startsWith('$')) return { kind: 'event', target: first, eventId: second, via }
    return { kind: 'room', target: first, via }
  }
  return undefined
}

/** Collect mentioned user IDs (from pills) and @room flags in composer text. */
export function extractMentions(source: string): Mentions {
  const userIds: string[] = []
  const pill = /\[([^\]]*)\]\(https:\/\/matrix\.to\/#\/(@[^\s):]+:[^\s)]+)\)/g
  let match: RegExpExecArray | null
  while ((match = pill.exec(source)) !== null) {
    if (/^@[^\s:]+:[^\s]+$/.test(match[2]) && !userIds.includes(match[2])) userIds.push(match[2])
  }
  return { userIds, room: /(^|[\s>])@room(?![\w:-])/.test(source) }
}
