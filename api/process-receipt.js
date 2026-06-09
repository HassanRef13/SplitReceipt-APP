const GEMINI_MODEL = 'gemini-2.5-flash';
const OCR_SPACE_URL = 'https://api.ocr.space/parse/image';

const RECEIPT_PROMPT = [
  'Extract the items from this receipt.',
  'Include the name, price, and quantity for each item.',
  'Also identify if an item is tax, service charge, total, subtotal, or discount.',
  'Return a JSON array of objects.',
  'Keep the original language of item names. Do not translate item names.',
  'If the receipt uses Eastern Arabic numerals, convert them to Western numerals for price and quantity fields.',
].join(' ');

const EMPTY_FLAGS = {
  isTax: false,
  isService: false,
  isTotal: false,
  isSubtotal: false,
  isDiscount: false,
};

function normalizeDigits(value) {
  return String(value)
    .replace(/[\u0660-\u0669]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - 0x06f0));
}

function cleanNumber(value) {
  const normalized = normalizeDigits(value)
    .replace(/[^\d.,-]/g, '')
    .replace(/,/g, '.');
  const matches = normalized.match(/-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;
  return Number(matches[matches.length - 1]);
}

function stripCodeFence(text) {
  let clean = String(text || '').trim();
  if (clean.startsWith('```json')) clean = clean.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  else if (clean.startsWith('```')) clean = clean.replace(/^```\s*/, '').replace(/\s*```$/, '');
  return clean.trim();
}

function classifyLine(line) {
  const lower = line.toLowerCase();
  const totalWords = [
    'total',
    'grand total',
    'amount due',
    'net total',
    '\u0627\u0644\u0627\u062c\u0645\u0627\u0644\u064a',
    '\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a',
    '\u0627\u062c\u0645\u0627\u0644\u064a',
    '\u0625\u062c\u0645\u0627\u0644\u064a',
    '\u0627\u0644\u0645\u062c\u0645\u0648\u0639',
  ];
  const subtotalWords = [
    'subtotal',
    'sub total',
    'sub-total',
    '\u0642\u0628\u0644 \u0627\u0644\u0636\u0631\u064a\u0628\u0629',
    '\u0627\u0644\u0645\u062c\u0645\u0648\u0639 \u0627\u0644\u0641\u0631\u0639\u064a',
  ];
  const taxWords = [
    'tax',
    'vat',
    '\u0636\u0631\u064a\u0628\u0629',
    '\u0627\u0644\u0636\u0631\u064a\u0628\u0629',
    '\u0642\u064a\u0645\u0629 \u0645\u0636\u0627\u0641\u0629',
  ];
  const serviceWords = [
    'service',
    'service charge',
    '\u062e\u062f\u0645\u0629',
    '\u0627\u0644\u062e\u062f\u0645\u0629',
  ];
  const discountWords = [
    'discount',
    '\u062e\u0635\u0645',
    '\u0627\u0644\u062e\u0635\u0645',
  ];

  return {
    isTax: taxWords.some(word => lower.includes(word)),
    isService: serviceWords.some(word => lower.includes(word)),
    isTotal: totalWords.some(word => lower.includes(word)) && !subtotalWords.some(word => lower.includes(word)),
    isSubtotal: subtotalWords.some(word => lower.includes(word)),
    isDiscount: discountWords.some(word => lower.includes(word)),
  };
}

function sanitizeItem(item) {
  const name = String(item?.name || '').trim();
  const price = Number(item?.price);
  const quantity = Number(item?.quantity || 1);

  if (!name || !Number.isFinite(price)) return null;

  return {
    name,
    price,
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    isTax: Boolean(item?.isTax),
    isService: Boolean(item?.isService),
    isTotal: Boolean(item?.isTotal),
    isSubtotal: Boolean(item?.isSubtotal),
    isDiscount: Boolean(item?.isDiscount),
  };
}

function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(sanitizeItem).filter(Boolean);
}

function parseReceiptText(rawText) {
  const lines = normalizeDigits(rawText)
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 2);

  const items = [];

  for (const line of lines) {
    const priceMatches = line.match(/-?\d+(?:[.,]\d{1,2})?/g);
    if (!priceMatches || priceMatches.length === 0) continue;

    const priceText = priceMatches[priceMatches.length - 1];
    const price = cleanNumber(priceText);
    if (!Number.isFinite(price)) continue;

    const name = line
      .replace(priceText, '')
      .replace(/\b(?:egp|le|l\.e|\u062c\u0646\u064a\u0647|\u062c\u0645)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!name || name.length < 2) continue;

    const flags = classifyLine(name);
    items.push({
      name,
      price,
      quantity: 1,
      ...EMPTY_FLAGS,
      ...flags,
    });
  }

  return items;
}

async function runGeminiOcr({ imageBase64, mimeType, apiKey }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set on the server.');

  const payload = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
        { text: RECEIPT_PROMPT },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            price: { type: 'NUMBER' },
            quantity: { type: 'NUMBER' },
            isTax: { type: 'BOOLEAN' },
            isService: { type: 'BOOLEAN' },
            isTotal: { type: 'BOOLEAN' },
            isSubtotal: { type: 'BOOLEAN' },
            isDiscount: { type: 'BOOLEAN' },
          },
          required: ['name', 'price', 'quantity'],
        },
      },
    },
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini failed with ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  const parsed = JSON.parse(stripCodeFence(text));
  const items = sanitizeItems(parsed);

  if (items.length === 0) throw new Error('Gemini returned no usable receipt items.');
  return { items, provider: 'gemini' };
}

async function runOcrSpaceEngine({ imageBase64, mimeType, apiKey, engine }) {
  if (!apiKey) throw new Error('OCR_SPACE_API_KEY is not set on the server.');

  const form = new URLSearchParams();
  form.set('apikey', apiKey);
  form.set('base64Image', `data:${mimeType};base64,${imageBase64}`);
  form.set('language', 'ara');
  form.set('isOverlayRequired', 'false');
  form.set('isTable', 'true');
  form.set('scale', 'true');
  form.set('OCREngine', String(engine));

  const response = await fetch(OCR_SPACE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OCR.space failed with ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  if (data?.IsErroredOnProcessing) {
    const message = Array.isArray(data?.ErrorMessage) ? data.ErrorMessage.join(', ') : data?.ErrorMessage;
    throw new Error(message || 'OCR.space could not process this image.');
  }

  const rawText = (data?.ParsedResults || [])
    .map(result => result?.ParsedText || '')
    .join('\n')
    .trim();

  const items = sanitizeItems(parseReceiptText(rawText));
  if (items.length === 0) throw new Error('OCR.space returned no usable receipt items.');

  return { items, provider: 'ocr.space', ocrEngine: engine, rawText };
}

async function runOcrSpace(params) {
  const errors = [];

  for (const engine of [2, 3]) {
    try {
      return await runOcrSpaceEngine({ ...params, engine });
    } catch (error) {
      errors.push(`engine ${engine}: ${error.message}`);
    }
  }

  throw new Error(errors.join(' | '));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64 || !mimeType) {
    return res.status(400).json({ error: 'Missing imageBase64 or mimeType.' });
  }

  const errors = [];

  try {
    const geminiResult = await runGeminiOcr({
      imageBase64,
      mimeType,
      apiKey: process.env.GEMINI_API_KEY,
    });
    console.log('[ocr] provider=gemini status=success items=%d', geminiResult.items.length);
    return res.status(200).json(geminiResult);
  } catch (error) {
    console.warn('[ocr] provider=gemini status=failed reason=%s', error.message);
    errors.push({ provider: 'gemini', message: error.message });
  }

  try {
    const ocrSpaceResult = await runOcrSpace({
      imageBase64,
      mimeType,
      apiKey: process.env.OCR_SPACE_API_KEY,
    });
    console.log(
      '[ocr] provider=ocr.space status=success engine=%s items=%d fallback=true',
      ocrSpaceResult.ocrEngine,
      ocrSpaceResult.items.length
    );
    return res.status(200).json({
      ...ocrSpaceResult,
      fallbackUsed: true,
      fallbackReason: errors[0]?.message,
    });
  } catch (error) {
    errors.push({ provider: 'ocr.space', message: error.message });
  }

  return res.status(502).json({
    error: 'Could not process receipt with Gemini or OCR.space.',
    errors,
  });
}
