// 打包檔（丟給 Claude 的檔案）與交付檔（Claude 回傳的 JSON）的格式與檢查。

const NEWS_RULES = `## 任務 A：新聞社群文案（news）

每篇新聞產生三樣東西：

1. **title_lines**：把「原文標題」拆成兩行，放在圖卡上。
   - 絕對不可以改寫、增刪任何字，只是找自然的斷句點。兩行接起來必須和原標題一字不差（空格除外）。
   - 原標題有空格時，通常就從空格斷開；第一行是大字主標，第二行是小字副標。
2. **social**：兩行式社群標題（臉書貼文本文），陣列兩個元素。
   - 第一行：提問句或引起好奇心的開頭，通常以「？」結尾。
   - 第二行：帶有具體資訊的延伸句。
   - 簡短有力、口語化，每行大約 8～18 字。
   - 只能從新聞全文提煉，絕對不可以捏造內文沒有的數字、人名或事實。
   - 參考過去實際發過的範例：
     - 國慶連假怎麼搭最划算？／雙鐵加開上百班 客運最高57折
     - 一天生理假真的夠用嗎？／學生團體籲增至每月2天、不刁難
     - 修憲為何幾乎不可能過關？／學者籲降門檻改採相對多數
     - 徐佳青請辭了？／特權風波仍自認問心無愧
     - 奧運申辦為何又變熱門？／IOC鬆綁規則 7國有意角逐2036
     - 你的曝險比祖父輩多多少？／研究：年輕世代野火暴露恐增84%
     - 孤獨竟跟吸菸一樣傷身？／教會社區陪伴成解方關鍵
3. **comment**：臉書第一則留言用的一句短話＋1 個 emoji（例如結尾放 💪🤔😱🧐），4～12 字，像小編跟讀者聊天。
   不要放連結（系統會自動接上原文連結）。範例：連假交通都要提早準備！／重視女性權益💪／需要與時俱進🧐／最後會由誰來辦呢🤔／越來越危險😱／健康的人際關係很重要💪
`;

const EDITORIAL_RULES = `## 任務 B：我見我思格式整理＋錯字檢查（editorial）

**最重要：不可以更動任何文字內容、不可以改寫句子。** 只調整格式。發現錯字也不要直接改在 body 裡，另外列在 typos。

body 的格式規則：

- 段落之間統一空一行（兩個換行）。原文只用單換行或沒分段的，一律整理成空一行；去掉段落開頭的全形/半形縮排空白。
- 小標用 \`##小標文字\`（## 後面不加空格）。小標「前面」空一行，「後面」不空行，直接接內文。
- **最開頭的一到兩段絕對不加小標**，小標從後面的段落才開始出現。
- 原文已經有小標（單獨一行的短標題、作者自己打的「參考資料」之類的標籤）：直接加上 ## 統一格式，不要另外發明。
- 原文沒有小標：依內容脈絡自己切出 3～6 個小標（文章特別長可以到 7 個），每個 4～10 字，簡短有力。
- 條列式重點（「1. 標題」＋說明）統一成 \`##1. 標題\`，後面直接接說明文字不空行。

tags（SEO 關鍵字）：

- 8～10 個，每個以 2～3 個字為主，從內文擷取核心主題詞與具體名詞（可放同主題的關聯詞）。
- 不用動詞、不用完整片語、不加 # 或其他符號。
- 最後一個固定是「台灣醒報」。

typos（錯字回報）：

- 只抓錯「字」：同音字或形近字誤植、明顯漏字或多打一個字。例如「再接再厲」打成「在接再厲」、「已經」打成「以經」。
- 不要管用詞選擇、句子通不通順、標點、的／得／地、異體字。寧可漏抓，不要誤抓。
- 每一筆格式：{"wrong": "在", "right": "再", "context": "在接再厲"}
  - context 是原文裡連續 6～15 個字、包含那個錯字的片段，**必須逐字照抄原文**，而且在全文中只出現一次。
- 沒有錯字就給空陣列。
`;

function deliverySpec(id) {
  return `## 交付格式

**不需要跟使用者確認或說明，直接產出一個檔案 \`delivery-${id}.json\`**（不能產出檔案的話，就把完整 JSON 放在一個程式碼區塊裡）。內容必須是合法 JSON，結構如下：

\`\`\`json
{
  "package_id": "${id}",
  "news": [
    { "slug": "文章slug", "title_lines": ["第一行", "第二行"], "social": ["第一行？", "第二行"], "comment": "一句話😀" }
  ],
  "editorial": [
    { "slug": "文章slug", "body": "整理後的完整內文", "tags": ["關鍵字", "台灣醒報"], "typos": [] }
  ]
}
\`\`\`

資料裡的每一篇都要處理，slug 照抄。沒有資料的任務就給空陣列。
`;
}

export function buildPackage({ id, news, editorial }) {
  const data = {
    package_id: id,
    news: news.map((n) => ({ slug: n.slug, title: n.title, category: n.category, body: n.body })),
    editorial: editorial.map((e) => ({ slug: e.slug, title: e.title, body: e.body })),
  };
  return `# 台灣醒報 處理包 ${id}

你是台灣醒報的社群小編兼編輯。請依照下面的規則處理「資料」裡的文章，然後依「交付格式」產出交付檔。
這份檔案就是完整的指示，使用者不會再補充說明。

${news.length ? NEWS_RULES : ''}
${editorial.length ? EDITORIAL_RULES : ''}
${deliverySpec(id)}
## 資料（${news.length} 篇新聞、${editorial.length} 篇我見我思）

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`
`;
}

export function parseDelivery(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('找不到 JSON 內容');
  const d = JSON.parse(text.slice(start, end + 1));
  if (!d.package_id) throw new Error('交付檔缺少 package_id');
  return { package_id: d.package_id, news: d.news || [], editorial: d.editorial || [] };
}

// ---------- 我見我思 ----------

const strip = (s) => s.replace(/[\s　]+/g, '');

/** 依格式規則重新排版（就算 AI 空行沒弄好也會被整理成一致） */
export function formatBody(text) {
  const blocks = text.replace(/\r\n/g, '\n').split('\n')
    .map((l) => l.replace(/^[\s　]+|[\s　]+$/g, ''))
    .filter(Boolean)
    .map((l) => (l.startsWith('##') ? '##' + l.slice(2).trim() : l));
  let out = '';
  let prevHead = false;
  for (const b of blocks) {
    if (out) out += prevHead ? '\n' : '\n\n';
    out += b;
    prevHead = b.startsWith('##');
  }
  return out;
}

/**
 * 檢查 AI 有沒有動到文字：去掉新加的小標、所有空白後，應該跟原文一模一樣。
 * 回傳 null 表示沒問題，否則回傳說明。
 */
export function checkPreserved(original, delivered) {
  const plain = original.replace(/^[ \t　]*##/gm, '');
  const orig = strip(plain);
  // 原文本來就單獨成行的短句（作者自己的小標），加上 ## 之後仍算原文
  const origLines = new Set(plain.split('\n').map(strip).filter(Boolean));
  let pos = 0;
  for (const line of delivered.split('\n')) {
    const isHead = line.startsWith('##');
    const t = strip(isHead ? line.slice(2) : line);
    if (!t) continue;
    if (isHead && !origLines.has(t)) continue; // 新加的小標
    if (orig.startsWith(t, pos)) {
      pos += t.length;
    } else {
      let i = 0;
      while (i < t.length && orig[pos + i] === t[i]) i++;
      return `文字和原文不一致：原文「…${orig.slice(pos + i - 8, pos + i + 12)}…」，AI 版本「…${t.slice(Math.max(0, i - 8), i + 12)}…」`;
    }
  }
  if (pos < orig.length) return `AI 版本少了原文的一段：「${orig.slice(pos, pos + 20)}…」`;
  return null;
}

export function headingProblems(body) {
  const blocks = body.split(/\n+/).filter((l) => l.trim());
  const probs = [];
  if (blocks[0]?.startsWith('##')) probs.push('第一段是小標，開頭一兩段不應該下小標');
  if (!blocks.some((b) => b.startsWith('##'))) probs.push('沒有任何小標');
  return probs;
}

export function typoUsable(body, t) {
  return !!(t && t.context && t.wrong && t.right && body.includes(t.context) && t.context.includes(t.wrong));
}

export function applyTypos(body, typos) {
  let out = body;
  for (const t of typos) {
    if (typoUsable(out, t)) out = out.replace(t.context, t.context.replace(t.wrong, t.right));
  }
  return out;
}

export function normTags(tags) {
  const list = (Array.isArray(tags) ? tags : String(tags).split(/[\s,，、]+/))
    .map((t) => t.replace(/^#/, '').trim())
    .filter((t) => t && t !== '台灣醒報');
  return [...new Set(list), '台灣醒報'];
}

export const finalTitle = (title) => title.replace(/^\)/, '(待配圖)');
