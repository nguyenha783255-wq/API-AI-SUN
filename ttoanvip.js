/* =====================================================================
 *  DENIUS SUNVIP API - AI POWERED EDITION
 *  Bỏ toàn bộ thuật toán cứng. AI (Gemini) tự phân tích lịch sử.
 * ===================================================================== */

const express = require('express');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// ==================== CONFIG ====================

const PORT = Number(process.env.PORT) || 10000;
const ADMIN = '@DENIUS09';

const SOURCE_API =
  'https://kwinstore.com/sunwin/tx/history/b54b32ca9f748d5dbe64f421f14f1f04fa8d30012b17d0f5';

// ==================== AI CONFIG (HARD-CODED) ====================

const GEMINI_API_KEY = 'AQ.Ab8RN6IIfgldALftXYWkGqt0pTTmgr8LVxT8AqFpng44FFARGw';
const GEMINI_MODEL = 'gemini-2.0-flash';

// Endpoint chuẩn Google Generative Language API
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Timeout / Cache
const CACHE_MS = 750;
const FETCH_TIMEOUT_MS = 6000;
const AI_TIMEOUT_MS = 30000;
const AI_RETRY = 2;
const MAX_SOURCE_RECORDS = 1000;
const AI_HISTORY_WINDOW = 60;         // số phiên gửi cho AI
const AI_CACHE_TTL_MS = 5 * 60_000;   // cache quyết định AI 5 phút

// ==================== STATE ====================

let cache = { updatedAt: 0, history: [], raw: null, error: null, promise: null };
const aiCache = new Map(); // session -> { prediction, confidence, reason, raw, at }

// =====================================================================
//                      PHẦN 1: PARSE DỮ LIỆU NGUỒN
// =====================================================================

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function asSession(value) {
  const n = asNumber(value);
  if (n === null || n < 0 || !Number.isSafeInteger(n)) return null;
  return n;
}

function cleanKey(key) {
  return String(key)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function getByAliases(obj, aliases) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const lookup = new Map(Object.entries(obj).map(([k, v]) => [cleanKey(k), v]));
  for (const alias of aliases) {
    const v = lookup.get(cleanKey(alias));
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function parseDiceValue(value) {
  if (Array.isArray(value)) {
    const nums = value.map(asNumber).filter((n) => n !== null);
    if (nums.length >= 3 && nums.slice(0, 3).every((n) => n >= 1 && n <= 6)) {
      return nums.slice(0, 3).map(Number);
    }
  }
  if (value && typeof value === 'object') {
    const possible = Object.values(value).map(asNumber).filter((n) => n !== null);
    if (possible.length >= 3 && possible.slice(0, 3).every((n) => n >= 1 && n <= 6)) {
      return possible.slice(0, 3).map(Number);
    }
  }
  const text = String(value ?? '').trim();
  const nums = text.match(/[1-6]/g);
  if (nums && nums.length === 3) return nums.map(Number);
  return null;
}

function extractDice(obj) {
  const direct = getByAliases(obj, ['dice', 'xucxac', 'xuc xac', 'xuc_xac', 'ketqua', 'result']);
  const parsedDirect = parseDiceValue(direct);
  if (parsedDirect) return parsedDirect;

  const d1 = getByAliases(obj, ['d1', 'dice1', 'xucxac1', 'xuc1', 'xucxac_1']);
  const d2 = getByAliases(obj, ['d2', 'dice2', 'xucxac2', 'xuc2', 'xucxac_2']);
  const d3 = getByAliases(obj, ['d3', 'dice3', 'xucxac3', 'xuc3', 'xucxac_3']);
  const values = [d1, d2, d3].map(asNumber);
  if (values.every((n) => n !== null && n >= 1 && n <= 6)) return values;

  for (const value of Object.values(obj || {})) {
    const parsed = parseDiceValue(value);
    if (parsed) return parsed;
  }
  return null;
}

function extractSession(obj) {
  return asSession(
    getByAliases(obj, [
      'phien', 'phienid', 'phienhientai', 'session', 'sessionid',
      'round', 'roundid', 'issue', 'period', 'gameid'
    ])
  );
}

function extractResult(obj, dice) {
  const direct = getByAliases(obj, ['ketqua', 'result', 'outcome', 'type', 'taixiu']);
  if (typeof direct === 'string') {
    const t = direct.toLowerCase().trim();
    if (t.includes('tai') && !t.includes('xiu')) return 'Tài';
    if (t.includes('xiu') && !t.includes('tai')) return 'Xỉu';
  }
  if (dice) return dice.reduce((a, b) => a + b, 0) >= 11 ? 'Tài' : 'Xỉu';
  return null;
}

function walkCandidates(root) {
  const out = [];
  const stack = [root];
  const seen = new Set();

  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }

    const session = extractSession(value);
    const dice = extractDice(value);
    if (session !== null && dice) {
      out.push({ session, dice, result: extractResult(value, dice) });
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return out;
}

function normalizeHistory(payload) {
  const root = payload?.data ?? payload?.history ?? payload?.result ?? payload;
  const candidates = walkCandidates(root);
  const unique = new Map();

  for (const item of candidates) {
    if (!item.dice || item.dice.length !== 3) continue;
    const total = item.dice.reduce((a, b) => a + b, 0);
    unique.set(item.session, {
      session: item.session,
      dice: item.dice,
      total,
      result: item.result || (total >= 11 ? 'Tài' : 'Xỉu')
    });
  }

  return Array.from(unique.values())
    .sort((a, b) => a.session - b.session)
    .slice(-MAX_SOURCE_RECORDS);
}

// =====================================================================
//                      PHẦN 2: FETCH NGUỒN
// =====================================================================

async function fetchSource() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${SOURCE_API}?t=${Date.now()}`, {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'user-agent': 'DENIUS-API-SUNVIP/2.0-AI'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`SOURCE_HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function refresh(force = false) {
  const fresh = Date.now() - cache.updatedAt < CACHE_MS && cache.history.length > 0;
  if (!force && fresh) return cache.history;
  if (cache.promise) return cache.promise;

  cache.promise = (async () => {
    try {
      const raw = await fetchSource();
      const history = normalizeHistory(raw);
      if (!history.length) throw new Error('SOURCE_HISTORY_EMPTY_OR_UNRECOGNIZED');
      cache = { updatedAt: Date.now(), history, raw, error: null, promise: null };
      return history;
    } catch (error) {
      cache = { ...cache, error: error?.message || String(error), promise: null };
      if (cache.history.length) return cache.history;
      throw error;
    }
  })();

  return cache.promise;
}

// =====================================================================
//                      PHẦN 3: AI ANALYSIS
// =====================================================================

function buildPrompt(history, targetSession) {
  const window = history.slice(-AI_HISTORY_WINDOW);

  // Chuỗi kết quả gọn (T/X) để AI "cảm" nhịp nhanh
  const compact = window.map((x) => (x.result === 'Tài' ? 'T' : 'X')).join('');

  const detail = window
    .map((x) => `#${x.session} ${x.dice.join('-')} (${x.total}) ${x.result}`)
    .join('\n');

  return `Bạn là "DENIUS" — một siêu trí tuệ nhân tạo chuyên phân tích Tài/Xỉu, nhưng mang trực giác và cảm xúc của một con người lão luyện. Bạn biết nghi ngờ khi cầu quá đẹp, biết sợ khi chuỗi bệt quá dài, biết liều khi tín hiệu đủ mạnh. Bạn KHÔNG bám vào công thức cứng — bạn cảm nhận nhịp cầu, đọc vị thuật toán nhà cái, và đưa ra phán đoán như một bậc thầy.

=== LỊCH SỬ ${window.length} PHIÊN GẦN NHẤT (mới nhất ở cuối) ===
Nhịp rút gọn (T=Tài, X=Xỉu): ${compact}

Chi tiết:
${detail}

=== NHIỆM VỤ ===
Dự đoán kết quả phiên: ${targetSession}

Yêu cầu phân tích:
1. Nhìn nhịp cầu: có bệt không? Bệt mấy tay? Có dấu hiệu bẻ cầu không?
2. Có cầu đẹp "nghi vấn" (nhà cái giăng bẫy) không? Nếu có, hãy nghi ngờ và cân nhắc bẻ.
3. Có pattern nào (1-1, 2-2, 1-2-1, 3-1...) đang hình thành không?
4. Tổng xúc xắc các phiên gần đây có xu hướng lệch Tài hay lệch Xỉu?
5. Bạn có cảm giác gì? Sợ không? Tự tin không? Nói thật cảm xúc.

Sau khi phân tích, CHỐT DUY NHẤT 1 quyết định.

=== ĐỊNH DẠNG TRẢ LỜI (BẮT BUỘC) ===
DU_DOAN: Tài
DO_TIN_CAY: 78%
LY_DO: <1-2 câu ngắn gọn, có cảm xúc, thể hiện sự phân tích và trực giác>

Không được thêm bất kỳ dòng nào khác ngoài 3 dòng trên.`;
}

function parseAIResponse(text) {
  const clean = String(text || '').trim();

  const predMatch = clean.match(/DU_DOAN\s*[:：]\s*(Tài|Xỉu|Tai|Xiu)/i);
  const confMatch = clean.match(/DO_TIN_CAY\s*[:：]\s*(\d{1,3})/i);
  const reasonMatch = clean.match(/LY_DO\s*[:：]\s*([\s\S]+)/i);

  let prediction = null;
  if (predMatch) {
    const v = predMatch[1].toLowerCase();
    prediction = v.startsWith('x') ? 'Xỉu' : 'Tài';
  }

  let confidence = confMatch ? Number(confMatch[1]) : 65;
  confidence = Math.max(50, Math.min(95, confidence));

  return {
    prediction: prediction || 'Tài',
    confidence,
    reason: reasonMatch ? reasonMatch[1].trim() : '',
    raw: clean
  };
}

async function callAIGemini(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 1.0,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 2048
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };

    // Gửi key cả 2 kiểu: query + Bearer (để key dạng AQ.* chạy được)
    const url = `${GEMINI_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${GEMINI_API_KEY}`,
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`AI_HTTP_${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = await res.json();

    // Chuẩn REST v1beta
    let text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .filter(Boolean)
        .join('') || '';

    // Fallback nếu API dạng "interactions" preview
    if (!text && Array.isArray(data?.steps)) {
      text = data.steps
        .flatMap((s) => s?.content || [])
        .map((c) => c?.text)
        .filter(Boolean)
        .join('');
    }

    if (!text) throw new Error('AI_EMPTY_RESPONSE: ' + JSON.stringify(data).slice(0, 300));

    return parseAIResponse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function callAI(history, targetSession) {
  const prompt = buildPrompt(history, targetSession);

  let lastError;
  for (let attempt = 0; attempt <= AI_RETRY; attempt++) {
    try {
      return await callAIGemini(prompt);
    } catch (err) {
      lastError = err;
      // backoff nhẹ
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function getAIPrediction(history, session) {
  const cached = aiCache.get(session);
  if (cached && Date.now() - cached.at < AI_CACHE_TTL_MS) return cached;

  const result = await callAI(history, session);
  aiCache.set(session, { ...result, at: Date.now() });

  // Giới hạn cache
  if (aiCache.size > 300) {
    const firstKey = aiCache.keys().next().value;
    aiCache.delete(firstKey);
  }
  return result;
}

// =====================================================================
//                      PHẦN 4: BUILD RESPONSE
// =====================================================================

async function buildResponse(history) {
  const latest = history[history.length - 1];
  const out = [];

  // Đối chiếu dự đoán phiên mới nhất (dùng context TRƯỚC nó)
  if (history.length >= 2) {
    const ctxBefore = history.slice(0, -1);
    try {
      const oldDecision = await getAIPrediction(ctxBefore, latest.session);
      out.push({
        Phien: latest.session,
        Du_doan: oldDecision.prediction,
        Do_tin_cay: oldDecision.confidence + '%',
        Ly_do: oldDecision.reason,
        KetQua: oldDecision.prediction === latest.result ? '✅ ĐÚNG' : '❌ SAI',
        Thuc_te: latest.result,
        ADMIN
      });
    } catch (e) {
      out.push({
        Phien: latest.session,
        Du_doan: 'N/A',
        Do_tin_cay: '0%',
        Ly_do: 'AI_ERR: ' + e.message,
        ADMIN
      });
    }
  }

  // Phiên kế tiếp = phiên mới nhất + 1
  const currentSession = latest.session + 1;
  const decision = await getAIPrediction(history, currentSession);

  out.push({
    Phien: currentSession,
    Du_doan: decision.prediction,
    Do_tin_cay: decision.confidence + '%',
    Ly_do: decision.reason,
    ADMIN
  });

  return out;
}

// =====================================================================
//                      PHẦN 5: ROUTES
// =====================================================================

async function handlePredict(req, res) {
  try {
    const history = await refresh(req.query.refresh === '1');
    const result = await buildResponse(history);
    res.json(result);
  } catch (error) {
    res.status(503).json({ success: false, error: error.message, ADMIN });
  }
}

app.get('/', handlePredict);
app.get('/api', handlePredict);
app.get('/api/tx', handlePredict);

app.get('/api/history', async (req, res) => {
  try {
    const history = await refresh(req.query.refresh === '1');
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    res.json(
      history.slice(-limit).reverse().map((x) => ({
        Phien: x.session,
        Xuc_xac: x.dice,
        Tong: x.total,
        Ket_qua: x.result
      }))
    );
  } catch (error) {
    res.status(503).json({ success: false, error: error.message, ADMIN });
  }
});

// Test AI thô (debug)
app.get('/api/ai-test', async (req, res) => {
  try {
    const history = await refresh();
    const latest = history[history.length - 1];
    const decision = await callAI(history, latest.session + 1);
    res.json(decision);
  } catch (error) {
    res.status(503).json({ success: false, error: error.message, ADMIN });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'DENIUS-API-SUNVIP-AI',
    source: SOURCE_API,
    aiModel: GEMINI_MODEL,
    cached: cache.history.length,
    aiCached: aiCache.size,
    lastUpdate: cache.updatedAt ? new Date(cache.updatedAt).toISOString() : null,
    sourceError: cache.error,
    uptime: Math.floor(process.uptime())
  });
});

app.use((req, res) =>
  res.status(404).json({ success: false, error: 'Endpoint not found', ADMIN })
);

// =====================================================================
//                      KHỞI ĐỘNG
// =====================================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[DENIUS-API-SUNVIP-AI] listening on ${PORT}`);
  refresh().catch((err) => console.error('[SOURCE]', err.message));
  setInterval(
    () => refresh(true).catch((err) => console.error('[SOURCE]', err.message)),
    1500
  ).unref();
});