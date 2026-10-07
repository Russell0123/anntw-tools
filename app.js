import { GitHubStore, LocalStore } from './store.js';
import { drawCard, canvasToBlob, defaultSplit } from './card.js';
import { progress, trackRun } from './progress.js';
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

function openLightbox(src) {
  const box = $('#lightbox');
  $('img', box).src = src;
  box.hidden = false;
}

function closeLightbox() {
  $('#lightbox').hidden = true;
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

const ICON = {
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 19h16"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V4H4v12h4"/></svg>',
  image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 16l5-5 4 4 3-3 6 6"/></svg>',
};

/** 已完成的卡片放在最下面的「已完成」區 */
function placeCard(item) {
  $(item.data.done ? '#newsDone' : '#newsList').append(item.el);
  const todo = state.news.filter((n) => !n.data.done).length;
  const done = state.news.length - todo;
  $('#newsCount').textContent = `${state.news.length} 篇：待發 ${todo}、已完成 ${done}，${state.news.filter((n) => n.data.ai).length} 篇已有 AI 文案`;
  $('#doneHead').hidden = done === 0;
  $('#doneHead').textContent = `已完成（${done}）`;
}

async function loadNews(onProgress = () => {}) {
  const date = $('#newsDate').value;
  const list = $('#newsList');
  list.innerHTML = '<p class="muted">讀取中…</p>';
  $('#newsDone').innerHTML = '';
  $('#doneHead').hidden = true;
  const files = (await state.store.list(`data/cards/${date}`)).filter((f) => f.name.endsWith('.json'));
  let loaded = 0;
  const items = await Promise.all(files.map(async (f) => {
    const item = { path: f.path, ...(await state.store.getJSON(f.path)) };
    onProgress(++loaded, files.length);
    return item;
  }));
  state.news = items.filter((i) => i.data).sort((a, b) => b.data.published_at.localeCompare(a.data.published_at));
  list.innerHTML = '';
  $('#newsCount').textContent = '';
  if (!state.news.length) list.innerHTML = '<p class="muted">這一天還沒有抓到已上稿的文章。</p>';
  for (const item of state.news) {
    item.el = renderCard(item, date);
    placeCard(item);
  }
  updateAiHint();
}

function renderCard(item, date) {
  const el = $('#tplCard').content.firstElementChild.cloneNode(true);
  const d = item.data;
  const v = cardValues(d);
  const dir = item.path.slice(0, item.path.lastIndexOf('/'));
  const canvas = document.createElement('canvas');
  let image = null;

  $('.dl', el).innerHTML = ICON.download;
  $('.edit', el).innerHTML = ICON.edit;
  $$('.copy', el).forEach((b) => { b.innerHTML = ICON.copy; });
  $('.swapBtn', el).insertAdjacentHTML('afterbegin', ICON.image);

  const t1 = $('.t1', el), t2 = $('.t2', el), sz = $('.sz', el), social = $('.social', el), comment = $('.comment', el);
  const saveState = $('.saveState', el);
  t1.value = v.title_lines[0] || '';
  t2.value = v.title_lines[1] || '';
  sz.value = Math.round((v.scale?.[0] || 1) * 100);
  $('output', el).textContent = `${sz.value}%`;
  social.value = (v.social || []).join('\n');
  comment.value = v.comment || '';
  $('.link', el).textContent = d.url;
  $('.meta', el).innerHTML = `${esc(d.category)}・${esc(d.author)}・${fmtTime(d.published_at)}・<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.slug)}</a>`;

  // 左上角：AI 處理前顯示「待 AI」，處理後變成「已完成」勾選框
  const badge = $('.badge', el), doneBox = $('.doneBox', el), doneChk = $('.doneChk', el);
  const setCorner = () => {
    const ready = !!(d.ai || d.edit);
    badge.hidden = ready;
    doneBox.hidden = !ready;
    doneChk.checked = !!d.done;
    el.classList.toggle('isDone', !!d.done);
  };
  setCorner();

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

  // 修改後自動儲存（停止輸入 2 秒後），同一張卡一次只送一個請求
  let saving = Promise.resolve();
  const persist = (message) => {
    saving = saving.catch(() => {}).then(async () => {
      saveState.textContent = '儲存中…';
      try {
        item.sha = await state.store.putJSON(item.path, d, item.sha, `${message} ${d.slug}`);
        saveState.textContent = '已儲存';
      } catch (err) {
        saveState.textContent = `儲存失敗：${err.message}（請按重新整理後再試）`;
        throw err;
      }
    });
    return saving;
  };
  const collectEdit = () => {
    d.edit = {
      ...(d.edit || {}),
      title_lines: lines(),
      social: social.value.split('\n').map((s) => s.trim()).filter(Boolean),
      comment: comment.value.trim(),
      scale: scale(),
      saved_at: new Date().toISOString(),
    };
  };
  let redrawTimer, saveTimer;
  const changed = (needRedraw) => {
    saveState.textContent = '有未儲存的修改';
    if (needRedraw) { clearTimeout(redrawTimer); redrawTimer = setTimeout(redraw, 250); }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { collectEdit(); setCorner(); persist('圖卡修改').catch(() => {}); }, 2000);
  };
  [t1, t2, sz].forEach((i) => i.addEventListener('input', () => { $('output', el).textContent = `${sz.value}%`; changed(true); }));
  [social, comment].forEach((i) => i.addEventListener('input', () => changed(false)));

  (async () => {
    const imgName = d.edit?.image || d.image;
    if (imgName) {
      try { image = await loadImage(await state.store.blobURL(`${dir}/${imgName}`)); } catch { toast(`${d.slug} 圖片讀取失敗`); }
    }
    redraw();
  })();

  $('.preview img', el).addEventListener('click', (e) => openLightbox(e.currentTarget.src));

  $('.edit', el).addEventListener('click', () => {
    const ed = $('.editor', el);
    ed.hidden = !ed.hidden;
    $('.edit', el).classList.toggle('on', !ed.hidden);
  });

  $('.swap', el).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    progress.start(`換圖片：${d.title}`);
    try {
      image = await loadImage(URL.createObjectURL(file));
      redraw();
      progress.set(0.1, '上傳新圖片…', 0.8);
      const name = `${d.slug}.custom-${Date.now()}.jpg`; // 每次用新檔名，不用處理覆蓋
      await state.store.putBytes(`${dir}/${name}`, new Uint8Array(await file.arrayBuffer()), undefined, `圖卡換圖 ${d.slug}`);
      progress.set(0.8, '儲存設定…', 0.95);
      collectEdit();
      d.edit.image = name;
      await persist('圖卡換圖');
      progress.done('圖片已更換');
    } catch (err) {
      progress.fail(`換圖片失敗：${err.message}`);
    }
    e.target.value = '';
  });

  $('.dl', el).addEventListener('click', async () => {
    await redraw();
    download(`${date}_${d.slug}.jpg`, await canvasToBlob(canvas));
  });
  $('.cpSocial', el).addEventListener('click', () => copyText(social.value.trim()));
  $('.cpComment', el).addEventListener('click', () => copyText(`${comment.value.trim()}\n${d.url}`));

  doneChk.addEventListener('change', async () => {
    d.done = doneChk.checked;
    d.done_at = d.done ? new Date().toISOString() : undefined;
    setCorner();
    placeCard(item);
    await persist(d.done ? '標記完成' : '取消完成').catch(() => {});
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
      b.disabled = true;
      progress.start('重新抓取：標記這篇…');
      try {
        d.status = 'refetch';
        item.sha = await state.store.putJSON(item.path, d, item.sha, `重新抓取 ${d.slug}`);
        await runFetch();
      } catch (err) {
        progress.fail(`重新抓取失敗：${err.message}`);
        b.disabled = false;
      }
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
    progress.start('寫回後台：儲存你確認的內容…');
    try {
      const known = new Set((await state.store.listRuns('writeback.yml').catch(() => [])).map((r) => r.id));
      d.final = {
        title: finalTitle(d.title),
        body: formatBody(applyTypos(body.value, chosen)),
        tags: normTags(tags.value).join(' '),
        typos_applied: chosen.map(({ wrong, right, context }) => ({ wrong, right, context })),
      };
      d.status = 'approved';
      d.approved_at = new Date().toISOString();
      item.sha = await state.store.putJSON(item.path, d, item.sha, `核准寫回 ${d.slug}`);
      const ok = await trackRun(state.store, 'writeback.yml', known, '寫回後台');
      progress.set(0.97, '讀取寫回結果…');
      await loadEditorial();
      const after = state.eds.find((i) => i.data.slug === d.slug)?.data;
      if (ok && after?.status === 'done') progress.done('寫回完成，後台已核對內容一致');
      else if (ok) progress.fail(`寫回沒有完成：${after?.message || ED_STATUS[after?.status] || '狀態未知'}`);
    } catch (err) {
      btn.disabled = false;
      progress.fail(`送出失敗：${err.message}`);
    }
  });
  return el;
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
  const total = d.news.length + d.editorial.length;
  let step = 0;
  progress.start(`匯入交付檔：共 ${total} 篇`);
  const tick = (what) => {
    step++;
    progress.set((step - 1) / (total + 1), `匯入第 ${step}/${total} 篇：${what}`, step / (total + 1));
  };

  for (const n of d.news) {
    tick(`新聞 ${n.slug}`);
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
    tick(`我見我思 ${e.slug}`);
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

  if (date !== $('#newsDate').value) $('#newsDate').value = date;
  await reloadAll({ label: '匯入完成，重新載入', silent: true });
  progress.done(`已匯入 ${okNews} 篇新聞、${okEd} 篇我見我思`);
  if (notes.length) toast(notes.join('；'), 9000);
}

// ---------- 抓取 ----------

async function runFetch() {
  const btn = $('#btnFetch');
  btn.disabled = true; // 跑完前不能再按，避免重複抓取
  progress.start('抓取新文章：送出請求…');
  try {
    const known = new Set((await state.store.listRuns('fetch.yml').catch(() => [])).map((r) => r.id));
    await state.store.dispatch('fetch.yml');
    if (await trackRun(state.store, 'fetch.yml', known, '抓取新文章')) {
      await reloadAll({ label: '抓取完成，載入新文章', silent: true });
      const st = await state.store.getJSON('data/status.json').catch(() => null);
      const n = (st?.data.added_cards?.length || 0) + (st?.data.added_drafts?.length || 0);
      progress.done(`抓取完成，新增 ${n} 篇`);
    }
  } catch (err) {
    progress.fail(`無法啟動抓取：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- 啟動 ----------

/** silent：由其他流程呼叫時，接續原本的進度條，不在最後顯示「完成」 */
async function reloadAll({ label = '重新整理', silent = false } = {}) {
  if (!state.store) return;
  if (!silent) progress.start(`${label}：讀取抓取狀態…`);
  else progress.set(0.96, `${label}…`, 0.99);
  try {
    await loadStatus();
    if (!silent) progress.set(0.1, `${label}：讀取新聞圖卡…`, 0.2);
    await loadNews((i, n) => { if (!silent) progress.set(0.1 + 0.7 * (i / n), `${label}：讀取新聞 ${i}/${n}…`, 0.1 + 0.7 * ((i + 1) / n)); });
    if (!silent) progress.set(0.8, `${label}：讀取我見我思…`, 0.95);
    await loadEditorial();
    if (!silent) progress.done(`${label}完成`);
  } catch (err) {
    progress.fail(`讀取失敗：${err.message}`);
  }
}

function init() {
  initSettings();
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#newsDate').value = todayTW();
  $('#newsDate').addEventListener('change', () => loadNews().then(updateAiHint));
  // 大圖預覽：點圖片以外的地方或按 Esc 收回
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
  $('#btnReload').addEventListener('click', () => reloadAll());
  $('#btnFetch').addEventListener('click', runFetch);
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
