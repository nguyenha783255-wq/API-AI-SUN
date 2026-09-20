/* =====================================================================
 *  DENIUS SUNVIP API - AI POWERED EDITION (Gemini 3 Flash Preview)
 *  - Xác thực: x-goog-api-key (Gemini API Key)
 *  - Model: gemini-3-flash-preview (mặc định)
 *  - Thinking: high (nếu model hỗ trợ)
 *  - Structured Output: JSON Schema
 *  - Cache theo session, retry có giới hạn, self-audit
 * ===================================================================== */

const express = require('express');

const app = express();
app.disable('x-powered-by');

// ==================== CORS ====================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-goog-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '100kb' }));

// ==================== CONFIG ====================
const PORT = Number(process.env.PORT) || 10000;
const ADMIN = '@DENIUS09';

const SOURCE_API =
  process.env.SOURCE_API ||
  'https://kwinstore.com/sunwin/tx/history/c806cf04a7fdf1cace25db6c7a8bdd8e048242145ee726dc';

// ==================== GEMINI AI CONFIG ====================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Timeout / Cache / Limits
const SOURCE_CACHE_MS = 750;
const FETCH_TIMEOUT_MS = 6000;
const AI_TIMEOUT_MS = 45000;
const AI_MAX_RETRIES = 2;
const AI_RETRY_DELAY_MS = 1000;
const MAX_SOURCE_RECORDS = 1000;
const AI_HISTORY_LIMIT = Math.min(
  Math.max(Number(process.env.AI_HISTORY_LIMIT) || 300, 10),
  1000
);
const AI_CACHE_MAX_ENTRIES = 50;
const AI_CACHE_TTL_MS = 5 * 60 * 1000;

// ==================== STATE ====================
let sourceCache = {
  updatedAt: 0,
  history: [],
  raw: null,
  error: null,
  promise: null
};
const aiCache = new Map(); // session -> { prediction, confidence, ... , at }
let lastGeminiError = null;

// =====================================================================
//                      PHẦN 1: PARSE DỮ LIỆU NGUỒN (giữ nguyên)
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
  const lookup = new Map(
    Object.entries(obj).map(([k, v]) => [cleanKey(k), v])
  );
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
    const possible = Object.values(value)
      .map(asNumber)
      .filter((n) => n !== null);
    if (
      possible.length >= 3 &&
      possible.slice(0, 3).every((n) => n >= 1 && n <= 6)
    ) {
      return possible.slice(0, 3).map(Number);
    }
  }
  const text = String(value ?? '').trim();
  const nums = text.match(/[1-6]/g);
  if (nums && nums.length === 3) return nums.map(Number);
  return null;
}

function extractDice(obj) {
  const direct = getByAliases(obj, [
    'dice',
    'xucxac',
    'xuc xac',
    'xuc_xac',
    'ketqua',
    'result'
  ]);
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
      'phien',
      'phienid',
      'phienhientai',
      'session',
      'sessionid',
      'round',
      'roundid',
      'issue',
      'period',
      'gameid'
    ])
  );
}

function extractResult(obj, dice) {
  const direct = getByAliases(obj, [
    'ketqua',
    'result',
    'outcome',
    'type',
    'taixiu'
  ]);
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
        'user-agent': 'DENIUS-API-SUNVIP-AI/3.0'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`SOURCE_HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function refreshSource(force = false) {
  const fresh =
    Date.now() - sourceCache.updatedAt < SOURCE_CACHE_MS &&
    sourceCache.history.length > 0;
  if (!force && fresh) return sourceCache.history;
  if (sourceCache.promise) return sourceCache.promise;

  sourceCache.promise = (async () => {
    try {
      const raw = await fetchSource();
      const history = normalizeHistory(raw);
      if (!history.length)
        throw new Error('SOURCE_HISTORY_EMPTY_OR_UNRECOGNIZED');
      sourceCache = {
        updatedAt: Date.now(),
        history,
        raw,
        error: null,
        promise: null
      };
      return history;
    } catch (error) {
      sourceCache = {
        ...sourceCache,
        error: error?.message || String(error),
        promise: null
      };
      if (sourceCache.history.length) return sourceCache.history;
      throw error;
    }
  })();

  return sourceCache.promise;
}

// =====================================================================
//                      PHẦN 3: AI ANALYSIS (Gemini)
// =====================================================================

function buildPrompt(history, targetSession) {
  const window = history.slice(-AI_HISTORY_LIMIT);
  const compact = window
    .map((x) => (x.result === 'Tài' ? 'T' : 'X'))
    .join('');

  const detail = window
    .map(
      (x) =>
        `#${x.session} ${x.dice.join('-')} (${x.total}) ${x.result}`
    )
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

=== ĐỊNH DẠNG TRẢ LỜI (JSON) ===
{
  "prediction": "Tài" | "Xỉu",
  "confidence": number (50-95),
  "stance": "string (ví dụ: NGHIÊNG, CHẮC CHẮN, NGHI NGỜ)",
  "signal": "string (tín hiệu chính)",
  "analysis": "string (phân tích chi tiết)",
  "doubt": "string (điều bạn nghi ngờ)",
  "patterns": ["string", "string", ...]
}`;
}

/**
 * Schema JSON cho structured output.
 * prediction chỉ được là "Tài" hoặc "Xỉu".
 */
const AI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    prediction: {
      type: 'string',
      enum: ['Tài', 'Xỉu'],
      description: 'Dự đoán cuối cùng: Tài hoặc Xỉu'
    },
    confidence: {
      type: 'integer',
      minimum: 50,
      maximum: 95,
      description: 'Độ tin cậy từ 50 đến 95'
    },
    stance: {
      type: 'string',
      description: 'Thái độ: NGHIÊNG, CHẮC CHẮN, NGHI NGỜ, ...'
    },
    signal: {
      type: 'string',
      description: 'Tín hiệu chính dẫn đến dự đoán'
    },
    analysis: {
      type: 'string',
      description: 'Phân tích chi tiết nhịp cầu, pattern, xu hướng'
    },
    doubt: {
      type: 'string',
      description: 'Điều AI nghi ngờ hoặc phản chứng với kết luận'
    },
    patterns: {
      type: 'array',
      items: { type: 'string' },
      description: 'Các pattern phát hiện được'
    }
  },
  required: [
    'prediction',
    'confidence',
    'stance',
    'signal',
    'analysis',
    'doubt',
    'patterns'
  ]
};

function validateAIResult(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.prediction !== 'Tài' && data.prediction !== 'Xỉu') return null;

  const confidence = Number(data.confidence);
  if (!Number.isFinite(confidence)) return null;

  return {
    prediction: data.prediction,
    confidence: Math.max(50, Math.min(95, Math.round(confidence))),
    stance: String(data.stance || 'NGHIÊNG'),
    signal: String(data.signal || ''),
    analysis: String(data.analysis || ''),
    doubt: String(data.doubt || ''),
    patterns: Array.isArray(data.patterns)
      ? data.patterns.map(String)
      : []
  };
}

async function callGeminiAPI(prompt) {
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
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: AI_RESPONSE_SCHEMA,
      thinkingConfig: {
        thinkingLevel: 'high'
      }
    },
    safetySettings: [
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_HATE_SPEECH',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        threshold: 'BLOCK_NONE'
      }
    ]
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // ✅ ĐÚNG: Gemini API dùng header x-goog-api-key
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const err = new Error(`AI_HTTP_${res.status}: ${errBody.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();

    // Structured output: responseMimeType=application/json => text là JSON string
    let text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .filter(Boolean)
        .join('') || '';

    if (!text) {
      throw new Error('AI_EMPTY_RESPONSE');
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('AI_INVALID_JSON: ' + text.slice(0, 200));
    }

    const validated = validateAIResult(parsed);
    if (!validated) {
      throw new Error('AI_SCHEMA_MISMATCH');
    }

    return validated;
  } finally {
    clearTimeout(timer);
  }
}

function shouldRetry(error) {
  const status = error?.status;
  if (status === 401 || status === 403) return false; // auth error - không retry
  if (status === 429) return true;
  if (status >= 500) return true;
  if (error?.name === 'AbortError') return true;
  return false;
}

async function callAIWithRetry(prompt) {
  let lastError;
  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
    try {
      const result = await callGeminiAPI(prompt);
      lastGeminiError = null;
      return result;
    } catch (err) {
      lastError = err;
      if (!shouldRetry(err) || attempt === AI_MAX_RETRIES) break;
      const delay = AI_RETRY_DELAY_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  lastGeminiError = lastError?.message || String(lastError);
  throw lastError;
}

async function getAIPrediction(history, targetSession) {
  const cached = aiCache.get(targetSession);
  if (cached && Date.now() - cached.at < AI_CACHE_TTL_MS) {
    return cached;
  }

  const prompt = buildPrompt(history, targetSession);
  const result = await callAIWithRetry(prompt);

  const entry = {
    ...result,
    targetSession,
    at: Date.now()
  };

  aiCache.set(targetSession, entry);

  // Giới hạn cache: giữ 20-50 entry mới nhất
  if (aiCache.size > AI_CACHE_MAX_ENTRIES) {
    const keys = Array.from(aiCache.keys());
    const removeCount = aiCache.size - AI_CACHE_MAX_ENTRIES;
    for (let i = 0; i < removeCount; i++) {
      aiCache.delete(keys[i]);
    }
  }

  return entry;
}

// =====================================================================
//                      PHẦN 4: BUILD RESPONSE
// =====================================================================

async function buildTxResponse(history) {
  const latest = history[history.length - 1];
  const out = [];

  // Đối chiếu dự đoán phiên mới nhất (nếu có context trước đó)
  if (history.length >= 2) {
    const ctxBefore = history.slice(0, -1);
    try {
      const oldDecision = await getAIPrediction(ctxBefore, latest.session);
      const actual = latest.result;
      const correct = oldDecision.prediction === actual;

      out.push({
        Phien: latest.session,
        Du_doan: oldDecision.prediction,
        Do_tin_cay: oldDecision.confidence + '%',
        AI: 'GEMINI',
        TrangThai: oldDecision.stance,
        TinHieu: oldDecision.signal,
        PhanTich: oldDecision.analysis,
        NghiNgo: oldDecision.doubt,
        Patterns: oldDecision.patterns,
        Model: GEMINI_MODEL,
        SoPhienDaPhanTich: Math.min(history.length - 1, AI_HISTORY_LIMIT),
        KetQua: correct ? '✅ ĐÚNG' : '❌ SAI',
        Thuc_te: actual,
        ADMIN
      });
    } catch (e) {
      // Không chặn response chính nếu audit lỗi
    }
  }

  // Phiên kế tiếp = phiên mới nhất + 1
  const currentSession = latest.session + 1;
  let decision;
  try {
    decision = await getAIPrediction(history, currentSession);
  } catch (e) {
    return {
      success: false,
      error: e.message,
      ADMIN
    };
  }

  out.push({
    Phien: currentSession,
    Du_doan: decision.prediction,
    Do_tin_cay: decision.confidence + '%',
    AI: 'GEMINI',
    TrangThai: decision.stance,
    TinHieu: decision.signal,
    PhanTich: decision.analysis,
    NghiNgo: decision.doubt,
    Patterns: decision.patterns,
    Model: GEMINI_MODEL,
    SoPhienDaPhanTich: Math.min(history.length, AI_HISTORY_LIMIT),
    ADMIN
  });

  return out;
}

// =====================================================================
//                      PHẦN 5: ROUTES
// =====================================================================

async function handleTx(req, res) {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({
      success: false,
      error: 'GEMINI_API_KEY_MISSING',
      ADMIN
    });
  }

  try {
    const history = await refreshSource(req.query.refresh === '1');
    const result = await buildTxResponse(history);

    if (result.success === false) {
      return res.status(503).json(result);
    }

    res.json(result);
  } catch (error) {
    res.status(503).json({
      success: false,
      error: error.message,
      ADMIN
    });
  }
}

app.get('/', handleTx);
app.get('/api', handleTx);
app.get('/api/tx', handleTx);

app.get('/api/history', async (req, res) => {
  try {
    const history = await refreshSource(req.query.refresh === '1');
    const limit = Math.min(
      100,
      Math.max(1, Number(req.query.limit) || 20)
    );
    res.json(
      history
        .slice(-limit)
        .reverse()
        .map((x) => ({
          Phien: x.session,
          Xuc_xac: x.dice,
          Tong: x.total,
          Ket_qua: x.result
        }))
    );
  } catch (error) {
    res.status(503).json({
      success: false,
      error: error.message,
      ADMIN
    });
  }
});

app.get('/api/ai/latest', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({
      success: false,
      error: 'GEMINI_API_KEY_MISSING',
      ADMIN
    });
  }

  try {
    const history = await refreshSource(req.query.refresh === '1');
    const latest = history[history.length - 1];
    const targetSession = latest.session + 1;
    const decision = await getAIPrediction(history, targetSession);

    res.json({
      Phien: targetSession,
      Du_doan: decision.prediction,
      Do_tin_cay: decision.confidence + '%',
      AI: 'GEMINI',
      TrangThai: decision.stance,
      TinHieu: decision.signal,
      PhanTich: decision.analysis,
      NghiNgo: decision.doubt,
      Patterns: decision.patterns,
      Model: GEMINI_MODEL,
      SoPhienDaPhanTich: Math.min(history.length, AI_HISTORY_LIMIT),
      ADMIN
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      error: error.message,
      ADMIN
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'DENIUS-API-SUNVIP-AI',
    source: SOURCE_API,
    cached: sourceCache.history.length,
    sourceError: sourceCache.error,
    lastUpdate: sourceCache.updatedAt
      ? new Date(sourceCache.updatedAt).toISOString()
      : null,
    gemini: {
      configured: Boolean(GEMINI_API_KEY),
      model: GEMINI_MODEL,
      thinkingLevel: 'high',
      cachedPredictions: aiCache.size,
      historyLimit: AI_HISTORY_LIMIT,
      lastError: lastGeminiError
    },
    uptime: Math.floor(process.uptime())
  });
});

app.use((req, res) =>
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    ADMIN
  })
);

// =====================================================================
//                      KHỞI ĐỘNG
// =====================================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[DENIUS-API-SUNVIP-AI] listening on ${PORT}`);
  console.log(`[GEMINI] model=${GEMINI_MODEL} thinking=high historyLimit=${AI_HISTORY_LIMIT}`);

  if (!GEMINI_API_KEY) {
    console.warn('[GEMINI] GEMINI_API_KEY is not set. AI endpoints will return 503.');
  }

  refreshSource().catch((err) =>
    console.error('[SOURCE]', err.message)
  );

  setInterval(
    () =>
      refreshSource(true).catch((err) =>
        console.error('[SOURCE]', err.message)
      ),
    1500
  ).unref();
});
