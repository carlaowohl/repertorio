# Repertório

App para tablet (PWA) com as letras das músicas em imagem, organizadas por banda, e repertórios para tocar na sequência do show. Depois de aberto uma vez, funciona sem internet.

## Nome dos arquivos

```
Banda - Nome da Música 1.jpg
Banda - Nome da Música 2.jpg
```

- O que vem antes de ` - ` é a banda.
- O número no final (separado por espaço, até 2 dígitos) é a página. As páginas viram uma música só, em ordem.
- Sem número = página 1. Sem banda = "Sem banda" (ou o nome da pasta, se importar uma pasta).
- Reimportar o mesmo nome substitui a página, sem duplicar.

## Montar pela lista

Repertórios > **📋 Montar pela lista**: cole a sequência que saiu no grupo, uma música por linha.

- Aceita numeração (`1.`, `2)`, `03 -`), negrito do WhatsApp, emoji e `(tom G)` no final.
- `Banda - Música` resolve quando o mesmo título existe em duas bandas.
- `Música 1` e `Música 2` na lista viram uma entrada só, com todas as páginas em ordem.
- A primeira linha vira o nome do repertório se parecer título (sem número, ou que não bate com nenhuma música).
- Na conferência: ✅ encontrada · ⚠️ sugestão mais parecida ou mesmo nome em duas bandas · ❌ não encontrada. Dá para trocar, buscar outra ou pular cada linha antes de criar.

## No show

- Toque na **direita** = avança · **esquerda** = volta · **meio** = mostra/esconde as barras.
- Deslizar o dedo para os lados também troca de página.
- Pedal Bluetooth: setas ou PageUp/PageDown.
- Toque no título no topo para pular para qualquer música do repertório.
- `⇔` alterna entre página inteira na tela e ajustar à largura (rolando).
- A tela não apaga enquanto o show está aberto.

## Backup

Menu `⋮` > Exportar backup gera um `.json` com tudo (imagens + repertórios). Restaurar mescla com o que já existe.

## Rodar no PC

Clique com o direito em `servir.ps1` > Executar com PowerShell e abra http://localhost:8080.
Testes automáticos: com o servidor rodando, abra http://localhost:8080/tests/teste.html.

## Publicar versão nova

Ao alterar arquivos, aumente o número em `CACHE` no `sw.js` (`repertorio-v2`, `v3`...) para o tablet baixar a atualização.
