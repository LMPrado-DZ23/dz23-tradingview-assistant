// O texto que o PAINEL renderiza vem do modelo (ou de um anexo) e vai para `innerHTML` numa página de extensão.
// Extensão tem privilégio alto: XSS aqui não é "alerta chato", é acesso ao gateway e ao token.
//
// Como este teste julga: não procura a palavra "onerror" no texto (isso daria falso positivo no conteúdo ESCAPADO),
// e sim remove as tags que o renderizador PODE gerar e verifica se sobrou qualquer `<` ou `>` — se sobrou, é injeção.
import assert from 'node:assert/strict'
import test from 'node:test'
import { escapeHtml, renderMarkdown } from '../../../extension/copilot/markdown.js'

// Tudo o que o renderizador tem direito de produzir. Qualquer tag fora desta lista é injeção.
const ALLOWED_TAGS = /<\/?(?:p|b|i|br|ul|li|pre|code)(?:\s+data-lang="[^"<]*")?>|<a href="https?:\/\/[^"<]*" target="_blank" rel="noreferrer">|<\/a>/g

function leftoverMarkup (html) {
  return html.replace(ALLOWED_TAGS, '')
}

function assertNoInjection (html, label) {
  const leftover = leftoverMarkup(html)
  assert.equal(/[<>]/.test(leftover), false, `${label}: sobrou marcação crua — ${leftover.slice(0, 120)}`)
  // nenhum href que não seja http(s)
  for (const match of html.matchAll(/href="([^"]*)"/g))
    assert.match(match[1], /^https?:\/\//, `${label}: href não-http — ${match[1]}`)
}

const dangerous = {
  'tag de imagem': '<img src=x onerror=alert(1)>',
  'tag de script': '<script>alert(1)</script>',
  'svg com onload': '<svg onload=alert(1)>',
  'iframe': '<iframe src="javascript:alert(1)"></iframe>',
  'evento em elemento': '<div onmouseover="alert(1)">x</div>',
  'quebra de atributo em link': '[x](https://a.com/"onmouseover="alert(1))',
  'esquema javascript': '[clique](javascript:alert(1))',
  'esquema data': '[clique](data:text/html,<script>alert(1)</script>)',
  'fence com tag': '```html\n</code></pre><img src=x onerror=alert(1)>\n```',
  'marcador interno': '\u00000\u0000<img src=x onerror=alert(1)>',
  'fechamento de paragrafo': '</p><script>alert(1)</script>',
  'entidade dupla': '&lt;img src=x onerror=alert(1)&gt;',
  'negrito com tag': '**<img src=x onerror=alert(1)>**',
  'link com aspas': '[t](https://x.com/" onmouseover="alert(1))',
}

for (const [label, input] of Object.entries(dangerous)) {
  test(`sem HTML executável: ${label}`, () => {
    assertNoInjection(renderMarkdown(input), label)
  })
}

test('escapeHtml cobre os quatro caracteres que importam em atributo e tag', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
})

test('o que é markdown de verdade continua funcionando', () => {
  assert.equal(renderMarkdown('**forte**'), '<p><b>forte</b></p>')
  assert.equal(renderMarkdown('`codigo`'), '<p><code>codigo</code></p>')
  assert.equal(renderMarkdown('- um\n- dois'), '<ul><li>um</li><li>dois</li></ul>')
  assert.match(renderMarkdown('[TradingView](https://tradingview.com)'), /<a href="https:\/\/tradingview\.com" target="_blank" rel="noreferrer">TradingView<\/a>/)
  assert.match(renderMarkdown('```js\nconst a = 1\n```'), /<pre><code data-lang="js">const a = 1<\/code><\/pre>/)
})

test('link legítimo ganha rel=noreferrer, para não vazar a origem da extensão', () => {
  const html = renderMarkdown('[x](https://exemplo.com)')
  assert.match(html, /rel="noreferrer"/)
  assert.match(html, /target="_blank"/)
})

test('bloco de código mostra sinais como texto, não como marcação', () => {
  const html = renderMarkdown('```\nif (a < b && c > d)\n```')
  assert.match(html, /&lt; b &amp;&amp; c &gt; d/)
  assert.equal(/<b>/.test(html), false, 'nada dentro do bloco pode virar marcação')
  assertNoInjection(html, 'bloco de código')
})

test('marcador interno sozinho não injeta conteúdo', () => {
  const html = renderMarkdown('\u00007\u0000')
  assert.equal(/[<>]/.test(leftoverMarkup(html)), false, `sobra: ${html}`)
  assert.equal(/img|script/i.test(leftoverMarkup(html)), false)
})

test('entrada não-texto não quebra o renderizador', () => {
  for (const value of [null, undefined, 0, false, [], {}])
    assert.doesNotThrow(() => renderMarkdown(value), `lançou para ${JSON.stringify(value)}`)
})

test('nenhum caractere de controle passa cru para o HTML', () => {
  const html = renderMarkdown('texto \u0000 com controle')
  assert.equal(leftoverMarkup(html).includes('\u0000'), false, 'marcador interno não pode sobrar no HTML final')
})

test('texto longo e unicode não perdem conteúdo', () => {
  const html = renderMarkdown('📈 ação — análise ' + 'x'.repeat(5000))
  assert.ok(html.includes('📈 ação — análise'))
  assert.ok(html.includes('x'.repeat(100)))
  assertNoInjection(html, 'texto longo')
})
