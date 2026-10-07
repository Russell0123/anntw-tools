import { GitHubStore, LocalStore } from './store.js';
import { drawCard, canvasToBlob, defaultSplit } from './card.js';
import {
  buildPackage, parseDelivery, formatBody, checkPreserved, headingProblems,
  typoUsable, applyTypos, normTags, finalTitle,
} from './prompts.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const todayTW = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
const hhmmTW = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' }).format(new Date()).replace(':', '');
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';

const SETTINGS_KEY = 'anntw-tools-settings';
const LOCAL = new URLSearchParams(location.search).has('local');

const state = { store: null, news: [], eds: [] };

// ---------- 共用 ----------

let toastTimer;
function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已複製');
}

function download(name, blob) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

function showTab(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  const work = name !== 'settings';
  $('#statusBar').hidden = !work;
  $('.bar.ai').hidden = !work;
}

// ---------- 設定 ----------

function readSettings() {
  try {
    return { owner: 'Russell0123', repo: 'anntw-data', token: '', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { owner: 'Russell0123', repo: 'anntw-data', token: '' };
  }
}

function initSettings() {
  const f = $('#settingsForm');
  const s = readSettings();
  f.owner.value = s.owner;
  f.repo.value = s.repo;
  f.token.value = s.token;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), token: f.token.value.trim() };
    $('#settingsMsg').textContent = '測試中…';
    try {
      const store = new GitHubStore(next);
      await store.check();
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
      state.store = store;
      $('#settingsMsg').textContent = '連線成功';
      showTab('news');
      reloadAll();
    } catch (err) {
      $('#settingsMsg').textContent = `連線失敗：${err.message}`;
    }
  });
}

// ---------- 抓取狀態 ----------

async function loadStatus() {
  const el = $('#fetchStatus');
  const st = await state.store.getJSON('data/status.json').catch(() => null);
  if (!st) {
    el.textContent = '還沒有抓取紀錄';
    return;
  }
  const s = st.data;
  el.classList.toggle('err', !s.ok || s.messages?.length > 0);
  const added = (s.added_cards?.length || 0) + (s.added_drafts?.length || 0);
  el.textContent = `最後抓取 ${fmtTime(s.last_fetch)}　${s.ok ? `✓ 新增 ${added} 篇` : '✗ 失敗'}` +
    (s.messages?.length ? `　${s.messages.join('；')}` : '');
}

// ---------- 新聞圖卡 ----------

function cardValues(d) {
  return {
    title_lines: defaultSplit(d.title),
    social: ['', ''],
    comment: '',
    scale: [1, 1],
    ...(d.ai || {}),
    ...(d.edit || {}),
  };
}

async function loadNews() {
  const date = $('#newsDate').value;
  const list = $('#newsList');
  list.innerHTML = '<p class="muted">讀取中…</p>';
  const files = (await state.store.list(`data/cards/${date}`)).filter((f) => f.name.endsWith('.json'));
  const items = await Promise.all(files.map(async (f) => ({ path: f.path, ...(await state.store.getJSON(f.path)) })));
  state.news = items.filter((i) => i.data).sort((a, b) => b.data.published_at.localeCompare(a.data.published_at));
  list.innerHTML = '';
  $('#newsCount').textContent = `${state.news.length} 篇，${state.news.filter((n) => n.data.ai).length} 篇已有 AI 文案`;
  if (!state.news.length) list.innerHTML = '<p class="muted">這一天還沒有抓到已上稿的文章。</p>';
  for (const item of state.news) list.append(renderCard(item, date));
  updateAiHint();
}

function renderCard(item, date) {
  const el = $('#tplCard').content.firstElementChild.cloneNode(true);
  const d = item.data;
  const v = cardValues(d);
  const dir = item.path.slice(0, item.path.lastIndexOf('/'));
  const canvas = document.createElement('canvas');
  let image = null;
  let pendingImage = null; // 換了但還沒存的圖片 bytes

  const t1 = $('.t1', el), t2 = $('.t2', el), sz = $('.sz', el), social = $('.social', el), comment = $('.comment', el);
  t1.value = v.title_lines[0] || '';
  t2.value = v.title_lines[1] || '';
  sz.value = Math.round((v.scale?.[0] || 1) * 100);
  $('output', el).textContent = `${sz.value}%`;
  social.value = (v.social || []).join('\n');
  comment.value = v.comment || '';
  $('.link', el).textContent = d.url;
  $('.meta', el).innerHTML = `${esc(d.category)}・${esc(d.author)}・上稿 ${fmtTime(d.published_at)}・<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.slug)}</a>`;
  const badge = $('.badge', el);
  const setBadge = () => {
    badge.textContent = d.edit ? '已修改' : d.ai ? 'AI 文案' : '待 AI';
    badge.classList.toggle('ai', !!(d.ai || d.edit));
  };
  setBadge();

  const lines = () => [t1.value, t2.value];
  const scale = () => { const s = Number(sz.value) / 100; return [s, s]; };

  let drawing = Promise.resolve();
  const redraw = () => {
    drawing = drawing.then(async () => {
      await drawCard(canvas, { collection: d.collection, image, lines: lines(), scale: scale() });
      const blob = await canvasToBlob(canvas);
      const img = $('.preview img', el);
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(blob); // 手機上可以直接長按圖片存到相簿
    });
    return drawing;
  };
  let timer;
  const dirty = () => {
    $('.saveState', el).textContent = '有未儲存的修改';
    clearTimeout(timer);
    timer = setTimeout(redraw, 250);
  };
  [t1, t2, sz].forEach((i) => i.addEventListener('input', () => { $('output', el).textContent = `${sz.value}%`; dirty(); }));
  [social, comment].forEach((i) => i.addEventListener('input', () => { $('.saveState', el).textContent = '有未儲存的修改'; }));

  (async () => {
    const imgName = d.edit?.image || d.image;
    if (imgName) {
      try { image = await loadImage(await state.store.blobURL(`${dir}/${imgName}`)); } catch { toast(`${d.slug} 圖片讀取失敗`); }
    }
    redraw();
  })();

  $('.swap', el).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingImage = new Uint8Array(await file.arrayBuffer());
    image = await loadImage(URL.createObjectURL(file));
    dirty();
  });

  $('.dl', el).addEventListener('click', async () => {
    await redraw();
    download(`${date}_${d.slug}.jpg`, await canvasToBlob(canvas));
  });
  $('.cpSocial', el).addEventListener('click', () => copyText(social.value.trim()));
  $('.cpComment', el).addEventListener('click', () => copyText(`${comment.value.trim()}\n${d.url}`));

  $('.save', el).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const edit = {
        title_lines: lines(),
        social: social.value.split('\n').map((s) => s.trim()).filter(Boolean),
        comment: comment.value.trim(),
        scale: scale(),
        image: d.edit?.image,
        saved_at: new Date().toISOString(),
      };
      if (pendingImage) {
        edit.image = `${d.slug}.custom-${Date.now()}.jpg`; // 每次用新檔名，不用處理覆蓋
        await state.store.putBytes(`${dir}/${edit.image}`, pendingImage, undefined, `圖卡換圖 ${d.slug}`);
        pendingImage = null;
      }
      d.edit = edit;
      item.sha = await state.store.putJSON(item.path, d, item.sha, `圖卡修改 ${d.slug}`);
      $('.saveState', el).textContent = '已儲存';
      setBadge();
    } catch (err) {
      $('.saveState', el).textContent = `儲存失敗：${err.message}（請按重新整理後再試）`;
    } finally {
      btn.disabled = false;
    }
  });

  return el;
}

// ---------- 我見我思 ----------

const ED_STATUS = {
  pending: '等待 AI 處理',
  ready: '待你確認',
  approved: '寫回後台中…',
  done: '已完成',
  conflict: '後台已被改過',
  error: '寫回失敗',
  refetch: '等待重新抓取',
};
const ED_ORDER = ['ready', 'error', 'conflict', 'pending', 'approved', 'refetch', 'done'];

async function loadEditorial() {
  const box = $('#edList');
  box.innerHTML = '<p class="muted">讀取中…</p>';
  const files = (await state.store.list('data/editorial')).filter((f) => f.name.endsWith('.json'));
  const items = await Promise.all(files.map(async (f) => ({ path: f.path, ...(await state.store.getJSON(f.path)) })));
  const weekAgo = Date.now() - 7 * 864e5;
  state.eds = items
    .filter((i) => i.data && !(i.data.status === 'done' && new Date(i.data.written_at || 0) < weekAgo))
    .sort((a, b) => ED_ORDER.indexOf(a.data.status) - ED_ORDER.indexOf(b.data.status) || (b.data.fetched_at || '').localeCompare(a.data.fetched_at || ''));
  box.innerHTML = '';
  if (!state.eds.length) box.innerHTML = '<p class="muted">目前沒有標題前加 ) 的草稿。</p>';
  for (const item of state.eds) box.append(renderEd(item));
  updateAiHint();
}

function previewHTML(body, typos) {
  return body.split('\n').filter((l) => l.trim()).map((line) => {
    const head = line.startsWith('##');
    let html = esc(head ? line.slice(2) : line);
    for (const t of typos) {
      const c = esc(t.context);
      if (c && html.includes(c)) html = html.replace(c, `<mark title="${esc(t.wrong)} → ${esc(t.right)}">${c}</mark>`);
    }
    return `<p class="${head ? 'h' : ''}">${head ? '▍' : ''}${html}</p>`;
  }).join('');
}

function renderEd(item) {
  const el = $('#tplEd').content.firstElementChild.cloneNode(true);
  const d = item.data;
  $('h2', el).textContent = d.title;
  const st = $('.status', el);
  st.textContent = ED_STATUS[d.status] || d.status;
  st.className = `status ${d.status}`;
  $('.meta', el).textContent = `${d.author || ''}・抓取 ${fmtTime(d.fetched_at)}・${d.slug}`;

  const msg = $('.msg', el);
  if (d.message) {
    msg.textContent = d.message;
    msg.classList.toggle('err', d.status === 'error' || d.status === 'conflict');
  }
  if (d.status === 'conflict' || d.status === 'error') {
    const b = Object.assign(document.createElement('button'), { className: 'secondary', textContent: '放棄這次結果，重新抓取這篇' });
    b.addEventListener('click', async () => {
      d.status = 'refetch';
      item.sha = await state.store.putJSON(item.path, d, item.sha, `重新抓取 ${d.slug}`);
      await state.store.dispatch('fetch.yml').catch(() => {});
      toast('已排入重新抓取，稍後按重新整理');
      loadEditorial();
    });
    msg.after(b);
  }
  if (d.status !== 'ready' || !d.ai) return el;

  const work = $('.work', el);
  work.hidden = false;
  const body = $('.bodyEdit', el);
  const preview = $('.bodyPreview', el);
  const tags = $('.tags', el);
  body.value = d.ai.body;
  tags.value = normTags(d.ai.tags).join(' ');
  $('.newTitle', el).textContent = finalTitle(d.title);

  const warns = [checkPreserved(d.body, d.ai.body), ...headingProblems(d.ai.body)].filter(Boolean);
  $('.warn', el).textContent = warns.length ? `⚠ ${warns.join('；')}` : '';

  const typos = (d.ai.typos || []).map((t) => ({ ...t, ok: typoUsable(d.ai.body, t) }));
  $('.typoCount', el).textContent = typos.length ? `${typos.length} 處，勾選的會在寫回時修正` : '沒有發現錯字';
  const ul = $('.typos', el);
  typos.forEach((t, i) => {
    const li = document.createElement('li');
    const ctx = esc(t.context).replace(esc(t.wrong), `<del>${esc(t.wrong)}</del><ins>${esc(t.right)}</ins>`);
    li.innerHTML = `<label><input type="checkbox" data-i="${i}" ${t.ok ? 'checked' : 'disabled'}><span>${ctx}${t.ok ? '' : '<span class="muted">（在內文找不到這段，無法自動修正）</span>'}</span></label>`;
    ul.append(li);
  });

  const tagCheck = () => {
    const long = normTags(tags.value).filter((t) => t !== '台灣醒報' && (t.length < 2 || t.length > 3));
    const n = normTags(tags.value).length;
    $('.tagWarn', el).textContent = [
      n < 8 || n > 10 ? `目前 ${n} 個（建議 8～10 個）` : '',
      long.length ? `不是 2～3 字：${long.join('、')}` : '',
    ].filter(Boolean).join('　');
  };
  tags.addEventListener('input', tagCheck);
  tagCheck();

  const refresh = () => { preview.innerHTML = previewHTML(body.value, typos.filter((t) => t.ok)); };
  refresh();
  $('.togglePreview', el).addEventListener('click', () => {
    body.hidden = !body.hidden;
    preview.hidden = !body.hidden;
    if (body.hidden) refresh();
  });

  $('.approve', el).addEventListener('click', async (e) => {
    if (warns.length && !confirm(`這篇有提醒事項：\n${warns.join('\n')}\n\n仍要寫回後台嗎？`)) return;
    const chosen = $$('input[type=checkbox]:checked', ul).map((c) => typos[Number(c.dataset.i)]);
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      d.final = {
        title: finalTitle(d.title),
        body: formatBody(applyTypos(body.value, chosen)),
        tags: normTags(tags.value).join(' '),
        typos_applied: chosen.map(({ wrong, right, context }) => ({ wrong, right, context })),
      };
      d.status = 'approved';
      d.approved_at = new Date().toISOString();
      item.sha = await state.store.putJSON(item.path, d, item.sha, `核准寫回 ${d.slug}`);
      toast('已送出，GitHub 約 1 分鐘內寫回後台', 5000);
      setTimeout(loadEditorial, 800);
      pollEditorial();
    } catch (err) {
      btn.disabled = false;
      toast(`送出失敗：${err.message}`, 6000);
    }
  });
  return el;
}

let pollTimer;
function pollEditorial(tries = 12) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await loadEditorial();
    if (tries > 1 && state.eds.some((i) => i.data.status === 'approved')) pollEditorial(tries - 1);
  }, 20000);
}

// ---------- AI 打包／交付 ----------

function pendingWork() {
  return {
    news: state.news.filter((n) => !n.data.ai).map((n) => n.data),
    editorial: state.eds.filter((e) => e.data.status === 'pending').map((e) => e.data),
  };
}

function updateAiHint() {
  const { news, editorial } = pendingWork();
  $('#aiHint').textContent = news.length || editorial.length
    ? `待處理：${news.length} 篇新聞、${editorial.length} 篇我見我思。下載打包檔 → 丟給 Claude → 把回傳的檔案上傳回來。`
    : '目前沒有待 AI 處理的文章。';
  $('#btnPackage').disabled = !(news.length || editorial.length);
}

function makePackage() {
  const { news, editorial } = pendingWork();
  const id = `${$('#newsDate').value}_${hhmmTW()}`;
  const md = buildPackage({ id, news, editorial });
  download(`醒報處理包-${id}.md`, new Blob([md], { type: 'text/markdown;charset=utf-8' }));
}

async function importDelivery(text) {
  let d;
  try {
    d = parseDelivery(text);
  } catch (err) {
    toast(`交付檔讀取失敗：${err.message}`, 6000);
    return;
  }
  const date = d.package_id.slice(0, 10);
  const notes = [];
  let okNews = 0, okEd = 0;

  for (const n of d.news) {
    const path = `data/cards/${date}/${n.slug}.json`;
    const cur = await state.store.getJSON(path);
    if (!cur) { notes.push(`找不到新聞 ${n.slug}`); continue; }
    const card = cur.data;
    let lines = (n.title_lines || []).map((s) => String(s).trim());
    if (lines.join('').replace(/\s/g, '') !== card.title.replace(/\s/g, '')) {
      notes.push(`${n.slug} 的標題斷行改到了原文字，已改用預設斷行`);
      lines = defaultSplit(card.title);
    }
    card.ai = { title_lines: lines, social: (n.social || []).map(String), comment: String(n.comment || ''), at: new Date().toISOString() };
    await state.store.putJSON(path, card, cur.sha, `AI 文案 ${n.slug}`);
    okNews++;
  }

  for (const e of d.editorial) {
    const path = `data/editorial/${e.slug}.json`;
    const cur = await state.store.getJSON(path);
    if (!cur) { notes.push(`找不到我見我思 ${e.slug}`); continue; }
    const item = cur.data;
    if (!['pending', 'ready'].includes(item.status)) { notes.push(`${e.slug} 已經寫回過，略過`); continue; }
    item.ai = { body: formatBody(String(e.body || '')), tags: normTags(e.tags || []), typos: e.typos || [], at: new Date().toISOString() };
    item.status = 'ready';
    await state.store.putJSON(path, item, cur.sha, `AI 校稿 ${e.slug}`);
    okEd++;
  }

  toast(`已匯入 ${okNews} 篇新聞、${okEd} 篇我見我思${notes.length ? '。' + notes.join('；') : ''}`, notes.length ? 9000 : 4000);
  if (date !== $('#newsDate').value) $('#newsDate').value = date;
  reloadAll();
}

// ---------- 啟動 ----------

async function reloadAll() {
  if (!state.store) return;
  try {
    await Promise.all([loadStatus(), loadNews(), loadEditorial()]);
  } catch (err) {
    toast(`讀取失敗：${err.message}`, 6000);
  }
}

function init() {
  initSettings();
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#newsDate').value = todayTW();
  $('#newsDate').addEventListener('change', () => loadNews().then(updateAiHint));
  $('#btnReload').addEventListener('click', reloadAll);
  $('#btnFetch').addEventListener('click', async () => {
    try {
      await state.store.dispatch('fetch.yml');
      toast('已開始抓取，約 1～2 分鐘後按「重新整理」', 5000);
    } catch (err) {
      toast(`無法啟動抓取：${err.message}`, 6000);
    }
  });
  $('#btnPackage').addEventListener('click', makePackage);
  $('#fileDelivery').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) await importDelivery(await f.text());
    e.target.value = '';
  });
  $('#btnPaste').addEventListener('click', () => { $('#pasteBox').hidden = !$('#pasteBox').hidden; });
  $('#btnPasteApply').addEventListener('click', async () => {
    await importDelivery($('#pasteText').value);
    $('#pasteText').value = '';
    $('#pasteBox').hidden = true;
  });

  if (LOCAL) {
    state.store = new LocalStore();
  } else {
    const s = readSettings();
    if (s.token) state.store = new GitHubStore(s);
  }
  if (!state.store) {
    showTab('settings');
    return;
  }
  showTab('news');
  reloadAll();
}

init();
