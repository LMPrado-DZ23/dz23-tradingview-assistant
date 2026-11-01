// Renderizador de Markdown do painel — código de segurança, por isso mora em módulo próprio e tem teste direto.
//
// O texto vem do MODELO (ou de um anexo do usuário) e vai para `innerHTML` numa página de extensão, que tem privilégio
// alto. A regra é uma só: escapar PRIMEIRO, formatar depois. Nenhuma tag do texto sobrevive; o HTML que aparece é o que
// este arquivo gera.

export function escapeHtml (text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Subconjunto pequeno de Markdown: blocos de código, código inline, negrito, itálico, links http(s) e listas.
export function renderMarkdown (text) {
  const blocks = []
  let source = String(text ?? '').replace(/\r\n/g, '\n')
  source = source.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, language, code) => {
    blocks.push(`<pre><code data-lang="${escapeHtml(language)}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
    return `\u0000${blocks.length - 1}\u0000`
  })
  let html = escapeHtml(source)
  html = html
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  html = html
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph.split('\n')
      if (lines.every((line) => /^\s*[-*]\s+/.test(line) || !line.trim()))
        return `<ul>${lines.filter((line) => line.trim()).map((line) => `<li>${line.replace(/^\s*[-*]\s+/, '')}</li>`).join('')}</ul>`
      return `<p>${lines.join('<br>')}</p>`
    })
    .join('')
  // O marcador \u0000N\u0000 só pode devolver um bloco que ESTE arquivo guardou: texto do modelo não injeta HTML por ele.
  return html
    .replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)] ?? '')
    .replace(/\u0000/g, '')
}
