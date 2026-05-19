require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL;

const conversations = new Map();

const MODEL_FALLBACKS = [
  'qwen/qwen3-32b:free',
  'mistralai/mistral-7b-instruct:free',
  'meta-llama/llama-3.1-8b-instruct:free',
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
    await axios.post(
      'https://graph.facebook.com/v18.0/me/messages',
      {
        recipient: { id: senderId },
        message: { text },
      },
      { params: { access_token: PAGE_ACCESS_TOKEN } },
    );
    console.log(`Replied to ${senderId}: ${text.substring(0, 60)}`);
  } catch (err) {
    console.error('sendMessage error:', err.response?.data || err.message);
  }
}

async function openRouterChat(messages) {
  const models = MODEL ? [MODEL, ...MODEL_FALLBACKS] : MODEL_FALLBACKS;

  for (const model of models) {
    try {
      console.log(`Trying model: ${model}`);
      const res = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model, messages, max_tokens: 300 },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/sakib6567/bornali-ai-chatbot',
          },
        },
      );
      return res.data.choices[0].message.content;
    } catch (err) {
      console.error(`Model ${model} failed:`, err.response?.status, err.message);
    }
  }

  return 'Sorry, I am having trouble responding right now. Please try again later.';
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('Webhook verification failed');
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        if (!event.message) continue;

        const senderId = event.sender?.id;
        const messageText = event.message?.text;

        if (!messageText) continue;
        if (event.message.is_echo) continue;

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

        const reply = await openRouterChat(history);

        history.push({ role: 'assistant', content: reply });
        await sendMessage(senderId, reply);
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
