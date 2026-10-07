// 圖卡繪製：位置、字級、顏色都是從 簡報1.pptx 的範本頁換算過來的（EMU → 像素）。
// 新聞＝範本第 2 頁（橘字標題＋白字副標），我見我思＝範本第 4 頁（兩行灰字）。

const FONT = '"Noto Sans TC", "Microsoft JhengHei", sans-serif';
const LINE = 1.213; // PowerPoint 裡 Noto Sans TC 的行高（由範本文字方塊高度反推）

function emu(pxWidth, emuWidth) {
  const s = pxWidth / emuWidth;
  return (v) => v * s;
}

// 範本座標都以「圖片左上角」為原點換算
const NEWS = (() => {
  const W = 1600, picX = -43250, picY = 855138, e = emu(W, 7036283);
  return {
    W, H: Math.round(e(5277212)),
    lines: [
      { x: e(527181 - picX + 91440), top: e(4073769 - picY + 45720), size: e(508000), weight: 900, color: '#F4B280' },
      { x: e(519806 - picX + 91440), top: e(4781655 - picY + 45720), size: e(304800), weight: 500, color: '#FFFFFF' },
    ],
  };
})();

const EDITORIAL = (() => {
  const W = 1600, picY = 65645, e = emu(W, 7345513);
  const size = e(457200), top = e(3628294 - picY + 45720), x = e(293076 + 91440);
  return {
    W, H: Math.round(e(5723776)),
    lines: [
      { x, top, size, weight: 900, color: '#BFBFBF' },
      { x, top: top + size * LINE, size, weight: 900, color: '#BFBFBF' },
    ],
  };
})();

export function layoutFor(collection) {
  return collection === 'editorial' ? EDITORIAL : NEWS;
}

export async function ensureFonts(text) {
  if (!document.fonts) return;
  // Google Fonts 依字元分包，要帶著實際文字載入才會抓到需要的字
  await Promise.all([
    document.fonts.load(`900 100px "Noto Sans TC"`, text),
    document.fonts.load(`500 100px "Noto Sans TC"`, text),
  ]).catch(() => {});
}

function drawCover(ctx, img, W, H) {
  const r = Math.max(W / img.width, H / img.height);
  const w = img.width * r, h = img.height * r;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{collection:string, image:HTMLImageElement|null, lines:string[], scale?:number[]}} opt
 */
export async function drawCard(canvas, { collection, image, lines, scale = [1, 1] }) {
  const L = layoutFor(collection);
  canvas.width = L.W;
  canvas.height = L.H;
  const ctx = canvas.getContext('2d');
  await ensureFonts(lines.join(''));

  ctx.fillStyle = '#333';
  ctx.fillRect(0, 0, L.W, L.H);
  if (image) drawCover(ctx, image, L.W, L.H);
  ctx.fillStyle = 'rgba(0,0,0,0.451)'; // 範本的黑色 45% 遮罩
  ctx.fillRect(0, 0, L.W, L.H);

  ctx.textBaseline = 'middle';
  L.lines.forEach((spec, i) => {
    const text = (lines[i] || '').trim();
    if (!text) return;
    let size = spec.size * (scale[i] || 1);
    ctx.font = `${spec.weight} ${size}px ${FONT}`;
    // 太長就自動縮小，避免像 PPT 那樣被裁切
    const maxW = L.W - spec.x - 48;
    const w = ctx.measureText(text).width;
    if (w > maxW) {
      size *= maxW / w;
      ctx.font = `${spec.weight} ${size}px ${FONT}`;
    }
    ctx.fillStyle = spec.color;
    ctx.fillText(text, spec.x, spec.top + (spec.size * LINE) / 2);
  });
}

export function canvasToBlob(canvas) {
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
}

/** 預設的標題斷行：有空格就從空格斷，《專欄名》就從》後斷，否則從中間附近的標點斷 */
export function defaultSplit(title) {
  const t = title.trim();
  const sp = t.search(/[ 　]/);
  if (sp > 0) return [t.slice(0, sp).trim(), t.slice(sp + 1).trim()];
  const col = t.indexOf('》');
  if (col > 0 && col < t.length - 2) return [t.slice(0, col + 1), t.slice(col + 1)];
  const mid = Math.floor(t.length / 2);
  const punct = [...t.matchAll(/[，、：！？]/g)].map((m) => m.index).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
  const cut = punct !== undefined ? punct + 1 : mid;
  return [t.slice(0, cut), t.slice(cut)];
}
