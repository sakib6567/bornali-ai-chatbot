require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const RAW_VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const VERIFY_TOKEN = RAW_VERIFY_TOKEN ? RAW_VERIFY_TOKEN.trim() : null;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL;

const conversations = new Map();

const MODEL_FALLBACKS = [
  'qwen/qwen-2.5-7b-instruct:free',
  'mistralai/mistral-small-24b-instruct-2501:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat:free',
];

const SYSTEM_PROMPT = `You are a friendly Facebook shop assistant for Bornali. Your job is to help customers place orders conversationally.

Collect the following details from the customer naturally:
- Product name
- Size
- Color
- Phone number
- Delivery address

Keep replies short, friendly, and natural. Support both Bangla and English. Do not be overly verbose. Ask for missing details one at a time. When all details are collected, confirm the order with the customer.`;

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

app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (!RAW_VERIFY_TOKEN) console.error('WARNING: VERIFY_TOKEN is NOT set in environment variables');
  if (!PAGE_ACCESS_TOKEN) console.error('WARNING: PAGE_ACCESS_TOKEN is not set');
  if (!OPENROUTER_API_KEY) console.error('WARNING: OPENROUTER_API_KEY is not set');
});
