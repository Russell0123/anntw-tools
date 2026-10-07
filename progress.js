// 畫面頂端的進度條＋目前步驟文字。
// set(fraction, text, ceiling)：跳到 fraction，之後在等待期間慢慢往 ceiling 爬，避免看起來卡住。

const el = () => document.getElementById('progress');
let cur = 0, ceil = 0, timer = null, hideTimer = null;

function paint(text) {
  el().querySelector('.fill').style.width = `${(cur * 100).toFixed(1)}%`;
  if (text !== undefined) el().querySelector('.ptext').textContent = text;
}

export const progress = {
  start(text) {
    clearTimeout(hideTimer);
    clearInterval(timer);
    const box = el();
    box.hidden = false;
    box.classList.remove('done', 'fail');
    cur = 0;
    ceil = 0.05;
    paint(text);
    timer = setInterval(() => {
      if (cur < ceil) {
        cur += (ceil - cur) * 0.04;
        paint();
      }
    }, 250);
  },

  set(fraction, text, ceiling) {
    cur = Math.max(cur, fraction);
    ceil = Math.max(cur, ceiling ?? fraction);
    paint(text);
  },

  done(text = '完成') {
    clearInterval(timer);
    cur = 1;
    el().classList.add('done');
    paint(text);
    hideTimer = setTimeout(() => { el().hidden = true; }, 2500);
  },

  fail(text) {
    clearInterval(timer);
    el().classList.add('fail');
    paint(`✗ ${text}`);
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GitHub Actions 步驟名稱 → 給人看的說明
const STEP_TEXT = [
  [/^Set up job/, '啟動 GitHub 主機'],
  [/checkout/, '下載程式'],
  [/setup-python/, '準備 Python'],
  [/pip install/, '安裝套件'],
  [/有沒有待寫回/, '檢查有哪些要寫回'],
  [/^抓取$/, '登入後台、抓取文章和配圖'],
  [/^寫回$/, '登入後台、寫回文章並重新核對'],
  [/^存檔$/, '存檔'],
  [/^(Post|Complete)/, '收尾'],
];
const stepText = (name) => (STEP_TEXT.find(([re]) => re.test(name)) || [, name])[1];

/**
 * 跟著 GitHub Actions 的真實執行進度更新進度條。
 * @param store       GitHubStore / LocalStore
 * @param workflow    'fetch.yml' / 'writeback.yml'
 * @param knownIds    觸發前就存在的 run id（用來辨認哪個是新的）
 * @returns {Promise<boolean>} 成功與否
 */
export async function trackRun(store, workflow, knownIds, label) {
  progress.set(0.04, `${label}：等待 GitHub 接手…`, 0.1);
  let run = null;
  for (let i = 0; i < 40 && !run; i++) {
    await sleep(3000);
    run = (await store.listRuns(workflow).catch(() => [])).find((r) => !knownIds.has(r.id));
  }
  if (!run) {
    progress.fail(`${label}：GitHub 一直沒有開始執行，請稍後到 Actions 頁面確認`);
    return false;
  }

  for (let i = 0; i < 200; i++) {
    run = await store.getRun(run.id).catch(() => run);
    if (run.status === 'completed') break;
    if (run.status !== 'in_progress') {
      progress.set(0.1, `${label}：排隊中（前一個工作還在跑）…`, 0.15);
    } else {
      const steps = (await store.runJobs(run.id).catch(() => []))[0]?.steps || [];
      if (steps.length) {
        const done = steps.filter((s) => s.status === 'completed').length;
        const now = steps.find((s) => s.status === 'in_progress') || steps[done];
        const base = 0.15 + 0.8 * (done / steps.length);
        const next = 0.15 + 0.8 * ((done + 1) / steps.length);
        progress.set(base, `${label}：${stepText(now?.name || '')}（${Math.min(done + 1, steps.length)}/${steps.length}）`, next - 0.01);
      } else {
        progress.set(0.15, `${label}：啟動 GitHub 主機…`, 0.2);
      }
    }
    await sleep(3000);
  }

  if (run.conclusion === 'success') return true;
  const steps = (await store.runJobs(run.id).catch(() => []))[0]?.steps || [];
  const bad = steps.find((s) => s.conclusion === 'failure');
  progress.fail(`${label}失敗${bad ? `，卡在「${stepText(bad.name)}」` : ''}。詳細紀錄在 GitHub Actions 頁面`);
  return false;
}
