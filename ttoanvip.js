/* =====================================================================
 *  DENIUS SUNVIP API — Gemini Interactions API Edition
 *  Endpoint: https://generativelanguage.googleapis.com/v1beta/interactions
 *  Auth: x-goog-api-key
 *  Model: gemini-3.8-flash (default)
 *  Thinking: high
 *  Structured Output: response_format + JSON schema
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

// ==================== GEMINI INTERACTIONS API CONFIG ====================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

// ✅ Interactions API endpoint — KHÔNG dùng generateContent
const GEMINI_INTERACTIONS_URL =
  'https://generativelanguage.googleapis.com/v1beta/interactions';

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

const aiCache = new Map(); // targetSession -> { prediction, ..., at }
const selfAuditLog = []; // lịch sử đối chiếu prediction vs actual
let lastGeminiError = null;

// =====================================================================
//              PHẦN 1: PARSE DỮ LIỆU NGUỒN (giữ nguyên)
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
    'dice', 'xucxac', 'xuc xac', 'xuc_xac', 'ketqua', 'result'
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
      'phien', 'phienid', 'phienhientai', 'session', 'sessionid',
      'round', 'roundid', 'issue', 'period', 'gameid'
    ])
  );
}

function extractResult(obj, dice) {
  const direct = getByAliases(obj, [
    'ketqua', 'result', 'outcome', 'type', 'taixiu'
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
//              PHẦN 2: FETCH NGUỒN
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
        'user-agent': 'DENIUS-API-SUNVIP-AI/4.0'
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
//              PHẦN 3: MULTI-WINDOW ANALYSIS
// =====================================================================

function buildMultiWindowContext(history) {
  const total = history.length;
  const windows = [10, 20, 50, 100, 300, 500].filter((n) => n <= total);
  if (windows.length === 0 || windows[windows.length - 1] < total) {
    windows.push(total);
  }

  const parts = [];

  for (const size of windows) {
    const slice = history.slice(-size);
    const compact = slice
      .map((x) => (x.result === 'Tài' ? 'T' : 'X'))
      .join('');

    const taiCount = slice.filter((x) => x.result === 'Tài').length;
    const xiuCount = size - taiCount;

    // Bệt detection
    let maxTaiStreak = 0;
    let maxXiuStreak = 0;
    let currentStreak = 0;
    let currentType = null;
    for (const x of slice) {
      if (x.result === currentType) {
        currentStreak++;
      } else {
        currentType = x.result;
        currentStreak = 1;
      }
      if (currentType === 'Tài') {
        maxTaiStreak = Math.max(maxTaiStreak, currentStreak);
      } else {
        maxXiuStreak = Math.max(maxXiuStreak, currentStreak);
      }
    }

    // Tổng điểm
    const sums = slice.map((x) => x.total);
    const avgSum = sums.reduce((a, b) => a + b, 0) / sums.length;

    parts.push(
      `[${size} phiên] Nhịp: ${compact}\n` +
      `  Tài=${taiCount}, Xỉu=${xiuCount}, ` +
      `bệt Tài max=${maxTaiStreak}, bệt Xỉu max=${maxXiuStreak}, ` +
      `tổng TB=${avgSum.toFixed(1)}`
    );
  }

  return parts.join('\n\n');
}

// =====================================================================
//              PHẦN 4: GEMINI INTERACTIONS API
// =====================================================================

function buildPrompt(history, targetSession) {
  const window = history.slice(-AI_HISTORY_LIMIT);
  const multiWindow = buildMultiWindowContext(window);
  const dataWindow = window.length;

  // Chi tiết từng phiên (chỉ 50 phiên gần nhất để tiết kiệm token)
  const detailWindow = window.slice(-50);
  const detail = detailWindow
    .map((x) => `#${x.session} ${x.dice.join('-')} (${x.total}) ${x.result}`)
    .join('\n');

  // Self-audit context
  const recentAudit = selfAuditLog.slice(-10);
  let auditContext = '';
  if (recentAudit.length > 0) {
    auditContext =
      '\n=== LỊCH SỬ ĐỐI CHIẾU DỰ ĐOÁN GẦN ĐÂY ===\n' +
      recentAudit
        .map(
          (a) =>
            `Phiên ${a.session}: dự đoán ${a.prediction} (${a.confidence}%) vs thực tế ${a.actual} => ${a.correct ? 'ĐÚNG' : 'SAI'}`
        )
        .join('\n') +
      '\nHãy xem xét các tín hiệu trước đây đúng/sai thế nào để điều chỉnh.';
  }

  return `Bạn là chuyên gia phân tích Tài/Xỉu nhiều kinh nghiệm. Bạn không được bịa pattern, không được tuyên bố chắc chắn thắng, và phải tìm tín hiệu chống lại kết luận của chính mình.

=== CỬA SỔ DỮ LIỆU: ${dataWindow} PHIÊN ===

${multiWindow}

=== CHI TIẾT 50 PHIÊN GẦN NHẤT ===
${detail}
${auditContext}

=== NHIỆM VỤ ===
Dự đoán kết quả phiên: ${targetSession}

Phân tích đa tầng:
1. Nhịp Tài/Xỉu: bệt Tài, bệt Xỉu, xen kẽ, nhịp lặp, chuyển trạng thái
2. Pattern cụm: 1-1, 2-2, 1-2-1, 3-1, 3-2, cụm ngắn/dài
3. Tổng điểm: phân bố, xu hướng lệch Tài hay lệch Xỉu
4. Từng mặt xúc xắc: tần suất, bộ ba lặp lại
5. Ngắn hạn vs trung hạn vs dài hạn: tín hiệu có nhất quán không?
6. Điểm bất thường: có gì khác thường không?
7. Tín hiệu xung đột: dữ liệu nào chống lại kết luận của bạn?

Yêu cầu nghiêm ngặt:
- KHÔNG bịa pattern không tồn tại trong dữ liệu
- KHÔNG tuyên bố chắc chắn thắng
- Phải ghi rõ doubt nếu tín hiệu mâu thuẫn
- Nếu tín hiệu yếu, confidence phải thấp
- confidence KHÔNG phải xác suất thắng thực tế
- Trả về JSON đúng schema, không markdown

=== SCHEMA JSON ===
{
  "prediction": "Tài" hoặc "Xỉu",
  "confidence": số nguyên 50-95,
  "stance": "NGHIÊNG" / "CHẮC CHẮN" / "NGHI NGỜ" / "TRUNG LẬP",
  "signal": "tín hiệu chính (ngắn gọn)",
  "analysis": "phân tích chi tiết đa tầng",
  "doubt": "điều bạn nghi ngờ, tín hiệu phản chứng",
  "patterns": ["pattern 1", "pattern 2", ...],
  "data_window": ${dataWindow}
}`;
}

// =====================================================================
//              PHẦN 5: JSON SCHEMA (response_format)
// =====================================================================

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
      description: 'Độ tin cậy 50-95, không phải xác suất thắng'
    },
    stance: {
      type: 'string',
      description: 'Thái độ: NGHIÊNG, CHẮC CHẮN, NGHI NGỜ, TRUNG LẬP'
    },
    signal: {
      type: 'string',
      description: 'Tín hiệu chính dẫn đến dự đoán'
    },
    analysis: {
      type: 'string',
      description: 'Phân tích chi tiết đa tầng'
    },
    doubt: {
      type: 'string',
      description: 'Điều nghi ngờ, tín hiệu phản chứng'
    },
    patterns: {
      type: 'array',
      items: { type: 'string' },
      description: 'Các pattern phát hiện được'
    },
    data_window: {
      type: 'integer',
      description: 'Số phiên đã phân tích'
    }
  },
  required: [
    'prediction',
    'confidence',
    'stance',
    'signal',
    'analysis',
    'doubt',
    'patterns',
    'data_window'
  ]
};

// =====================================================================
//              PHẦN 6: EXTRACT TEXT TỪ INTERACTIONS RESPONSE
// =====================================================================

/**
 * Trích xuất text từ Interactions API response.
 * Ưu tiên output_text, sau đó steps/outputs.
 * KHÔNG dùng candidates[0].content.parts (style generateContent cũ).
 */
function extractInteractionText(data) {
  if (!data || typeof data !== 'object') return null;

  // Ưu tiên 1: output_text (string)
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  // Ưu tiên 2: steps array (schema mới)
  if (Array.isArray(data.steps)) {
    const textParts = [];
    for (const step of data.steps) {
      if (step?.type === 'model_output' && Array.isArray(step.content)) {
        for (const block of step.content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          }
        }
      }
      // Một số response có thể có content trực tiếp
      if (Array.isArray(step?.content)) {
        for (const block of step.content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            if (!textParts.includes(block.text)) textParts.push(block.text);
          }
        }
      }
    }
    if (textParts.length > 0) return textParts.join('');
  }

  // Ưu tiên 3: outputs array (schema cũ hơn, trước breaking change)
  if (Array.isArray(data.outputs)) {
    const textParts = [];
    for (const out of data.outputs) {
      if (out?.type === 'text' && typeof out.text === 'string') {
        textParts.push(out.text);
      }
    }
    if (textParts.length > 0) return textParts.join('');
  }

  // Ưu tiên 4: tìm trong các field có thể
  if (Array.isArray(data.content)) {
    const textParts = [];
    for (const block of data.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    if (textParts.length > 0) return textParts.join('');
  }

  return null;
}

// =====================================================================
//              PHẦN 7: VALIDATE AI RESULT
// =====================================================================

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
    patterns: Array.isArray(data.patterns) ? data.patterns.map(String) : [],
    data_window: Number(data.data_window) || 0
  };
}

// =====================================================================
//              PHẦN 8: GỌI GEMINI INTERACTIONS API
// =====================================================================

async function callGeminiInteractions(prompt) {
  const body = {
    model: GEMINI_MODEL,
    input: prompt,
    store: false,
    generation_config: {
      max_output_tokens: 8192,
      thinking_level: 'high'
    },
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: AI_RESPONSE_SCHEMA
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const res = await fetch(GEMINI_INTERACTIONS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // ✅ ĐÚNG cho Gemini API key: x-goog-api-key
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errMsg = errText.slice(0, 500);

      try {
        const errJson = JSON.parse(errText);
        errMsg =
          errJson?.error?.message ||
          errJson?.message ||
          errMsg;
      } catch {
        // giữ nguyên text
      }

      const err = new Error(`AI_HTTP_${res.status}: ${errMsg}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();

    // Trích xuất text từ Interactions response
    const text = extractInteractionText(data);

    if (!text) {
      throw new Error(
        'AI_EMPTY_RESPONSE: ' + JSON.stringify(data).slice(0, 400)
      );
    }

    // Parse JSON
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('AI_INVALID_JSON: ' + text.slice(0, 300));
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

// =====================================================================
//              PHẦN 9: RETRY LOGIC
// =====================================================================

function shouldRetry(error) {
  const status = error?.status;
  // KHÔNG retry 401, 403 — authentication/config error
  if (status === 401 || status === 403) return false;
  // KHÔNG retry 400, 404 — request/model error
  if (status === 400 || status === 404) return false;
  // Retry 429, 500, 502, 503
  if (status === 429 || status >= 500) return true;
  // Retry timeout / network
  if (error?.name === 'AbortError') return true;
  if (error?.message?.includes('fetch failed')) return true;
  return false;
}

async function callAIWithRetry(prompt) {
  let lastError;
  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
    try {
      const result = await callGeminiInteractions(prompt);
      lastGeminiError = null;
      return result;
    } catch (err) {
      lastError = err;

      // Log kỹ thuật (không log key)
      console.error(
        `[GEMINI] attempt ${attempt + 1}/${AI_MAX_RETRIES + 1} failed: ${err.message}`
      );

      if (!shouldRetry(err) || attempt === AI_MAX_RETRIES) break;

      const delay = AI_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.log(`[GEMINI] retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  lastGeminiError = lastError?.message || String(lastError);
  throw lastError;
}

// =====================================================================
//              PHẦN 10: AI PREDICTION + CACHE + SELF-AUDIT
// =====================================================================

async function getAIPrediction(history, targetSession) {
  // Cache check
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

  // Giới hạn cache
  if (aiCache.size > AI_CACHE_MAX_ENTRIES) {
    const keys = Array.from(aiCache.keys());
    const removeCount = aiCache.size - AI_CACHE_MAX_ENTRIES;
    for (let i = 0; i < removeCount; i++) {
      aiCache.delete(keys[i]);
    }
  }

  return entry;
}

/**
 * Ghi self-audit: so sánh prediction cũ vs actual result.
 */
function recordSelfAudit(session, prediction, confidence, actual) {
  // Tránh ghi trùng
  const exists = selfAuditLog.find((a) => a.session === session);
  if (exists) return;

  selfAuditLog.push({
    session,
    prediction,
    confidence,
    actual,
    correct: prediction === actual,
    timestamp: Date.now()
  });

  // Giới hạn log
  if (selfAuditLog.length > 200) {
    selfAuditLog.splice(0, selfAuditLog.length - 200);
  }
}

// =====================================================================
//              PHẦN 11: BUILD RESPONSE
// =====================================================================

async function buildTxResponse(history) {
  const latest = history[history.length - 1];

  // === SELF-AUDIT: đối chiếu dự đoán phiên mới nhất ===
  if (history.length >= 2) {
    const ctxBefore = history.slice(0, -1);
    const prevSession = latest.session;

    try {
      // Lấy prediction cũ từ cache (KHÔNG gọi AI lại)
      let oldDecision = aiCache.get(prevSession);

      if (oldDecision) {
        // Có cache → ghi audit
        recordSelfAudit(
          prevSession,
          oldDecision.prediction,
          oldDecision.confidence,
          latest.result
        );
      } else {
        // Không có cache → thử gọi AI với context trước đó
        try {
          oldDecision = await getAIPrediction(ctxBefore, prevSession);
          recordSelfAudit(
            prevSession,
            oldDecision.prediction,
            oldDecision.confidence,
            latest.result
          );
        } catch {
          // Bỏ qua nếu không lấy được
          oldDecision = null;
        }
      }
    } catch (e) {
      // Không chặn response chính
      console.error('[SELF-AUDIT]', e.message);
    }
  }

  // === DỰ ĐOÁN PHIÊN HIỆN TẠI ===
  const currentSession = latest.session + 1;
  let decision;
  try {
    decision = await getAIPrediction(history, currentSession);
  } catch (e) {
    return { success: false, error: e.message, ADMIN };
  }

  return {
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
  };
}

// =====================================================================
//              PHẦN 12: ROUTES
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

    res.json([result]);
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
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
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
      lastError: lastGeminiError,
      selfAuditEntries: selfAuditLog.length,
      endpoint: GEMINI_INTERACTIONS_URL
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
//              KHỞI ĐỘNG
// =====================================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[DENIUS-API-SUNVIP-AI] listening on ${PORT}`);
  console.log(
    `[GEMINI] endpoint=${GEMINI_INTERACTIONS_URL} model=${GEMINI_MODEL} thinking=high historyLimit=${AI_HISTORY_LIMIT}`
  );

  if (!GEMINI_API_KEY) {
    console.warn(
      '[GEMINI] GEMINI_API_KEY is not set. AI endpoints will return 503.'
    );
  }

  refreshSource().catch((err) => console.error('[SOURCE]', err.message));

  setInterval(
    () =>
      refreshSource(true).catch((err) =>
        console.error('[SOURCE]', err.message)
      ),
    1500
  ).unref();
});
