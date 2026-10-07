// 資料存取：正式使用時透過 GitHub API 讀寫私有資料 repo；?local=1 時讀本機 data-repo（只供開發測試，寫入只存在記憶體）。

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const enc = (path) => path.split('/').map(encodeURIComponent).join('/');

export class GitHubStore {
  constructor({ owner, repo, token }) {
    this.base = `https://api.github.com/repos/${owner}/${repo}`;
    this.token = token;
  }

  async req(path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
    const r = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (!r.ok) {
      const err = new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    return r;
  }

  async check() {
    await this.req('');
  }

  async list(dir) {
    try {
      const r = await this.req(`/contents/${enc(dir)}`);
      return (await r.json()).map((f) => ({ name: f.name, path: f.path, type: f.type }));
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  async getJSON(path) {
    try {
      const j = await (await this.req(`/contents/${enc(path)}`)).json();
      return { data: JSON.parse(new TextDecoder().decode(b64ToBytes(j.content))), sha: j.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async putJSON(path, data, sha, message) {
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n');
    return this.putBytes(path, bytes, sha, message);
  }

  async putBytes(path, bytes, sha, message) {
    const r = await this.req(`/contents/${enc(path)}`, {
      method: 'PUT',
      body: { message, content: bytesToB64(bytes), ...(sha ? { sha } : {}) },
    });
    return (await r.json()).content.sha;
  }

  async blobURL(path) {
    const r = await this.req(`/contents/${enc(path)}`, { accept: 'application/vnd.github.raw' });
    return URL.createObjectURL(await r.blob());
  }

  async dispatch(workflow) {
    await this.req(`/actions/workflows/${workflow}/dispatches`, { method: 'POST', body: { ref: 'main' } });
  }

  async listRuns(workflow) {
    const j = await (await this.req(`/actions/workflows/${workflow}/runs?per_page=10`)).json();
    return j.workflow_runs;
  }

  async getRun(id) {
    return (await this.req(`/actions/runs/${id}`)).json();
  }

  async runJobs(id) {
    return (await (await this.req(`/actions/runs/${id}/jobs`)).json()).jobs;
  }
}

export class LocalStore {
  constructor(base = '../dev-data/') {
    this.base = base;
    this.mem = new Map();
  }

  async check() {}

  async list(dir) {
    const r = await fetch(this.base + dir + '/');
    if (!r.ok) return [];
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    return [...doc.querySelectorAll('a')]
      .map((a) => decodeURIComponent(a.getAttribute('href')))
      .filter((h) => h && !h.startsWith('.') && !h.startsWith('/') && !h.startsWith('?'))
      .map((h) => ({ name: h.replace(/\/$/, ''), path: `${dir}/${h.replace(/\/$/, '')}`, type: h.endsWith('/') ? 'dir' : 'file' }));
  }

  async getJSON(path) {
    if (this.mem.has(path)) return { data: structuredClone(this.mem.get(path)), sha: 'mem' };
    const r = await fetch(this.base + path, { cache: 'no-store' });
    if (!r.ok) return null;
    return { data: await r.json(), sha: 'local' };
  }

  async putJSON(path, data) {
    this.mem.set(path, structuredClone(data));
    return 'mem';
  }

  async putBytes(path, bytes) {
    this.mem.set(path, new Blob([bytes]));
    return 'mem';
  }

  async blobURL(path) {
    const m = this.mem.get(path);
    if (m instanceof Blob) return URL.createObjectURL(m);
    return this.base + path;
  }

  // 本機測試：模擬一個約 15 秒跑完的 GitHub Actions
  async dispatch(workflow) {
    this.fakeRun = { id: Date.now(), workflow, start: Date.now() + 2000 };
  }

  async listRuns(workflow) {
    const r = this.fakeRun;
    return r && r.workflow === workflow && Date.now() > r.start ? [await this.getRun(r.id)] : [];
  }

  async getRun(id) {
    const t = (Date.now() - this.fakeRun.start) / 1000;
    return { id, status: t < 2 ? 'queued' : t < 15 ? 'in_progress' : 'completed', conclusion: t < 15 ? null : 'success' };
  }

  async runJobs() {
    const t = (Date.now() - this.fakeRun.start) / 1000 - 2;
    const names = ['Set up job', 'Run actions/checkout@v5', 'Run actions/setup-python@v6', 'Run pip install -r requirements.txt', '抓取', '存檔', 'Complete job'];
    const ends = [1, 2, 3, 5, 10, 12, 13];
    return [{ steps: names.map((name, i) => ({ name, status: t >= ends[i] ? 'completed' : t >= (ends[i - 1] || 0) ? 'in_progress' : 'queued', conclusion: t >= ends[i] ? 'success' : null })) }];
  }
}
