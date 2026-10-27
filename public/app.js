const $ = (s) => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k.startsWith('on') ? e.addEventListener(k.slice(2), v) : (e[k] = v);
  kids.flat().forEach((c) => e.append(c));
  return e;
};
const fmt = (d) => new Date(d.replace(' ', 'T') + 'Z').toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

let token = localStorage.getItem('unim_token');
let me = null, chatWith = null, poller = null;

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
    body: body && JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Une erreur est survenue');
  return data;
}

// Photo de profil ou initiale
const avatar = (u, size = '') => u.avatar
  ? h('img', { className: 'av ' + size, src: u.avatar, alt: '' })
  : h('span', { className: 'av ' + size, textContent: (u.nom || '?')[0].toUpperCase() });

// Réduit l'image dans le navigateur avant l'envoi
function resize(file, max) {
  return new Promise((ok, ko) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      ok(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => ko(new Error('Image illisible'));
    img.src = URL.createObjectURL(file);
  });
}
const upload = async (file, max) => (await api('/upload', 'POST', { data: await resize(file, max) })).url;

function say(text, type = 'err') {
  const m = $('#auth-msg');
  m.textContent = text;
  m.className = 'msg ' + (text ? type : '');
}

function logout() {
  localStorage.removeItem('unim_token');
  token = me = chatWith = null;
  clearInterval(poller);
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
}

function switchTab(login) {
  $('#login-form').classList.toggle('hidden', !login);
  $('#register-form').classList.toggle('hidden', login);
  $('#tab-login').classList.toggle('on', login);
  $('#tab-register').classList.toggle('on', !login);
  say('');
}
$('#tab-login').onclick = () => switchTab(true);
$('#tab-register').onclick = () => switchTab(false);

$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    token = (await api('/login', 'POST', Object.fromEntries(new FormData(e.target)))).token;
    localStorage.setItem('unim_token', token);
    e.target.reset();
    await boot();
  } catch (err) { say(err.message); }
};

$('#register-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('/register', 'POST', Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    switchTab(true);
    say(r.message, 'ok');
  } catch (err) { say(err.message); }
};

// ----- Navigation -----
const VIEWS = ['feed', 'messages', 'admin'];
function view(name) {
  VIEWS.forEach((v) => {
    $('#' + v).classList.toggle('hidden', v !== name);
    $('#nav-' + v).classList.toggle('on', v === name);
  });
  if (name === 'feed') { loadGroupes(); loadPosts(); }
  if (name === 'messages') loadConvs();
  if (name === 'admin') loadUsers();
}
VIEWS.forEach((v) => ($('#nav-' + v).onclick = () => view(v)));
$('#nav-out').onclick = logout;

$('#avatar-in').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const url = await upload(file, 300);
    await api('/me/avatar', 'PUT', { url });
    me.avatar = url;
    drawMe();
    loadPosts();
  } catch (err) { alert(err.message); }
  e.target.value = '';
};

function drawMe() {
  $('#me-av').replaceChildren(avatar(me, 'sm'));
  $('#me-name').textContent = me.nom;
}

// ----- Fil d'actualité -----
$('#img-in').onchange = (e) => ($('#img-name').textContent = e.target.files[0]?.name || '');

$('#compose').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const body = { content: f.content.value, groupe: f.groupe.value };
    const file = $('#img-in').files[0];
    if (file) body.image = await upload(file, 1000);
    await api('/posts', 'POST', body);
    f.reset();
    $('#img-name').textContent = '';
    loadPosts();
  } catch (err) { alert(err.message); }
};

async function loadGroupes() {
  const list = await api('/groupes');
  const cur = $('#groupe').value || 'all';
  $('#groupe').replaceChildren(
    h('option', { value: 'all', textContent: 'Toutes les publications' }),
    h('option', { value: 'general', textContent: 'Général' }),
    ...list.map((g) => h('option', { value: g, textContent: 'Faculté : ' + g })));
  $('#groupe').value = [...$('#groupe').options].some((o) => o.value === cur) ? cur : 'all';
}
$('#groupe').onchange = loadPosts;

async function loadPosts() {
  const box = $('#posts');
  try {
    const posts = await api('/posts?groupe=' + encodeURIComponent($('#groupe').value || 'all'));
    box.replaceChildren(...(posts.length ? posts.map(postEl) : [h('p', { className: 'empty', textContent: 'Aucune publication ici pour le moment. Lancez la conversation !' })]));
  } catch (err) { box.textContent = err.message; }
}

function postEl(p) {
  const comments = h('div', { className: 'comments hidden' });
  const likeBtn = h('button', {
    className: p.liked ? 'liked' : '',
    textContent: `J'aime (${p.likes})`,
    onclick: async () => { await api(`/posts/${p.id}/like`, 'POST'); loadPosts(); },
  });
  const cBtn = h('button', {
    textContent: `Commentaires (${p.comments})`,
    onclick: () => { comments.classList.toggle('hidden'); if (!comments.classList.contains('hidden')) loadComments(p.id, comments); },
  });
  const acts = h('div', { className: 'acts' }, likeBtn, cBtn);
  if (p.user_id !== me.id) acts.append(h('button', { textContent: 'Écrire', onclick: () => { view('messages'); openChat(p.user_id, p); } }));
  if (p.user_id === me.id || me.role === 'admin')
    acts.append(h('button', {
      className: 'del', textContent: 'Supprimer',
      onclick: async () => { if (confirm('Supprimer cette publication ?')) { await api('/posts/' + p.id, 'DELETE'); loadPosts(); } },
    }));
  return h('article', { className: 'post' },
    h('div', { className: 'who' },
      h('div', { className: 'id' }, avatar(p, 'sm'),
        h('b', { textContent: p.nom + (p.faculte ? ' — ' + p.faculte : '') }),
        p.groupe ? h('span', { className: 'tag', textContent: p.groupe }) : ''),
      h('small', { textContent: fmt(p.created_at) })),
    h('p', { textContent: p.content }),
    p.image ? h('img', { className: 'pic', src: p.image, alt: 'Image jointe à la publication', loading: 'lazy' }) : '',
    acts, comments);
}

async function loadComments(id, box) {
  const list = await api(`/posts/${id}/comments`);
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    if (!e.target.c.value.trim()) return;
    await api(`/posts/${id}/comments`, 'POST', { content: e.target.c.value });
    loadComments(id, box);
  } }, h('input', { name: 'c', placeholder: 'Écrire un commentaire…', maxLength: 500 }), h('button', { className: 'primary', textContent: 'Envoyer' }));
  box.replaceChildren(
    ...list.map((c) => h('div', { className: 'comment' }, h('b', { textContent: c.nom + ' : ' }), c.content)),
    form);
}

// ----- Messagerie privée -----
async function loadConvs() {
  const [convs, users] = await Promise.all([api('/messages/conversations'), api('/users')]);
  const sel = $('#new-chat');
  sel.replaceChildren(h('option', { value: '', textContent: 'Nouvelle conversation…' }),
    ...users.map((u) => h('option', { value: u.id, textContent: u.nom + (u.faculte ? ' — ' + u.faculte : '') })));
  sel.onchange = () => { if (sel.value) { openChat(Number(sel.value), users.find((u) => u.id == sel.value)); sel.value = ''; } };
  $('#convs').replaceChildren(...convs.map((c) => h('button', {
    className: 'conv' + (chatWith && c.id === chatWith.id ? ' on' : ''),
    onclick: () => openChat(c.id, c),
  }, avatar(c, 'sm'), h('span', {}, h('b', { textContent: c.nom }), h('small', { textContent: c.last })),
  c.unread ? h('span', { className: 'badge', textContent: c.unread }) : '')));
}

function openChat(id, u) {
  chatWith = { id, nom: u.nom, avatar: u.avatar };
  $('#chat-empty').classList.add('hidden');
  $('#chat-box').classList.remove('hidden');
  $('#chat-head').replaceChildren(avatar(chatWith, 'sm'), chatWith.nom);
  loadThread();
  loadConvs();
}

async function loadThread() {
  if (!chatWith) return;
  const msgs = await api('/messages/' + chatWith.id);
  const t = $('#thread');
  const atEnd = t.scrollHeight - t.scrollTop - t.clientHeight < 60 || !t.children.length;
  t.replaceChildren(...msgs.map((m) => h('div', { className: 'bubble' + (m.from_id === me.id ? ' mine' : '') },
    m.content, h('small', { textContent: fmt(m.created_at) }))));
  if (atEnd) t.scrollTop = t.scrollHeight;
  refreshUnread();
}

$('#msg-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = e.target.content;
  if (!input.value.trim() || !chatWith) return;
  try {
    await api('/messages/' + chatWith.id, 'POST', { content: input.value });
    input.value = '';
    await loadThread();
    loadConvs();
  } catch (err) { alert(err.message); }
};

async function refreshUnread() {
  const { n } = await api('/messages/unread');
  const b = $('#msg-badge');
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}

// ----- Administration -----
async function loadUsers() {
  if (me.role !== 'admin') return;
  const box = $('#users');
  const list = await api('/admin/users?status=' + $('#filter').value);
  box.replaceChildren(...(list.length ? list.map(userEl) : [h('p', { className: 'empty', textContent: 'Aucun compte dans cette catégorie.' })]));
  refreshBadge();
}
$('#filter').onchange = loadUsers;

function userEl(u) {
  const act = (a) => async () => { await api(`/admin/users/${u.id}/${a}`, 'POST'); loadUsers(); };
  const btns = h('div', { className: 'btns' });
  if (u.status !== 'approved') btns.append(h('button', { className: 'ok-btn', textContent: 'Valider', onclick: act('approve') }));
  if (u.status !== 'rejected') btns.append(h('button', { className: 'no-btn', textContent: 'Refuser', onclick: act('reject') }));
  return h('div', { className: 'user' },
    h('div', {}, h('b', { textContent: u.nom }),
      h('small', { textContent: u.email }),
      h('small', { textContent: [u.matricule && 'Matricule ' + u.matricule, u.faculte, 'Demande du ' + fmt(u.created_at)].filter(Boolean).join(' • ') })),
    btns);
}

async function refreshBadge() {
  const n = (await api('/admin/users?status=pending')).length;
  const b = $('#badge');
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}

// ----- Démarrage -----
async function boot() {
  if (!token) return logout();
  try { me = await api('/me'); }
  catch (err) { logout(); if (err.message) say(err.message); return; }
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#nav-admin').classList.toggle('hidden', me.role !== 'admin');
  $('#compose').groupe.replaceChildren(
    h('option', { value: 'general', textContent: 'Publier dans : Général' }),
    ...(me.faculte ? [h('option', { value: me.faculte, textContent: 'Publier dans : ' + me.faculte })] : []));
  drawMe();
  if (me.role === 'admin') refreshBadge();
  refreshUnread();
  clearInterval(poller);
  poller = setInterval(() => {
    if (!token) return;
    refreshUnread().catch(() => {});
    if (!$('#messages').classList.contains('hidden')) { loadThread().catch(() => {}); loadConvs().catch(() => {}); }
  }, 6000);
  view('feed');
}
boot();
