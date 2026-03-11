// ─────────────────────────────────────────────────────────────
// Split Receipt — Backend Server
// Deploy this folder to Vercel to keep your API key safe
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server.' });
  }

  const { imageBase64, mimeType } = req.body;
  if (!imageBase64 || !mimeType) {
    return res.status(400).json({ error: 'Missing imageBase64 or mimeType.' });
  }

  const geminiPayload = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
        { text: "Extract the items from this receipt. Include the name, price, and quantity for each item. Also identify if an item is tax, service charge, total, subtotal, or discount. Return a JSON array of objects. Keep the original language of the item names (e.g., Arabic). Do not translate item names. If the receipt uses Eastern Arabic numerals (٠-٩), convert them to Western numerals (0-9) for the price and quantity fields." },
      ],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            price: { type: "NUMBER" },
            quantity: { type: "NUMBER" },
            isTax: { type: "BOOLEAN" },
            isService: { type: "BOOLEAN" },
            isTotal: { type: "BOOLEAN" },
            isSubtotal: { type: "BOOLEAN" },
            isDiscount: { type: "BOOLEAN" },
          },
          required: ["name", "price", "quantity"],
        },
      },
    },
  };

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(geminiRes.status).json({ error: errText });
    }

    const geminiData = await geminiRes.json();
    const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

    let parsed;
    try {
      let clean = text.trim();
      if (clean.startsWith('```json')) clean = clean.replace(/^```json\n/, '').replace(/\n```$/, '');
      else if (clean.startsWith('```')) clean = clean.replace(/^```\n/, '').replace(/\n```$/, '');
      parsed = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: 'Failed to parse Gemini response', raw: text });
    }

    return res.status(200).json({ items: parsed });
  } catch (err) {
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
}
