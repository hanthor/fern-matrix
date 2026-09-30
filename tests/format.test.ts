import { describe, expect, it } from 'vitest'
import {
  extractMentions,
  linkifyText,
  markdownToHtml,
  parsePermalink,
  sanitizeHtml,
  stripReplyFallback,
} from '../src/format'

describe('markdown composition', () => {
  it('returns undefined for plain text so the wire format stays plain', () => {
    expect(markdownToHtml('Hello world')).toBeUndefined()
    expect(markdownToHtml('a & b <c> "quoted"')).toBeUndefined()
  })
  it('renders bold, italic, strikethrough and inline code', () => {
    expect(markdownToHtml('**bold** and *italic*')).toBe('<p><strong>bold</strong> and <em>italic</em></p>')
    expect(markdownToHtml('~~gone~~ and `code()`')).toBe('<p><del>gone</del> and <code>code()</code></p>')
  })
  it('does not format markers inside code spans', () => {
    expect(markdownToHtml('`**not bold**`')).toBe('<p><code>**not bold**</code></p>')
  })
  it('renders fenced code blocks without inner formatting', () => {
    expect(markdownToHtml('```\n**raw** <b>html</b>\n```')).toBe('<pre><code>**raw** &lt;b&gt;html&lt;/b&gt;\n</code></pre>')
  })
  it('renders links, autolinks and blockquotes', () => {
    expect(markdownToHtml('[Fern](https://fern.example)')).toBe('<p><a href="https://fern.example">Fern</a></p>')
    expect(markdownToHtml('see https://matrix.org now')).toBe('<p>see <a href="https://matrix.org">https://matrix.org</a> now</p>')
    expect(markdownToHtml('> quoted')).toBe('<blockquote>quoted</blockquote>')
  })
  it('renders unordered lists and keeps raw HTML plain', () => {
    expect(markdownToHtml('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>')
    expect(markdownToHtml('<script>alert(1)</script>')).toBeUndefined()
  })
})

describe('html sanitizer', () => {
  it('keeps the reviewed formatting subset', () => {
    const input = '<b>b</b><i>i</i><u>u</u><s>s</s><code>c</code><pre>block</pre>' +
      '<blockquote>q</blockquote><ul><li>a</li></ul><ol start="3"><li>b</li></ol>' +
      '<sub>1</sub><sup>2</sup><br><hr><a href="https://matrix.org">m</a>'
    const out = sanitizeHtml(input)
    expect(out).toContain('<strong>b</strong>')
    expect(out).toContain('<em>i</em>')
    expect(out).toContain('<a href="https://matrix.org"')
  })
  it('drops script, style, svg, image and event handlers but keeps text', () => {
    expect(sanitizeHtml('<script>alert(1)</script>hi')).toBe('hi')
    expect(sanitizeHtml('<img src=x onerror=alert(1) alt="pic">hi')).toBe('hi')
    expect(sanitizeHtml('<svg><g onload=alert(1)><circle/></g></svg>hi')).toBe('hi')
    expect(sanitizeHtml('<b onmouseover="alert(1)">x</b>')).toBe('<strong>x</strong>')
    expect(sanitizeHtml('<a href="https://x.example" onclick="alert(1)">x</a>')).toContain('href="https://x.example"')
    expect(sanitizeHtml('<a href="https://x.example" onclick="alert(1)">x</a>')).not.toContain('onclick')
  })
  it('rejects dangerous link schemes including obfuscated ones', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)',
      '&#106;avascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
      const out = sanitizeHtml(`<a href="${href}">x</a>`)
      expect(out).not.toContain('href=')
      expect(out).toContain('x')
    }
  })
  it('allows matrix: pill links and keeps safe font colors and spoilers', () => {
    expect(sanitizeHtml('<a href="https://matrix.to/#/@a:b">A</a>')).toContain('href="https://matrix.to/#/@a:b"')
    expect(sanitizeHtml('<font color="red">r</font>')).toContain('color="red"')
    expect(sanitizeHtml('<font color="#12ab34">r</font>')).toContain('color="#12ab34"')
    expect(sanitizeHtml('<font color="expression(alert(1))">r</font>')).not.toContain('color=')
    expect(sanitizeHtml('<span data-mx-spoiler="reason">s</span>')).toContain('data-mx-spoiler')
    expect(sanitizeHtml('<span class="x" data-mx-spoiler>s</span>')).not.toContain('class=')
  })
  it('strips reply fallbacks and comments while keeping surrounding text', () => {
    expect(sanitizeHtml('<mx-reply><blockquote>old</blockquote></mx-reply>new')).toBe('new')
    expect(sanitizeHtml('a<!-- comment -->b')).toBe('ab')
  })
  it('forces safe external link behavior', () => {
    const out = sanitizeHtml('<a href="https://evil.example">x</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener"')
  })
  it('survives unclosed and nested hostile markup', () => {
    expect(sanitizeHtml('<b>bold<script>alert(1)</script>')).toBe('<strong>bold</strong>')
    expect(sanitizeHtml('<<script>script>alert(1)<</script>/script>ok')).toContain('ok')
    expect(sanitizeHtml('<a href="https://x.example">a<b>b</a>c</b>d')).toContain('d')
  })
})

describe('plain-text linkification', () => {
  it('escapes text and linkifies bare urls and room aliases', () => {
    expect(linkifyText('a < b & "c"')).toBe('a &lt; b &amp; &quot;c&quot;')
    const out = linkifyText('join #room:example.org or visit https://matrix.org')
    expect(out).toContain('<a href="https://matrix.to/#/#room:example.org" target="_blank" rel="noopener">#room:example.org</a>')
    expect(out).toContain('<a href="https://matrix.org"')
  })
  it('does not linkify dangerous schemes', () => {
    expect(linkifyText('javascript:alert(1)')).not.toContain('<a')
  })
})

describe('reply fallback stripping', () => {
  it('removes the spec fallback prefix from plain bodies', () => {
    const body = '> <@alice:example.org> original line\n> second line\n\nActual reply'
    expect(stripReplyFallback(body)).toBe('Actual reply')
  })
  it('leaves ordinary quotes and mention lines alone', () => {
    expect(stripReplyFallback('> just a quote')).toBe('> just a quote')
    expect(stripReplyFallback('hello\n\n> later quote')).toBe('hello\n\n> later quote')
  })
})

describe('permalink parsing', () => {
  it('parses room, user and event links with via servers', () => {
    expect(parsePermalink('https://matrix.to/#/#room:example.org?via=a.org&via=b.org'))
      .toEqual({ kind: 'room', target: '#room:example.org', via: ['a.org', 'b.org'] })
    expect(parsePermalink('https://matrix.to/#/@user:example.org'))
      .toEqual({ kind: 'user', target: '@user:example.org', via: [] })
    expect(parsePermalink('https://matrix.to/#/!abc:example.org/$event1?via=a.org'))
      .toEqual({ kind: 'event', target: '!abc:example.org', eventId: '$event1', via: ['a.org'] })
  })
  it('rejects non-permalink urls', () => {
    expect(parsePermalink('https://matrix.org')).toBeUndefined()
    expect(parsePermalink('https://matrix.to/#/not-a-sigil')).toBeUndefined()
    expect(parsePermalink('javascript:alert(1)')).toBeUndefined()
  })
})

describe('mention extraction', () => {
  it('finds user pills and room mentions without duplicates', () => {
    const source = 'hi [@Bob](https://matrix.to/#/@bob:example.org) and @room, [@Bob](https://matrix.to/#/@bob:example.org) again'
    expect(extractMentions(source)).toEqual({ userIds: ['@bob:example.org'], room: true })
  })
  it('ignores emails and bare @names', () => {
    expect(extractMentions('mail me at bob@example.org or @bob')).toEqual({ userIds: [], room: false })
  })
})
