import * as db from './db.js';
import { importFiles, NO_BAND } from './importer.js';
import { exportBackup, importBackup } from './backup.js';
import { matchList, collapse, splitTitle } from './matcher.js';
import { suggestArtists } from './artists.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const dlg = $('#dlg');

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
const byTitle = (a, b) => collator.compare(a.title, b.title);
const byBand = (a, b) =>
  (a === NO_BAND) - (b === NO_BAND) || collator.compare(a, b);

const prefs = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), ms);
}

// ---------- diálogos ----------

function openDialog(html, onSubmit) {
  dlg.innerHTML = `<form method="dialog">${html}</form>`;
  const form = $('form', dlg);
  const done = new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const action = e.submitter?.value || 'ok';
      if (action !== 'cancel' && onSubmit && (await onSubmit(action, form)) === false) return;
      resolve(action === 'cancel' ? null : action);
      dlg.close();
    });
    dlg.addEventListener('close', () => resolve(null), { once: true });
  });
  dlg.showModal();
  $('[autofocus]', dlg)?.focus();
  return done;
}

async function askText(title, value = '', okLabel = 'Salvar') {
  let result = null;
  await openDialog(
    `<h2>${esc(title)}</h2>
     <input name="v" value="${esc(value)}" autofocus required>
     <div class="dlg-actions">
       <button class="btn" value="cancel" formnovalidate>Cancelar</button>
       <button class="btn primary" value="ok">${esc(okLabel)}</button>
     </div>`,
    (_, form) => { result = form.v.value.trim(); }
  );
  return result || null;
}

async function confirmBox(msg, okLabel = 'Confirmar', danger = false) {
  const r = await openDialog(
    `<p>${esc(msg)}</p>
     <div class="dlg-actions">
       <button class="btn" value="cancel">Cancelar</button>
       <button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(okLabel)}</button>
     </div>`
  );
  return r === 'ok';
}

// ---------- roteamento ----------

const routes = [
  [/^#\/repertorios$/, () => renderSetlists()],
  [/^#\/colar$/, () => renderPaste()],
  [/^#\/artistas$/, () => renderArtists()],
  [/^#\/repertorio\/([\w]+)$/, (id) => renderSetlist(id)],
  [/^#\/show\/([\w]+)(?:\/(\d+))?$/, (id, i) => startShow({ setlistId: id, start: +(i || 0) })],
  [/^#\/ver\/([\w]+)$/, (id) => startShow({ songId: id })],
  [/.*/, () => renderLibrary()],
];

function route() {
  const hash = location.hash || '#/musicas';
  if (!hash.startsWith('#/show') && !hash.startsWith('#/ver')) stopShow();
  const tab = hash.startsWith('#/repertorio') || hash === '#/colar' ? 'repertorios' : 'musicas';
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) return fn(...m.slice(1));
  }
}
window.addEventListener('hashchange', route);

// ---------- biblioteca ----------

const libState = { q: '', band: '' };

async function renderLibrary() {
  const songs = await db.getAll('songs');
  if (!songs.length) {
    view.innerHTML = `
      <div class="empty">
        <h2>Nenhuma música ainda</h2>
        <p>Importe as imagens das letras. O nome do arquivo organiza tudo:</p>
        <code>Banda - Nome da Música 1.jpg</code>
        <code>Banda - Nome da Música 2.jpg</code>
        <p class="muted">Números no final viram páginas da mesma música. Se importar uma pasta, o nome da pasta vira a banda quando o arquivo não tiver “Banda - ”.</p>
        <div class="row">
          <button class="btn primary" data-action="import">Importar imagens</button>
          <button class="btn" data-action="import-folder">Importar pasta</button>
          <button class="btn" data-action="restore">Restaurar backup</button>
        </div>
      </div>`;
    return;
  }

  const bands = [...new Set(songs.map((s) => s.band))].sort(byBand);
  const noBand = songs.filter((s) => s.band === NO_BAND).length;
  view.innerHTML = `
    ${noBand ? `<a class="banner" href="#/artistas">
      <span><b>${noBand} música${noBand === 1 ? '' : 's'} sem banda.</b> O app pode sugerir o artista de cada uma.</span>
      <span class="btn small primary">Completar artistas</span>
    </a>` : ''}
    <div class="toolbar">
      <input type="search" id="q" placeholder="Buscar música ou banda…" value="${esc(libState.q)}" autocomplete="off">
      <span class="muted count"></span>
    </div>
    <div class="chips">
      <button class="chip ${libState.band ? '' : 'on'}" data-band="">Todas</button>
      ${bands.map((b) => `<button class="chip ${libState.band === b ? 'on' : ''}" data-band="${esc(b)}">${esc(b)}</button>`).join('')}
    </div>
    <div id="list"></div>`;

  const draw = () => {
    const q = norm(libState.q.trim());
    const filtered = songs.filter(
      (s) => (!libState.band || s.band === libState.band) &&
        (!q || norm(s.title).includes(q) || norm(s.band).includes(q))
    );
    $('.count', view).textContent = `${filtered.length} música${filtered.length === 1 ? '' : 's'}`;
    const groups = new Map();
    filtered.forEach((s) => (groups.get(s.band) || groups.set(s.band, []).get(s.band)).push(s));
    $('#list', view).innerHTML = [...groups.keys()].sort(byBand).map((band) => `
      <section class="group">
        <h3>${esc(band)}</h3>
        ${groups.get(band).sort(byTitle).map((s) => `
          <div class="song" data-id="${s.id}">
            <a class="song-main" href="#/ver/${s.id}">
              <span class="song-title">${esc(s.title)}</span>
              ${s.pageCount > 1 ? `<span class="badge">${s.pageCount} págs</span>` : ''}
            </a>
            <button class="btn small" data-song="add">+ Repertório</button>
            <button class="btn small icon" data-song="edit" aria-label="Editar">✎</button>
          </div>`).join('')}
      </section>`).join('') || '<p class="muted pad">Nada encontrado.</p>';
  };
  draw();

  $('#q', view).addEventListener('input', (e) => { libState.q = e.target.value; draw(); });
  $('.chips', view).addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    libState.band = chip.dataset.band;
    view.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
    draw();
  });
  $('#list', view).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-song]');
    if (!btn) return;
    const song = songs.find((s) => s.id === btn.closest('.song').dataset.id);
    if (btn.dataset.song === 'add') await addToSetlistDialog(song);
    if (btn.dataset.song === 'edit') await editSongDialog(song);
  });
}

async function editSongDialog(song) {
  const r = await openDialog(
    `<h2>Editar música</h2>
     <label>Banda<input name="band" value="${esc(song.band)}" required></label>
     <label>Título<input name="title" value="${esc(song.title)}" required autofocus></label>
     <p class="muted">${song.pageCount} página${song.pageCount === 1 ? '' : 's'}</p>
     <div class="dlg-actions">
       <button class="btn danger" value="delete" formnovalidate>Excluir</button>
       <span class="grow"></span>
       <button class="btn" value="cancel" formnovalidate>Cancelar</button>
       <button class="btn primary" value="save">Salvar</button>
     </div>`,
    async (action, form) => {
      if (action !== 'save') return;
      const band = form.band.value.trim();
      const title = form.title.value.trim();
      const key = db.songKey(band, title);
      const clash = await db.findSongByKey(key);
      if (clash && clash.id !== song.id) {
        toast('Já existe uma música com essa banda e título.');
        return false;
      }
      Object.assign(song, { band, title, key, updatedAt: Date.now() });
      await db.put('songs', song);
    }
  );
  if (r === 'delete') {
    if (await confirmBox(`Excluir “${song.title}”? Ela também sai dos repertórios.`, 'Excluir', true)) {
      await db.deleteSong(song.id);
      toast('Música excluída');
    }
  }
  if (r) route();
}

async function addToSetlistDialog(song) {
  const setlists = (await db.getAll('setlists')).sort((a, b) => b.updatedAt - a.updatedAt);
  const r = await openDialog(
    `<h2>Adicionar “${esc(song.title)}”</h2>
     <div class="pick">
       ${setlists.map((sl) => `
         <button class="pick-item" value="sl:${sl.id}">
           <span>${esc(sl.name)}</span>
           <span class="muted">${sl.items.length} músicas${sl.items.includes(song.id) ? ' · já está' : ''}</span>
         </button>`).join('')}
       <button class="pick-item new" value="new">+ Novo repertório</button>
     </div>
     <div class="dlg-actions"><button class="btn" value="cancel">Fechar</button></div>`
  );
  if (!r) return;
  let sl;
  if (r === 'new') {
    const name = await askText('Nome do repertório', '', 'Criar');
    if (!name) return;
    sl = await createSetlist(name);
  } else {
    sl = setlists.find((x) => x.id === r.slice(3));
  }
  sl.items.push(song.id);
  sl.updatedAt = Date.now();
  await db.put('setlists', sl);
  toast(`Adicionada em “${sl.name}” (posição ${sl.items.length})`);
}

// ---------- repertórios ----------

async function createSetlist(name) {
  const sl = { id: db.uid(), name, items: [], createdAt: Date.now(), updatedAt: Date.now() };
  await db.put('setlists', sl);
  return sl;
}

async function renderSetlists() {
  const setlists = (await db.getAll('setlists')).sort((a, b) => b.updatedAt - a.updatedAt);
  view.innerHTML = `
    <div class="toolbar">
      <h2 class="grow">Repertórios</h2>
      <a class="btn primary" href="#/colar">📋 Montar pela lista</a>
      <button class="btn" id="newSl">+ Novo vazio</button>
    </div>
    ${setlists.length ? `<div class="cards">${setlists.map((sl) => `
      <a class="card" href="#/repertorio/${sl.id}">
        <strong>${esc(sl.name)}</strong>
        <span class="muted">${sl.items.length} música${sl.items.length === 1 ? '' : 's'}</span>
      </a>`).join('')}</div>`
      : '<div class="empty"><p>Nenhum repertório ainda. Crie um e adicione as músicas na ordem do show.</p></div>'}`;
  $('#newSl').onclick = async () => {
    const name = await askText('Nome do repertório', '', 'Criar');
    if (!name) return;
    const sl = await createSetlist(name);
    location.hash = `#/repertorio/${sl.id}`;
  };
}

async function renderSetlist(id) {
  const sl = await db.get('setlists', id);
  if (!sl) { location.hash = '#/repertorios'; return; }
  const songs = new Map((await db.getAll('songs')).map((s) => [s.id, s]));
  sl.items = sl.items.filter((sid) => songs.has(sid));

  const save = async () => { sl.updatedAt = Date.now(); await db.put('setlists', sl); };

  view.innerHTML = `
    <div class="toolbar">
      <a class="btn ghost" href="#/repertorios">‹</a>
      <h2 class="grow">${esc(sl.name)}</h2>
      <button class="btn primary big" id="play" ${sl.items.length ? '' : 'disabled'}>▶ Iniciar show</button>
    </div>
    <div class="row wrap">
      <button class="btn" id="addSongs">+ Adicionar músicas</button>
      <button class="btn" id="rename">Renomear</button>
      <button class="btn" id="dup">Duplicar</button>
      <button class="btn danger" id="delSl">Excluir</button>
    </div>
    <ol class="setlist" id="items">
      ${sl.items.map((sid, i) => {
        const s = songs.get(sid);
        return `
        <li data-i="${i}">
          <span class="pos">${i + 1}</span>
          <a class="song-main" href="#/show/${sl.id}/${i}">
            <span class="song-title">${esc(s.title)}</span>
            <span class="muted">${esc(s.band)}${s.pageCount > 1 ? ` · ${s.pageCount} págs` : ''}</span>
          </a>
          <button class="btn small icon" data-mv="-1" ${i === 0 ? 'disabled' : ''} aria-label="Subir">▲</button>
          <button class="btn small icon" data-mv="1" ${i === sl.items.length - 1 ? 'disabled' : ''} aria-label="Descer">▼</button>
          <button class="btn small icon" data-mv="x" aria-label="Remover">✕</button>
        </li>`;
      }).join('')}
    </ol>
    ${sl.items.length ? '' : '<p class="muted pad">Repertório vazio. Toque em “Adicionar músicas”.</p>'}`;

  $('#play').onclick = () => { enterFullscreen(); location.hash = `#/show/${sl.id}/0`; };
  $('#items').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-mv]');
    if (!btn) return;
    const i = +btn.closest('li').dataset.i;
    if (btn.dataset.mv === 'x') sl.items.splice(i, 1);
    else {
      const j = i + +btn.dataset.mv;
      [sl.items[i], sl.items[j]] = [sl.items[j], sl.items[i]];
    }
    await save();
    renderSetlist(id);
  });
  $('#rename').onclick = async () => {
    const name = await askText('Renomear repertório', sl.name);
    if (!name) return;
    sl.name = name;
    await save();
    renderSetlist(id);
  };
  $('#dup').onclick = async () => {
    const copy = await createSetlist(`${sl.name} (cópia)`);
    copy.items = [...sl.items];
    await db.put('setlists', copy);
    location.hash = `#/repertorio/${copy.id}`;
  };
  $('#delSl').onclick = async () => {
    if (!(await confirmBox(`Excluir o repertório “${sl.name}”? As músicas continuam na biblioteca.`, 'Excluir', true))) return;
    await db.del('setlists', sl.id);
    location.hash = '#/repertorios';
  };
  $('#addSongs').onclick = async () => {
    const picked = await pickSongsDialog([...songs.values()], sl.items);
    if (!picked.length) return;
    sl.items.push(...picked);
    await save();
    toast(`${picked.length} música${picked.length === 1 ? '' : 's'} adicionada${picked.length === 1 ? '' : 's'}`);
    renderSetlist(id);
  };
}

// Seleção múltipla: a ordem dos toques vira a ordem no repertório.
async function pickSongsDialog(allSongs, already) {
  const order = [];
  allSongs.sort((a, b) => byBand(a.band, b.band) || byTitle(a, b));
  const done = openDialog(
    `<h2>Adicionar músicas</h2>
     <input type="search" id="pq" placeholder="Buscar…" autocomplete="off">
     <div class="pick tall" id="plist"></div>
     <div class="dlg-actions">
       <span class="muted grow" id="pcount">Toque na ordem em que vão entrar</span>
       <button class="btn" value="cancel">Cancelar</button>
       <button class="btn primary" value="ok">Adicionar</button>
     </div>`
  );
  bindPicker(allSongs, already, order);
  return (await done) === 'ok' ? order : [];
}

function bindPicker(allSongs, already, order) {
  const list = $('#plist', dlg);
  const draw = () => {
    const q = norm($('#pq', dlg).value.trim());
    list.innerHTML = allSongs
      .filter((s) => !q || norm(s.title).includes(q) || norm(s.band).includes(q))
      .map((s) => {
        const n = order.indexOf(s.id);
        return `<button type="button" class="pick-item ${n >= 0 ? 'sel' : ''}" data-id="${s.id}">
          <span>${n >= 0 ? `<b class="ord">${n + 1}</b>` : ''}${esc(s.title)}</span>
          <span class="muted">${esc(s.band)}${already.includes(s.id) ? ' · já está' : ''}</span>
        </button>`;
      }).join('');
    $('#pcount', dlg).textContent = order.length ? `${order.length} selecionada${order.length === 1 ? '' : 's'}` : 'Toque na ordem em que vão entrar';
  };
  $('#pq', dlg).addEventListener('input', draw);
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.pick-item');
    if (!item) return;
    const n = order.indexOf(item.dataset.id);
    if (n >= 0) order.splice(n, 1); else order.push(item.dataset.id);
    draw();
  });
  draw();
}

// ---------- montar repertório a partir de texto colado ----------

const paste = {
  text: prefs.get('pasteDraft', ''),
  name: '',
  entries: null,
};

const STATUS = {
  ok: ['✅', ''],
  choose: ['⚠️', 'Mesmo nome em mais de uma banda — confira'],
  guess: ['⚠️', 'Sugestão mais parecida — confira'],
  none: ['❌', 'Não encontrada na biblioteca'],
};

async function renderPaste() {
  const songs = await db.getAll('songs');
  const byId = new Map(songs.map((s) => [s.id, s]));

  if (!paste.entries) {
    view.innerHTML = `
      <div class="toolbar">
        <a class="btn ghost" href="#/repertorios">‹</a>
        <h2 class="grow">Montar pela lista</h2>
      </div>
      <div class="paste">
        <p class="muted">Cole a sequência do grupo, uma música por linha. Pode vir numerada, com banda, com negrito ou emoji. Se a primeira linha for o nome do show, ela vira o nome do repertório.</p>
        <textarea id="ptext" rows="12" placeholder="Show Sábado&#10;1. Nome da música&#10;2. Banda - Outra música&#10;3. Música com duas páginas 1&#10;4. Música com duas páginas 2">${esc(paste.text)}</textarea>
        <div class="row wrap flush">
          <button class="btn" id="pclip">Colar da área de transferência</button>
          <span class="grow"></span>
          <button class="btn primary big" id="prun">Montar sequência</button>
        </div>
      </div>`;
    const ta = $('#ptext');
    ta.addEventListener('input', () => { paste.text = ta.value; prefs.set('pasteDraft', ta.value); });
    $('#pclip').onclick = async () => {
      try {
        ta.value = await navigator.clipboard.readText();
        ta.dispatchEvent(new Event('input'));
      } catch {
        toast('Sem acesso à área de transferência. Segure no campo e toque em Colar.');
        ta.focus();
      }
    };
    $('#prun').onclick = () => {
      if (!songs.length) { toast('Importe as músicas antes de montar o repertório.'); return; }
      if (!paste.text.trim()) { toast('Cole a lista primeiro.'); return; }
      const { name, body } = splitTitle(paste.text, songs);
      paste.name = name || `Repertório ${new Date().toLocaleDateString('pt-BR')}`;
      paste.entries = collapse(matchList(body, songs));
      renderPaste();
    };
    return;
  }

  const entries = paste.entries;
  const count = (st) => entries.filter((e) => e.status === st).length;
  const included = entries.filter((e) => e.songId);
  const check = count('choose') + count('guess');

  view.innerHTML = `
    <div class="toolbar">
      <button class="btn ghost" id="pback">‹</button>
      <h2 class="grow">Conferir sequência</h2>
    </div>
    <div class="paste">
      <label class="muted">Nome do repertório<input id="pname" value="${esc(paste.name)}"></label>
      <p class="summary">
        <span>✅ ${count('ok')} encontrada${count('ok') === 1 ? '' : 's'}</span>
        ${check ? `<span>⚠️ ${check} para conferir</span>` : ''}
        ${count('none') ? `<span>❌ ${count('none')} não encontrada${count('none') === 1 ? '' : 's'}</span>` : ''}
      </p>
      <ol class="match" id="mlist">
        ${entries.map((e, i) => {
          const [icon, hint] = STATUS[e.status];
          const chosen = e.songId && byId.get(e.songId);
          const opts = e.candidates.filter((c) => byId.has(c.song.id));
          if (chosen && !opts.some((c) => c.song.id === chosen.id)) opts.unshift({ song: chosen });
          return `
          <li class="m-${e.status}" data-i="${i}">
            <span class="m-icon">${icon}</span>
            <div class="m-body">
              <div class="m-line">${esc(e.line)}${hint ? ` <span class="m-hint">· ${hint}</span>` : ''}</div>
              <select data-pick>
                ${opts.map((c) => `<option value="${c.song.id}" ${c.song.id === e.songId ? 'selected' : ''}>${esc(c.song.title)} — ${esc(c.song.band)}${c.song.pageCount > 1 ? ` (${c.song.pageCount} págs)` : ''}</option>`).join('')}
                <option value="" ${e.songId ? '' : 'selected'}>— pular esta linha —</option>
                <option value="__search">🔎 Buscar outra música…</option>
              </select>
            </div>
          </li>`;
        }).join('')}
      </ol>
      <div class="row wrap flush sticky-bottom">
        <button class="btn" id="pedit">Editar texto</button>
        <span class="grow"></span>
        <button class="btn primary big" id="pcreate" ${included.length ? '' : 'disabled'}>Criar repertório (${included.length})</button>
      </div>
    </div>`;

  $('#pname').addEventListener('input', (e) => { paste.name = e.target.value; });
  $('#pback').onclick = $('#pedit').onclick = () => { paste.entries = null; renderPaste(); };
  $('#mlist').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-pick]');
    if (!sel) return;
    const entry = entries[+sel.closest('li').dataset.i];
    let id = sel.value;
    if (id === '__search') {
      id = await searchOneDialog(songs, entry.query);
      if (id === null) { renderPaste(); return; }
      if (!entry.candidates.some((c) => c.song.id === id)) entry.candidates.unshift({ song: byId.get(id), score: 0 });
    }
    entry.songId = id || null;
    entry.status = id ? 'ok' : 'none';
    renderPaste();
  });
  $('#pcreate').onclick = async () => {
    const items = collapse(entries).filter((e) => e.songId).map((e) => e.songId);
    const sl = await createSetlist(paste.name.trim() || 'Repertório');
    sl.items = items;
    await db.put('setlists', sl);
    paste.entries = null;
    paste.text = '';
    prefs.set('pasteDraft', '');
    toast(`Repertório criado com ${items.length} música${items.length === 1 ? '' : 's'}`);
    location.hash = `#/repertorio/${sl.id}`;
  };
}

async function searchOneDialog(songs, initial = '') {
  const sorted = [...songs].sort((a, b) => byBand(a.band, b.band) || byTitle(a, b));
  const done = openDialog(
    `<h2>Escolher música</h2>
     <input type="search" id="sq" value="${esc(initial)}" placeholder="Buscar…" autocomplete="off" autofocus>
     <div class="pick tall" id="slist"></div>
     <div class="dlg-actions"><button class="btn" value="cancel">Cancelar</button></div>`
  );
  const input = $('#sq', dlg);
  const draw = () => {
    const words = norm(input.value.trim()).split(/\s+/).filter(Boolean);
    const hits = sorted.filter((s) => {
      const hay = norm(`${s.band} ${s.title}`);
      return words.every((w) => hay.includes(w));
    });
    $('#slist', dlg).innerHTML = (hits.length ? hits : sorted).map((s) =>
      `<button class="pick-item" value="${s.id}"><span>${esc(s.title)}</span><span class="muted">${esc(s.band)}</span></button>`).join('');
  };
  input.addEventListener('input', draw);
  draw();
  return done;
}

// ---------- completar artistas ----------

const artistState = { rows: new Map(), running: false, stop: false };

async function renderArtists() {
  const songs = await db.getAll('songs');
  const pending = songs.filter((s) => s.band === NO_BAND).sort(byTitle);
  const bands = [...new Set(songs.map((s) => s.band))].filter((b) => b !== NO_BAND).sort(byBand);
  const rows = artistState.rows;
  pending.forEach((s) => rows.has(s.id) || rows.set(s.id, { value: '', auto: false, suggestions: null, status: '' }));

  if (!pending.length) {
    view.innerHTML = `
      <div class="toolbar"><a class="btn ghost" href="#/musicas">‹</a><h2 class="grow">Completar artistas</h2></div>
      <div class="empty"><p>Todas as músicas já têm banda. 🎉</p><a class="btn" href="#/musicas">Voltar para Músicas</a></div>`;
    return;
  }

  const filled = () => pending.filter((s) => rows.get(s.id).value.trim()).length;
  const unsearched = () => pending.filter((s) => !rows.get(s.id).suggestions).length;

  view.innerHTML = `
    <div class="toolbar">
      <a class="btn ghost" href="#/musicas">‹</a>
      <h2 class="grow">Completar artistas</h2>
      <button class="btn primary" id="aSearch"></button>
    </div>
    <div class="paste">
      <p class="muted">${pending.length} música${pending.length === 1 ? '' : 's'} sem banda. As sugestões vêm da internet (base pública MusicBrainz) e consideram primeiro as bandas que você já tem. <b>Confira antes de salvar</b> — a mesma música pode ter várias versões.</p>
      <datalist id="bandlist">${bands.map((b) => `<option value="${esc(b)}">`).join('')}</datalist>
      <ol class="match artists" id="alist">
        ${pending.map((s) => `
          <li data-id="${s.id}">
            <div class="m-body">
              <div class="a-title">${esc(s.title)}${s.pageCount > 1 ? ` <span class="badge">${s.pageCount} págs</span>` : ''}</div>
              <input list="bandlist" placeholder="Banda ou artista" data-band>
              <div class="a-sugs"></div>
            </div>
          </li>`).join('')}
      </ol>
      <div class="row wrap flush sticky-bottom">
        <span class="muted" id="aInfo"></span>
        <span class="grow"></span>
        <button class="btn primary big" id="aSave"></button>
      </div>
    </div>`;

  const drawRow = (id) => {
    const li = view.querySelector(`li[data-id="${id}"]`);
    if (!li) return;
    const r = rows.get(id);
    const input = $('[data-band]', li);
    if (document.activeElement !== input) input.value = r.value;
    li.classList.toggle('m-guess', r.auto && !!r.value);
    const sugs = $('.a-sugs', li);
    if (r.status) sugs.innerHTML = `<span class="muted">${esc(r.status)}</span>`;
    else if (r.suggestions?.length) {
      sugs.innerHTML = r.suggestions.map((g) =>
        `<button type="button" class="chip ${g.name === r.value ? 'on' : ''}" data-sug="${esc(g.name)}">${esc(g.name)}${g.known ? ' ★' : ''}</button>`).join('');
    } else if (r.suggestions) sugs.innerHTML = '<span class="muted">Sem sugestão — digite o nome</span>';
    else sugs.innerHTML = '';
  };
  const drawFooter = () => {
    const n = filled();
    $('#aSave').textContent = `Salvar ${n} preenchida${n === 1 ? '' : 's'}`;
    $('#aSave').disabled = !n;
    const u = unsearched();
    $('#aSearch').textContent = artistState.running ? '■ Parar busca' : u ? `🔎 Buscar sugestões (${u})` : '🔎 Buscar de novo';
    $('#aInfo').textContent = artistState.running ? 'Buscando… (1 por segundo)' : '';
  };
  pending.forEach((s) => drawRow(s.id));
  drawFooter();

  $('#alist').addEventListener('input', (e) => {
    const li = e.target.closest('li');
    const r = rows.get(li.dataset.id);
    r.value = e.target.value;
    r.auto = false;
    drawRow(li.dataset.id);
    drawFooter();
  });
  $('#alist').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-sug]');
    if (!chip) return;
    const id = chip.closest('li').dataset.id;
    Object.assign(rows.get(id), { value: chip.dataset.sug, auto: false });
    drawRow(id);
    drawFooter();
  });

  $('#aSearch').onclick = async () => {
    if (artistState.running) { artistState.stop = true; return; }
    if (!navigator.onLine) { toast('Sem internet. Dá para preencher digitando, ou buscar quando conectar.'); return; }
    const todo = unsearched() ? pending.filter((s) => !rows.get(s.id).suggestions) : pending;
    artistState.running = true;
    artistState.stop = false;
    drawFooter();
    for (const s of todo) {
      if (artistState.stop || location.hash !== '#/artistas') break;
      const r = rows.get(s.id);
      r.status = 'buscando…';
      drawRow(s.id);
      try {
        r.suggestions = await suggestArtists(s.title, bands);
        r.status = '';
        if (!r.value && r.suggestions[0]) Object.assign(r, { value: r.suggestions[0].name, auto: true });
      } catch {
        r.status = 'Falhou a busca — tente de novo';
      }
      drawRow(s.id);
      drawFooter();
    }
    artistState.running = false;
    if (location.hash === '#/artistas') drawFooter();
  };

  $('#aSave').onclick = async () => {
    let saved = 0;
    const clashes = [];
    for (const s of pending) {
      const r = rows.get(s.id);
      const band = r.value.trim();
      if (!band || band === NO_BAND) continue;
      const key = db.songKey(band, s.title);
      const clash = await db.findSongByKey(key);
      if (clash && clash.id !== s.id) { clashes.push(s.title); continue; }
      Object.assign(s, { band, key, updatedAt: Date.now() });
      await db.put('songs', s);
      rows.delete(s.id);
      saved++;
    }
    toast(clashes.length
      ? `${saved} salvas. Já existe com essa banda: ${clashes.join(', ')}`
      : `${saved} música${saved === 1 ? '' : 's'} atualizada${saved === 1 ? '' : 's'}`, 4000);
    renderArtists();
  };
}

// ---------- modo show ----------

const show = { pages: [], i: 0, url: null, wake: null, title: '', songs: [] };
const showEl = $('#show');
const showImg = $('#showImg');

function enterFullscreen() {
  document.documentElement.requestFullscreen?.().catch(() => {});
}

async function startShow({ setlistId, songId, start = 0 }) {
  let songIds;
  if (setlistId) {
    const sl = await db.get('setlists', setlistId);
    if (!sl) { location.hash = '#/repertorios'; return; }
    songIds = sl.items;
    show.title = sl.name;
    show.back = `#/repertorio/${sl.id}`;
  } else {
    songIds = [songId];
    show.title = '';
    show.back = '#/musicas';
  }
  const allSongs = new Map((await db.getAll('songs')).map((s) => [s.id, s]));
  show.songs = songIds.map((id) => allSongs.get(id)).filter(Boolean);
  show.pages = [];
  for (const [si, song] of show.songs.entries()) {
    const pages = await db.getPages(song.id);
    pages.forEach((p, pi) => show.pages.push({ si, song, pi, total: pages.length, blob: p.blob }));
  }
  if (!show.pages.length) { toast('Sem páginas para mostrar'); location.hash = show.back; return; }

  const firstOfSong = show.pages.findIndex((p) => p.si === start);
  show.i = Math.max(0, firstOfSong);
  showEl.hidden = false;
  document.body.classList.add('showing');
  showEl.classList.toggle('fit-width', prefs.get('fit', 'screen') === 'width');
  showEl.classList.add('bars');
  hideBarsSoon();
  keepAwake();
  drawPage();
}

function stopShow() {
  if (showEl.hidden) return;
  showEl.hidden = true;
  document.body.classList.remove('showing');
  $('#jumpList').hidden = true;
  if (show.url) URL.revokeObjectURL(show.url);
  show.url = null;
  show.wake?.release().catch(() => {});
  show.wake = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function drawPage() {
  const p = show.pages[show.i];
  if (show.url) URL.revokeObjectURL(show.url);
  show.url = URL.createObjectURL(p.blob);
  showImg.src = show.url;
  $('.show-stage').scrollTo(0, 0);

  const pageInfo = p.total > 1 ? ` · pág ${p.pi + 1}/${p.total}` : '';
  $('[data-show="jump"]').textContent = `${p.song.title}${pageInfo}`;
  $('#showPos').textContent = show.songs.length > 1 ? `${p.si + 1}/${show.songs.length} · ${p.song.band}` : p.song.band;

  const next = show.songs[p.si + 1];
  const lastPage = p.pi === p.total - 1;
  $('#showNext').textContent = lastPage && next ? `Próxima: ${next.title}` : lastPage ? 'Fim' : `continua → pág ${p.pi + 2}`;
  showEl.classList.toggle('last-page', lastPage);
}

function step(d) {
  const j = show.i + d;
  if (j < 0 || j >= show.pages.length) {
    flashBars();
    return;
  }
  show.i = j;
  drawPage();
  if (show.pages[j].pi === 0 && d > 0) flashBars();
}

function flashBars() {
  showEl.classList.add('bars');
  hideBarsSoon();
}

function hideBarsSoon() {
  clearTimeout(show.barTimer);
  show.barTimer = setTimeout(() => {
    if ($('#jumpList').hidden) showEl.classList.remove('bars');
  }, 2500);
}

async function keepAwake() {
  try { show.wake = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (!showEl.hidden && document.visibilityState === 'visible') keepAwake();
});

function openJump() {
  const cur = show.pages[show.i].si;
  const jl = $('#jumpList');
  jl.innerHTML = `<h3>${esc(show.title || 'Músicas')}</h3>` + show.songs.map((s, i) =>
    `<button class="pick-item ${i === cur ? 'sel' : ''}" data-si="${i}">
      <span><b class="ord">${i + 1}</b>${esc(s.title)}</span><span class="muted">${esc(s.band)}</span>
    </button>`).join('');
  jl.hidden = false;
  showEl.classList.add('bars');
  jl.querySelector('.sel')?.scrollIntoView({ block: 'center' });
}

showEl.addEventListener('click', (e) => {
  const jumpItem = e.target.closest('[data-si]');
  if (jumpItem) {
    show.i = show.pages.findIndex((p) => p.si === +jumpItem.dataset.si);
    $('#jumpList').hidden = true;
    drawPage();
    hideBarsSoon();
    return;
  }
  if (!$('#jumpList').hidden && !e.target.closest('#jumpList')) {
    $('#jumpList').hidden = true;
    hideBarsSoon();
    return;
  }
  const a = e.target.closest('[data-show]')?.dataset.show;
  if (a === 'prev') step(-1);
  else if (a === 'next') step(1);
  else if (a === 'toggle') { showEl.classList.toggle('bars'); if (showEl.classList.contains('bars')) hideBarsSoon(); }
  else if (a === 'exit') location.hash = show.back;
  else if (a === 'jump') openJump();
  else if (a === 'fit') {
    const w = !showEl.classList.contains('fit-width');
    showEl.classList.toggle('fit-width', w);
    prefs.set('fit', w ? 'width' : 'screen');
    toast(w ? 'Ajustar à largura (role para ver o resto)' : 'Página inteira na tela', 1600);
    hideBarsSoon();
  }
});

// Swipe horizontal = trocar página.
let touchStart = null;
showEl.addEventListener('pointerdown', (e) => { touchStart = { x: e.clientX, y: e.clientY }; });
showEl.addEventListener('pointerup', (e) => {
  if (!touchStart) return;
  const dx = e.clientX - touchStart.x;
  const dy = e.clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    step(dx < 0 ? 1 : -1);
    showEl.dataset.swiped = '1';
    setTimeout(() => delete showEl.dataset.swiped, 50);
  }
});
showEl.addEventListener('click', (e) => { if (showEl.dataset.swiped) e.stopImmediatePropagation(); }, true);

// Teclado e pedal Bluetooth (a maioria manda setas ou PageUp/PageDown).
document.addEventListener('keydown', (e) => {
  if (showEl.hidden) return;
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); step(1); }
  else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); step(-1); }
  else if (e.key === 'Escape') location.hash = show.back;
});

// ---------- ações globais ----------

async function runImport(files) {
  if (!files.length) return;
  const t = $('#toast');
  clearTimeout(toast.timer);
  t.classList.add('on');
  try {
    const r = await importFiles(files, (n, total) => { t.textContent = `Importando ${n}/${total}…`; });
    toast(`${r.files} imagem${r.files === 1 ? '' : 'ns'} → ${r.songs} música${r.songs === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} arquivo(s) ignorado(s))` : ''}`, 4000);
  } catch (err) {
    toast(`Erro na importação: ${err.message}`, 5000);
  }
  route();
}

$('#fileInput').addEventListener('change', (e) => { runImport(e.target.files); e.target.value = ''; });
$('#folderInput').addEventListener('change', (e) => { runImport(e.target.files); e.target.value = ''; });
$('#backupInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    toast('Restaurando backup…', 60000);
    const r = await importBackup(f, (n) => toast(`Restaurando backup… ${n} páginas`, 60000));
    toast(`Backup restaurado: ${r.songs} músicas, ${r.setlists} repertórios`, 4000);
  } catch (err) {
    toast(err.message, 5000);
  }
  route();
});

async function menuDialog() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const used = est ? `${(est.usage / 1048576).toFixed(0)} MB usados` : '';
  const r = await openDialog(
    `<h2>Opções</h2>
     <div class="pick">
       <button class="pick-item" value="import-folder">Importar pasta inteira</button>
       <button class="pick-item" value="backup">Exportar backup (.json)</button>
       <button class="pick-item" value="restore">Restaurar backup</button>
       <button class="pick-item danger" value="wipe">Apagar tudo deste aparelho</button>
     </div>
     <p class="muted">${used}</p>
     <div class="dlg-actions"><button class="btn" value="cancel">Fechar</button></div>`
  );
  if (r === 'import-folder') $('#folderInput').click();
  if (r === 'restore') $('#backupInput').click();
  if (r === 'backup') { toast('Gerando backup…', 30000); await exportBackup(); toast('Backup gerado'); }
  if (r === 'wipe' && (await confirmBox('Apagar todas as músicas e repertórios deste tablet? Isso não tem volta.', 'Apagar tudo', true))) {
    await db.clearAll();
    toast('Tudo apagado');
    route();
  }
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]')?.dataset.action;
  if (a === 'import') $('#fileInput').click();
  if (a === 'import-folder') $('#folderInput').click();
  if (a === 'restore') $('#backupInput').click();
  if (a === 'menu') menuDialog();
});

// ---------- inicialização ----------

// Pede ao Android para não apagar os dados quando faltar espaço.
navigator.storage?.persist?.().catch(() => {});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

route();
