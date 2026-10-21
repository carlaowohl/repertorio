# Repertório — contexto para o Claude

App pessoal do Carlão (músico) para tablet Android: letras de música em imagem, organizadas por banda, e repertórios para tocar na sequência do show. PWA, funciona offline. Responder em português.

- Publicado: https://carlaowohl.github.io/repertorio/ (GitHub Pages, branch `main`, raiz). Todo push em `main` publica.
- Repositório público: só código. Letras e repertórios ficam no IndexedDB do aparelho e nunca vão para o repo.
- HTML/CSS/JS puro, sem build e sem dependências (a máquina principal não tem Node nem Python).

## Estrutura
- `js/app.js` — telas (hash routes `#/musicas`, `#/repertorios`, `#/repertorio/:id`, `#/colar`, `#/artistas`, `#/show/:id/:i`, `#/ver/:id`), diálogos, modo show.
- `js/db.js` — IndexedDB (`songs`, `pages`, `setlists`).
- `js/importer.js` — lê `Banda - Música 2.jpg` (número final = página), reduz para JPEG 2400px.
- `js/matcher.js` — "Montar pela lista": texto colado do grupo → sequência, com busca aproximada.
- `js/artists.js` — sugere artista via MusicBrainz (soma gravações por artista, 1 req/s).
- `js/backup.js` — exporta/importa tudo num `.json`.
- `sw.js` — cache offline. **Ao mudar qualquer arquivo, subir `CACHE` (`repertorio-vN`) e listar arquivos novos em `ASSETS`.**

## Testar
- `servir.ps1` sobe http://localhost:8080. Testes automáticos em `/tests/teste.html` (devem dar "RESULTADO: TUDO OK").
- `chrome --dump-dom` não espera o IndexedDB; para ler o resultado no headless, usar o DevTools Protocol (`--remote-debugging-port`) e avaliar `#out`.
- Nunca usar letras reais em testes, só imagens geradas com texto genérico.

## Ideias combinadas para as próximas versões
1. Sincronização via pasta do Google Drive (precisa de OAuth client ID no Google Cloud).
2. Anotações por música no repertório (tom, capo, "BIS") mostradas no show.
3. Zoom, brilho e cores invertidas no modo show.
4. Histórico de shows.
5. Exportar o repertório como texto para mandar no grupo.
