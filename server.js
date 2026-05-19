require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const RAW_VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const VERIFY_TOKEN = RAW_VERIFY_TOKEN ? RAW_VERIFY_TOKEN.trim() : null;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL;
const BASE_URL = process.env.BASE_URL;

const CWD = __dirname;

const conversations = new Map();

const MODEL_FALLBACKS = [
  'openrouter/free',
  'qwen/qwen-turbo',
  'mistralai/mistral-7b-instruct',
];

const SYSTEM_PROMPT = `তুমি বোরনালি কোম্পানির একজন ফেসবুক শপ সহকারী।

ভাষার নিয়ম:
- তুমি শুধুমাত্র খাঁটি বাংলায় উত্তর দেবে
- কখনো ইংরেজি বা বাংলিশে উত্তর দিও না
- ক্রেতা বাংলা, বাংলিশ বা ইংরেজিতে প্রশ্ন করতে পারে — তুমি সব বুঝবে কিন্তু শুধু বাংলায় উত্তর দেবে

আমাদের প্রোডাক্ট:
১. হাফ স্লিভ শার্ট — ৬৯০ টাকা (ক্যাশ অন ডেলিভারি)
২. পাঞ্জাবি — ৭৯০ টাকা (ক্যাশ অন ডেলিভারি)
৩. বেবি পাঞ্জাবি — শুধুমাত্র প্রিপেমেন্টে

সাইজ সম্পর্কিত নিয়ম:
- সাইজ নিয়ে কখনো নিজে কিছু বলবে না
- সাইজ চার্ট ইমেজে আছে — ক্রেতাকে ইমেজ দেখে বেছে নিতে বলবে
- S/M/L/XL বা কোন সাইজের নাম নিজে থেকে বলবে না

অর্ডার কালেকশন:
প্রাকৃতিকভাবে পর্যায়ক্রমে সংগ্রহ করবে: নাম → ফোন নম্বর → ঠিকানা → প্রোডাক্ট → সাইজ

অজানা প্রশ্নে:
"দুঃখিত, এই তথ্যটি আমার কাছে নেই। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।"

সবসময় ছোট এবং স্বাভাবিক বাংলায় উত্তর দাও (১-৩ লাইন)।
মানুষের মতো সহজাত ও বন্ধুত্বপূর্ণ হবে। AI এর মতো হবে না।`;

async function sendMessage(senderId, text) {
  try {
    const res = await axios.post(
      'https://graph.facebook.com/v18.0/me/messages',
      {
        recipient: { id: senderId },
        message: { text },
      },
      { params: { access_token: PAGE_ACCESS_TOKEN } },
    );
    console.log(`[FB SEND OK] ${senderId}: status=${res.status}, text="${text.substring(0, 60)}"`);
  } catch (err) {
    console.error('[FB SEND ERROR] ============');
    console.error('Status:', err.response?.status);
    console.error('Body:', JSON.stringify(err.response?.data, null, 2));
    console.error('Message:', err.message);
    console.error('[FB SEND ERROR END] ========');
  }
}

async function sendImage(senderId, productType) {
  if (!BASE_URL) {
    console.error('[IMG ERROR] BASE_URL not set');
    return;
  }
  const imagePath = getCoverImage(productType);
  if (!imagePath) {
    console.error('[IMG ERROR] No cover image found for', productType);
    return;
  }
  const folder = productType === 'shirt' ? 'Shirt' : 'Panjabi';
  const imageUrl = `${BASE_URL}/media/${folder}/${encodeURIComponent(path.basename(imagePath))}`;
  try {
    const res = await axios.post(
      'https://graph.facebook.com/v18.0/me/messages',
      {
        recipient: { id: senderId },
        message: {
          attachment: {
            type: 'image',
            payload: { url: imageUrl, is_reusable: true },
          },
        },
      },
      { params: { access_token: PAGE_ACCESS_TOKEN } },
    );
    console.log(`[FB IMG OK] ${senderId}: ${productType}, status=${res.status}`);
  } catch (err) {
    console.error('[FB IMG ERROR] ============');
    console.error('Status:', err.response?.status);
    console.error('Body:', JSON.stringify(err.response?.data, null, 2));
    console.error('Message:', err.message);
    console.error('[FB IMG ERROR END] ========');
  }
}

async function sendSizeChart(senderId, productType) {
  if (!BASE_URL) {
    console.error('[CHART ERROR] BASE_URL not set');
    return;
  }
  const folder = productType === 'shirt' ? 'Shirt' : 'Panjabi';
  const chartUrl = `${BASE_URL}/media/${folder}/Size%20chart.jpg`;
  try {
    await axios.post(
      'https://graph.facebook.com/v18.0/me/messages',
      {
        recipient: { id: senderId },
        message: {
          attachment: {
            type: 'image',
            payload: { url: chartUrl, is_reusable: true },
          },
        },
      },
      { params: { access_token: PAGE_ACCESS_TOKEN } },
    );
    console.log(`[CHART OK] ${senderId}: ${productType}`);
    await sendMessage(senderId, 'এই চার্ট অনুযায়ী আপনি কোন সাইজটি নিতে চান?');
  } catch (err) {
    console.error('[CHART ERROR] ============');
    console.error('Status:', err.response?.status);
    console.error('Body:', JSON.stringify(err.response?.data, null, 2));
    console.error('Message:', err.message);
    console.error('[CHART ERROR END] ========');
  }
}

function getCoverImage(productType) {
  try {
    if (productType === 'shirt') {
      const dir = path.join(CWD, 'Shirt');
      const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg)$/i.test(f) && !/size\s*chart/i.test(f)).sort();
      return files.length > 0 ? path.join(dir, files[0]) : null;
    }
    if (productType === 'panjabi') {
      const dir = path.join(CWD, 'Panjabi');
      const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg)$/i.test(f) && !/size\s*chart/i.test(f)).sort();
      return files.length > 0 ? path.join(dir, files[0]) : null;
    }
    return null;
  } catch (err) {
    console.error('[COVER ERROR]', err.message);
    return null;
  }
}

function detectIntent(text) {
  const lower = text.toLowerCase();

  const hasShirt = /শার্ট|shirt/.test(lower);
  const hasPanjabi = /পাঞ্জাবি|panjabi/.test(lower);
  const hasSize = /সাইজ|size|chart|sizing|সাইস/.test(lower);
  const hasPic = /ছবি|pic|photo|image|ফটো|দেখা|pictures?|pics/.test(lower);
  const hasPrice = /দাম|price|কত|মূল্য|cost|টাকা|dam|dham|mullo|mull|dammo/.test(lower);
  const hasShirtKeyword = /শার্ট|shirt/.test(lower);
  const hasPanjabiKeyword = /পাঞ্জাবি|panjabi/.test(lower);

  if (hasSize && hasShirtKeyword) {
    return { action: 'size_chart', product: 'shirt', intent: 'shirt_size', reply: 'এই চার্ট অনুযায়ী আপনি কোন সাইজটি নিতে চান?' };
  }

  if (hasSize && hasPanjabiKeyword) {
    return { action: 'size_chart', product: 'panjabi', intent: 'panjabi_size', reply: 'এই চার্ট অনুযায়ী আপনি কোন সাইজটি নিতে চান?' };
  }

  if (hasSize) {
    return { action: 'size_chart', product: 'shirt', intent: 'generic_size', reply: 'এই চার্ট অনুযায়ী আপনি কোন সাইজটি নিতে চান?' };
  }

  if (hasShirt && hasPic) {
    return { action: 'image', product: 'shirt', intent: 'shirt_picture', reply: 'এটি আমাদের হাফ স্লিভ শার্ট (৬৯০ টাকা)। ক্যাশ অন ডেলিভারি পাওয়া যাবে।' };
  }

  if (hasPanjabi && hasPic) {
    return { action: 'image', product: 'panjabi', intent: 'panjabi_picture', reply: 'এটি আমাদের পাঞ্জাবি (৭৯০ টাকা)। ক্যাশ অন ডেলিভারি পাওয়া যাবে।' };
  }

  if (hasPrice && hasShirt) {
    return { action: 'price', product: 'shirt', intent: 'shirt_price', reply: 'হাফ স্লিভ শার্টের দাম ৬৯০ টাকা। ক্যাশ অন ডেলিভারি পাওয়া যাবে।' };
  }

  if (hasPrice && hasPanjabi) {
    return { action: 'price', product: 'panjabi', intent: 'panjabi_price', reply: 'পাঞ্জাবির দাম ৭৯০ টাকা। ক্যাশ অন ডেলিভারি পাওয়া যাবে।' };
  }

  return { action: 'ai', intent: 'ai_fallback' };
}

async function executeIntent(senderId, text) {
  const intent = detectIntent(text);

  switch (intent.action) {
    case 'size_chart':
      console.log('[INTENT] size chart for', intent.product);
      await sendImage(senderId, intent.product);
      await sendSizeChart(senderId, intent.product);
      return true;

    case 'image':
      console.log('[INTENT]', intent.product, 'picture');
      await sendImage(senderId, intent.product);
      await sendMessage(senderId, intent.reply);
      return true;

    case 'price':
      console.log('[INTENT]', intent.product, 'price');
      await sendMessage(senderId, intent.reply);
      return true;

    default:
      return false;
  }
}

async function openRouterChat(messages) {
  if (!OPENROUTER_API_KEY) {
    console.error('[OR ERROR] OPENROUTER_API_KEY is not set');
    return 'AI temporarily unavailable (API key not configured)';
  }

  const models = MODEL ? [MODEL, ...MODEL_FALLBACKS] : MODEL_FALLBACKS;
  let lastError = '';

  for (const model of models) {
    try {
      const msgCount = messages.length;
      const userMsg = messages.filter(m => m.role === 'user').length;
      console.log(`[OR TRY] model=${model}, messages=${msgCount}, user_turns=${userMsg}`);

      const res = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model, messages, max_tokens: 300 },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/sakib6567/bornali-ai-chatbot',
          },
          timeout: 30000,
        },
      );

      const reply = res.data?.choices?.[0]?.message?.content;
      if (!reply) {
        console.error(`[OR WARN] ${model}: empty response, body=`, JSON.stringify(res.data));
        continue;
      }

      console.log(`[OR OK] ${model}: reply="${reply.substring(0, 80)}"`);
      return reply;
    } catch (err) {
      console.error(`[OR FAIL] ${model} ============`);
      console.error('Status:', err.response?.status);
      console.error('Body:', JSON.stringify(err.response?.data, null, 2));
      console.error('Code:', err.code);
      console.error('Message:', err.message);
      console.error('[OR FAIL END] ================');
      lastError = err.response?.data?.error?.message || err.message;
    }
  }

  console.error(`[OR] ALL ${models.length} models failed. Last error: ${lastError}`);
  return 'AI temporarily unavailable. Please try again later.';
}

app.use('/media/Shirt', express.static(path.join(CWD, 'Shirt')));
app.use('/media/Panjabi', express.static(path.join(CWD, 'Panjabi')));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'] ? req.query['hub.verify_token'].trim() : null;
  const challenge = req.query['hub.challenge'];

  console.log('=== WEBHOOK VERIFICATION REQUEST ===');
  console.log('Query params:', JSON.stringify(req.query, null, 2));
  console.log('hub.mode:', JSON.stringify(mode));
  console.log('hub.verify_token length:', token ? token.length : 0);
  console.log('hub.challenge present:', !!challenge);
  console.log('VERIFY_TOKEN env var set:', !!RAW_VERIFY_TOKEN);
  console.log('VERIFY_TOKEN env var length:', RAW_VERIFY_TOKEN ? RAW_VERIFY_TOKEN.length : 0);

  if (!RAW_VERIFY_TOKEN) {
    console.error('ERROR: VERIFY_TOKEN not set in environment');
    return res.status(403).type('text/plain').send('ERROR: VERIFY_TOKEN not set in environment variables');
  }

  if (mode !== 'subscribe') {
    console.error('ERROR: Invalid hub.mode - expected "subscribe", got:', JSON.stringify(mode));
    return res.status(403).type('text/plain').send('ERROR: Invalid hub.mode: ' + JSON.stringify(mode));
  }

  if (token !== VERIFY_TOKEN) {
    console.error('ERROR: Token mismatch');
    console.error('  Expected token length:', VERIFY_TOKEN.length);
    console.error('  Received token length:', token ? token.length : 0);
    console.error('  Expected first char:', VERIFY_TOKEN[0]);
    console.error('  Received first char:', token ? token[0] : 'null');
    console.error('  Expected last char:', VERIFY_TOKEN[VERIFY_TOKEN.length - 1]);
    console.error('  Received last char:', token ? token[token.length - 1] : 'null');
    return res.status(403).type('text/plain').send('ERROR: Verify token mismatch');
  }

  if (!challenge) {
    console.error('ERROR: Missing hub.challenge in request');
    return res.status(403).type('text/plain').send('ERROR: Missing hub.challenge');
  }

  console.log('=== WEBHOOK VERIFIED SUCCESSFULLY ===');
  console.log('Returning challenge:', challenge.substring(0, 50));
  res.status(200).type('text/plain').send(challenge);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        if (!event.message) {
          console.log('[WEBHOOK] Skipping non-message event');
          continue;
        }

        const senderId = event.sender?.id;
        const messageText = event.message?.text;

        if (!messageText) {
          console.log('[WEBHOOK] Skipping empty message');
          continue;
        }
        if (event.message.is_echo) {
          console.log('[WEBHOOK] Skipping echo (own message)');
          continue;
        }

        console.log(`[MSG IN] from=${senderId}, text="${messageText.substring(0, 100)}"`);

        const handled = await executeIntent(senderId, messageText);
        if (handled) {
          console.log(`[INTENT] Handled for ${senderId}`);
          continue;
        }

        if (!conversations.has(senderId)) {
          conversations.set(senderId, [
            { role: 'system', content: SYSTEM_PROMPT },
          ]);
        }

        const history = conversations.get(senderId);
        history.push({ role: 'user', content: messageText });

        if (history.length > 11) {
          history.splice(1, history.length - 11);
        }

        console.log(`[OR REQ] sender=${senderId}, history_length=${history.length}`);

        const reply = await openRouterChat(history);

        console.log(`[MSG OUT] to=${senderId}, reply="${reply.substring(0, 100)}"`);

        history.push({ role: 'assistant', content: reply });
        await sendMessage(senderId, reply);
      }
    }
  } catch (err) {
    console.error('[WEBHOOK ERROR] ============');
    console.error('Message:', err.message);
    console.error('Stack:', err.stack?.substring(0, 500));
    console.error('[WEBHOOK ERROR END] ========');
  }
});

app.get('/test', async (req, res) => {
  const text = (req.query.msg || '').trim();
  if (!text) {
    return res.json({ error: 'Missing msg parameter. Usage: GET /test?msg=shirt+er+pic+dao' });
  }

  const result = { input: text };
  const intent = detectIntent(text);

  if (intent.action === 'ai') {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ];
    result.intent = 'ai_fallback';
    result.reply = await openRouterChat(messages);
    result.note = 'AI reply (no Messenger API calls were made)';
  } else {
    result.intent = intent.intent;
    result.action = intent.action;
    result.product = intent.product || null;
    result.reply = intent.reply;
    result.sentImage = intent.action === 'image' || intent.action === 'size_chart';
    result.note = 'Handled by intent router (no Messenger API calls were made)';
  }

  res.json(result);
});

app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (!RAW_VERIFY_TOKEN) console.error('WARNING: VERIFY_TOKEN is NOT set in environment variables');
  if (!PAGE_ACCESS_TOKEN) console.error('WARNING: PAGE_ACCESS_TOKEN is not set');
  if (!OPENROUTER_API_KEY) console.error('WARNING: OPENROUTER_API_KEY is not set');
});
