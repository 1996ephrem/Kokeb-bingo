// server.js
require('dotenv').config();

process.on('unhandledRejection', (reason) => {
  console.error('[-] Unhandled Rejection Caught:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[-] Uncaught Exception Caught:', err);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const DB = require('./database');
const { generateCartela, validateBingo } = require('./gameEngine');
const { verifyTelegramAuth } = require('./telegramAuth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());

// 🚫 አሳሾችና ቴሌግራም ገጹን በሜሞሪ አስቀምጠው እንዳያስቀሩ ጥብቅ የ No-Cache ትዕዛዝ
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// 📦 ብሮድካስት ላይ ምስል (base64) ስለሚላክ ለዚያ መንገድ ብቻ ትልቅ ገደብ (ሌሎቹ በነባሩ ገደብ ይቀጥላሉ)
const jsonSmall = express.json();
const jsonLarge = express.json({ limit: '8mb' });
app.use((req, res, next) => {
  if (req.path === '/api/admin/broadcast' && req.headers['x-admin-pin']) {
    return jsonLarge(req, res, next);
  }
  return jsonSmall(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false
}));

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

let detectedBotUsername = process.env.BOT_USERNAME || 'Kokeb_Bingo_Bot';
let globalCommissionPercent = parseInt(process.env.HOUSE_COMMISSION_PERCENT, 10) || 15;

// 💳 የክፍያ መረጃ እና የቦነስ ቅንብር (ከ DB ይጫናል፤ አድሚን ፓነል ላይ ይቀየራል)
let paymentInfo = { phone: '0972723976', name: 'NESREDINE' };
let bonusSettings = { enabled: true, percent: 100, max: 200, minDeposit: 50, wagerMultiplier: 3, firstOnly: true };

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadLiveSettings() {
  await DB.ready;
  paymentInfo = await DB.getPaymentSettings();
  bonusSettings = await DB.getBonusSettings();
}

const failedPinAttempts = new Map();
const activeSockets = new Map();

function getAppBaseUrl() {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  }
  return 'https://kokeb-bingo.onrender.com';
}

function getBotMainMenu(webAppUrl) {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '🎮 ይጫወቱ', web_app: { url: webAppUrl } }],
        [{ text: '💰 ሂሳብ' }, { text: '📥 ገቢ ለማድረግ' }],
        [{ text: '📤 ወጪ ለማድረግ' }, { text: '🔗 ጋብዝ & አግኝ' }],
        [{ text: '🏆 ሳምንታዊ ውድድር' }],
        [{ text: '🆘 እርዳታ' }, { text: '📜 ደንቦች' }]
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  };
}

// ==================== TELEGRAM BOT SETUP ====================
let bot = null;

if (process.env.BOT_TOKEN) {
  bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

  bot.on('polling_error', (err) => {
    if (!err.message || !err.message.includes('409 Conflict')) {
      console.warn('Telegram Polling Notice:', err.message);
    }
  });

  bot.on('error', (err) => {
    console.warn('Telegram Bot Notice:', err.message);
  });

  bot.getMe().then((botInfo) => {
    detectedBotUsername = botInfo.username;
    console.log(`[+] Telegram Bot Active: @${detectedBotUsername}`);

    bot.setMyCommands([
      { command: 'play', description: '🎮 አሁኑኑ ተጫወት (Play Now)' },
      { command: 'balance', description: '💰 ቀሪ ሒሳብ መፈተሻ' },
      { command: 'deposit', description: '📥 ብር ማስገቢያ መመሪያ' },
      { command: 'withdraw', description: '📤 ብር ማውጫ መመሪያ' },
      { command: 'invite', description: '🎁 ጓደኛ መጋበዣ ሊንክ' },
      { command: 'help', description: 'ℹ️ የአጨዋወት መመሪያ' }
    ]).catch(() => {});

  }).catch((err) => console.error('Telegram bot init error:', err.message));

  bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();
    const firstName = msg.from.first_name || 'Player';
    const username = msg.from.username ? `@${msg.from.username}` : firstName;

    let referrerRef = null;
    const startParam = (match && match[1]) ? match[1].trim() : '';
    if (startParam.startsWith('ref_')) {
      const rawRef = startParam.replace('ref_', '').trim();
      if (rawRef && rawRef !== telegramId) {
        referrerRef = rawRef;
      }
    }

    try {
      const user = await DB.getOrCreateUser(telegramId, username, firstName, referrerRef);

      if (user.is_banned === 1) {
        return bot.sendMessage(chatId, '❌ ይቅርታ! አካውንትዎ ታግዷል፤ ወደ ጨዋታው መግባት አይችሉም።').catch(() => {});
      }

      if (referrerRef && !user.phone_number) {
        bot.sendMessage(
          referrerRef,
          `👋 አንድ ጓደኛዎ (${firstName}) በእርስዎ ሊንክ ገብቷል!`
        ).catch(() => {});
      }

      if (!user.phone_number) {
        return bot.sendMessage(
          chatId,
          `🎯 Welcome to Kokeb Bingo 🌟!\n\nየ 15 ETB የመጫወቻ ቦነስዎን (Play-Only Bonus) ለመቀበል እና ጨዋታውን ለመጀመር እባክዎ ከታች ያለውን ሰማያዊ '📲 ስልክ ቁጥር አረጋግጥ' የሚለውን በተን ይጫኑ።`,
          {
            reply_markup: {
              keyboard: [[{ text: '📲 ስልክ ቁጥር አረጋግጥ (Share Phone Number)', request_contact: true }]],
              resize_keyboard: true,
              one_time_keyboard: true
            }
          }
        ).catch(() => {});
      }

      const webAppUrl = `${getAppBaseUrl()}/?v=${Date.now()}`;
      bot.sendMessage(
        chatId,
        `🎯 <b>እንኳን ደህና መጡ ወደ ኮከብ ቢንጎ ${firstName}!</b>\n\nለመጫወት ከታች ያለውን <b>'🎮 ይጫወቱ'</b> በተን ይጫኑ ወይም ሒሳብዎን ለመቆጣጠር አማራጮቹን ይጠቀሙ!`,
        { parse_mode: 'HTML', ...getBotMainMenu(webAppUrl) }
      ).catch(() => {});
    } catch (e) {
      console.error('Bot start error:', e.message);
    }
  });

  bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();
    const contact = msg.contact;

    if (contact.user_id !== msg.from.id) {
      return bot.sendMessage(chatId, '❌ እባክዎን የእራስዎን ስልክ ቁጥር ብቻ ያጋሩ!').catch(() => {});
    }

    let phone = contact.phone_number;
    if (!phone.startsWith('+')) phone = '+' + phone;

    const firstName = msg.from.first_name || 'Player';
    const username = msg.from.username ? `@${msg.from.username}` : firstName;

    try {
      const regResult = await DB.registerVerifiedPhone(telegramId, username, firstName, phone);
      const webAppUrl = `${getAppBaseUrl()}/?v=${Date.now()}`;

      if (regResult.isNewBonus) {
        bot.sendMessage(
          chatId,
          `🎉 <b>እንኳን ደስ አለዎት ምዝገባዎ ተጠናቋል!</b>\n\n` +
          `✅ ስልክ ቁጥርዎ ተረጋግጧል (${phone})\n` +
          `🎁 የ <b>15 ETB</b> የመጫወቻ ቦነስ (Play-Only) ወደ አካውንትዎ ገቢ ሆኗል!\n\n` +
          `ለመጫወት ከታች ያለውን '🎮 ይጫወቱ' የሚለውን በተን ይጫኑ!`,
          { parse_mode: 'HTML', ...getBotMainMenu(webAppUrl) }
        ).catch(() => {});

        for (const [sockId, pInfo] of activeSockets.entries()) {
          if (pInfo.telegramId === telegramId || pInfo.dbId === regResult.user.id) {
            pInfo.balance = regResult.user.balance;
            io.to(sockId).emit('balance_updated', {
              balance: regResult.user.balance,
              cashableBalance: 0.00,
              playOnlyBalance: regResult.user.balance
            });
          }
        }
      } else {
        bot.sendMessage(
          chatId,
          `ℹ️ ይህ ስልክ ቁጥር (${phone}) አስቀድሞ የተመዘገበ ነው!\n\n💰 ቀሪ ሒሳብዎ: ${regResult.user.balance} ETB`,
          { parse_mode: 'HTML', ...getBotMainMenu(webAppUrl) }
        ).catch(() => {});
      }
    } catch (err) {
      if (err.message === 'DUPLICATE_PHONE_OTHER_ACCOUNT') {
        bot.sendMessage(chatId, `❌ ይቅርታ! ይህ ስልክ ቁጥር ቀድሞ በሌላ የቴሌግራም አካውንት ተመዝግቧል!`).catch(() => {});
      }
    }
  });

  bot.onText(/\/play/, (msg) => {
    const webAppUrl = `${getAppBaseUrl()}/?v=${Date.now()}`;
    bot.sendMessage(msg.chat.id, "🎮 ለመጫወት ከታች ያለውን ይጫኑ!", {
      reply_markup: {
        inline_keyboard: [[{ text: '🎮 አሁኑኑ ተጫወት (Play Now)', web_app: { url: webAppUrl } }]]
      }
    }).catch(() => {});
  });

  bot.onText(/\/balance/, async (msg) => {
    try {
      const user = await DB.getUserByTelegramId(msg.from.id);
      if (!user) return;
      const prof = await DB.getUserDetailedProfile(user.id);
      const webAppUrl = `${getAppBaseUrl()}/?v=${Date.now()}`;
      const reply = 
        `💼 <b>የኔ ሂሳብ (Wallet)</b>\n\n` +
        `💵 <b>መጫወቻ ሂሳብ: ETB  ${prof.playOnlyBalance.toFixed(2)}</b>\n` +
        `(የጀማሪ ቦነስና ለመጫወቻ ብቻ የሚጠቅም ሂሳብ | ወጪ የማይሆን!)\n\n` +
        `🏆 <b>ዋና ሂሳብ: ETB  ${prof.cashableBalance.toFixed(2)}</b>\n` +
        `(ያሸነፉት ወጪ የሚሆን! | በተጨማሪም ለመጫወቻ የሚጠቅም ሂሳብ)\n\n` +
        `💰 <b>ጠቅላላ ሂሳብ: ETB  ${user.balance.toFixed(2)}</b>`;
      bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML', ...getBotMainMenu(webAppUrl) }).catch(() => {});
    } catch (e) {}
  });

  // 📥 ዲፖዚት መረጃ - ቴሌብር 0972723976 NESREDINE
  bot.onText(/\/deposit/, (msg) => {
    const webAppUrl = `${getAppBaseUrl()}/?v=${Date.now()}`;
    const reply = 
      `📥 <b>ገቢ ለማድረግ (Deposit)</b>\n\n` +
      `🟢 <b>ቴሌብር (Telebirr):</b> <code>${escapeHtml(paymentInfo.phone)}</code> (${escapeHtml(paymentInfo.name)})\n\n` +
      `📌 <b>ዝቅተኛው የማስገቢያ መጠን:</b> 50 ETB\n\n` +
      `<b>አሞላሉ፦</b>\n` +
      `1. በቴሌብር ብር ይላኩ\n` +
      `2. የደረሶትን የትራንዛክሽን መለያ ቁጥር (Txn ID) ይቅዱ\n` +
      `3. ከታች <b>'🎮 ይጫወቱ'</b> ተጭነው Wallet ውስጥ የትራንዛክሽን ቁጥሩን ያስገቡ!`;
    bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML', ...getBotMainMenu(webAppUrl) }).catch(() => {});
  });

  bot.onText(/\/withdraw/, (msg) => {
    const webAppUrl = `${getAppBaseUrl()}/?v=${Date.now()}`;
    const reply = 
      `📤 <b>ወጪ ለማድረግ (Withdraw)</b>\n\n` +
      `📌 <b>ዝቅተኛው የማውጫ መጠን:</b> 225 ETB\n` +
      `📌 <b>ቀሪ ተቀማጭ:</b> ቢያንስ 25 ETB መኖር አለበት\n` +
      `📌 ብር ለማውጣት መጀመሪያ ቢያንስ አንድ ጊዜ 50 ETB ማስገባት ግዴታ ነው!\n\n` +
      `ያሸነፉትን ገንዘብ ለማውጣት ከታች <b>'🎮 ይጫወቱ'</b> ተጭነው Wallet ውስጥ የቴሌብር ስልክዎን ያስገቡ!`;
    bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML', ...getBotMainMenu(webAppUrl) }).catch(() => {});
  });

  bot.onText(/\/invite/, (msg) => {
    const refLink = `https://t.me/${detectedBotUsername}?start=ref_${msg.from.id}`;
    const reply = 
      `🔗 <b>ጓደኛዎን ይጋብዙ እና ያሸንፉ!</b>\n\n` +
      `የእርስዎ መጋበዣ ሊንክ፦\n<code>${refLink}</code>\n\n` +
      `🏆 <b>ሳምንታዊ የግብዣ ውድድር፦</b>\n` +
      `በየሳምንቱ ብዙ ሰው በመጋበዝ ከ 1ኛ - 3ኛ ይውጡ፤ እስከ 500+ ETB የገንዘብ ሽልማት ያሸንፉ!`;
    bot.sendMessage(msg.chat.id, reply, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📲 ሊንኩን ለጓደኞችህ አጋራ (Share Link)', url: `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('🎮 ና የኮከብ ቢንጎ አብረን እንጫወት!')}` }]
        ]
      }
    }).catch(() => {});
  });

  bot.onText(/\/help/, (msg) => {
    const webAppUrl = `${getAppBaseUrl()}/?v=${Date.now()}`;
    const reply = 
      `📖 <b>የኮከብ ቢንጎ አጨዋወት መመሪያ:</b>\n\n` +
      `1. በቴሌብር ሒሳብዎን ይሙሉ (Min: 50 ETB)\n` +
      `2. ካርቴላ ይቁረጡ (ከ 1 እስከ 400 ባሉት ካርቴላዎች)\n` +
      `3. ኳሶችን ይከታተሉ (Auto-daub ማብራት ይመረጣል)\n` +
      `4. መስመር ሲሞላ ሲስተሙ በራሱ አውቶማቲክ አሸናፊ ያደርግዎታል!`;
    bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML', ...getBotMainMenu(webAppUrl) }).catch(() => {});
  });

  // 🤖 ከስር ያሉትን በተኖች ሲነኩ የሚሰጠው ምላሽ
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();
    const text = msg.text.trim();
    const webAppUrl = `${getAppBaseUrl()}/?v=${Date.now()}`;

    try {
      const user = await DB.getUserByTelegramId(telegramId);
      if (!user) return;

      if (text === '💰 ሂሳብ' || text.includes('ሂሳብ')) {
        const prof = await DB.getUserDetailedProfile(user.id);
        const reply = 
          `💼 <b>የኔ ሂሳብ (Wallet)</b>\n\n` +
          `💵 <b>መጫወቻ ሂሳብ: ETB  ${prof.playOnlyBalance.toFixed(2)}</b>\n` +
          `(የጀማሪ ቦነስና ለመጫወቻ ብቻ የሚጠቅም ሂሳብ | ወጪ የማይሆን!)\n\n` +
          `🏆 <b>ዋና ሂሳብ: ETB  ${prof.cashableBalance.toFixed(2)}</b>\n` +
          `(ያሸነፉት ወጪ የሚሆን! | በተጨማሪም ለመጫወቻ የሚጠቅም ሂሳብ)\n\n` +
          `💰 <b>ጠቅላላ ሂሳብ: ETB  ${user.balance.toFixed(2)}</b>`;
        return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', ...getBotMainMenu(webAppUrl) });
      }

      if (text === '📥 ገቢ ለማድረግ') {
        const reply = 
          `📥 <b>ገቢ ለማድረግ (Deposit)</b>\n\n` +
          `🟢 <b>ቴሌብር (Telebirr):</b> <code>${escapeHtml(paymentInfo.phone)}</code> (${escapeHtml(paymentInfo.name)})\n\n` +
          `📌 <b>ዝቅተኛው የማስገቢያ መጠን:</b> 50 ETB\n\n` +
          `<b>አሞላሉ፦</b>\n` +
          `1. በቴሌብር ብር ይላኩ\n` +
          `2. የደረሶትን የትራንዛክሽን መለያ ቁጥር (Txn ID) ይቅዱ\n` +
          `3. ከታች <b>'🎮 ይጫወቱ'</b> ተጭነው Wallet ውስጥ የትራንዛክሽን ቁጥሩን ያስገቡ!`;
        return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', ...getBotMainMenu(webAppUrl) });
      }

      if (text === '📤 ወጪ ለማድረግ') {
        const reply = 
          `📤 <b>ወጪ ለማድረግ (Withdraw)</b>\n\n` +
          `📌 <b>ዝቅተኛው የማውጫ መጠን:</b> 225 ETB\n` +
          `📌 <b>ቀሪ ተቀማጭ:</b> ቢያንስ 25 ETB መኖር አለበት\n` +
          `📌 ብር ለማውጣት መጀመሪያ ቢያንስ አንድ ጊዜ 50 ETB ማስገባት ግዴታ ነው!\n\n` +
          `ያሸነፉትን ገንዘብ ለማውጣት ከታች <b>'🎮 ይጫወቱ'</b> ተጭነው Wallet ውስጥ የቴሌብር ስልክዎን ያስገቡ!`;
        return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', ...getBotMainMenu(webAppUrl) });
      }

      if (text === '🔗 ጋብዝ & አግኝ') {
        const refLink = `https://t.me/${detectedBotUsername}?start=ref_${telegramId}`;
        const reply = 
          `🔗 <b>ጓደኛዎን ይጋብዙ እና ያሸንፉ!</b>\n\n` +
          `የእርስዎ መጋበዣ ሊንክ፦\n<code>${refLink}</code>\n\n` +
          `🏆 <b>ሳምንታዊ የግብዣ ውድድር፦</b>\n` +
          `በየሳምንቱ ብዙ ሰው በመጋበዝ ከ 1ኛ - 3ኛ ይውጡ፤ እስከ 500+ ETB የገንዘብ ሽልማት ያሸንፉ!`;
        return bot.sendMessage(chatId, reply, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📲 ሊንኩን ለጓደኞችህ አጋራ (Share Link)', url: `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('🎮 ና የኮከብ ቢንጎ አብረን እንጫወት!')}` }]
            ]
          }
        });
      }

      if (text === '🏆 ሳምንታዊ ውድድር') {
        const contest = await DB.getWeeklyReferralLeaderboard();
        const reply = 
          `🏆 <b>ሳምንታዊ የግብዣ ውድድር</b>\n\n` +
          `🎁 <b>የዚህ ሳምንት ሽልማቶች፦</b>\n` +
          `🥇 1ኛ ደረጃ: <b>${contest.prizes.prize1} ETB</b>\n` +
          `🥈 2ኛ ደረጃ: <b>${contest.prizes.prize2} ETB</b>\n` +
          `🥉 3ኛ ደረጃ: <b>${contest.prizes.prize3} ETB</b>\n\n` +
          `ብዙ ሰው በመጋበዝ 1ኛ፣ 2ኛ ወይም 3ኛ ይውጡ፤ ሳምንቱ ሲጠናቀቅ ብሩ በቀጥታ ወደ ዋሌትዎ ገቢ ይደረጋል!`;
        return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', ...getBotMainMenu(webAppUrl) });
      }

      if (text === '🆘 እርዳታ' || text === '📜 ደንቦች') {
        const reply = 
          `📖 <b>የኮከብ ቢንጎ አጨዋወት መመሪያ:</b>\n\n` +
          `1. በቴሌብር ሒሳብዎን ይሙሉ (Min: 50 ETB)\n` +
          `2. ካርቴላ ይቁረጡ (ከ 1 እስከ 400 ባሉት ካርቴላዎች)\n` +
          `3. ኳሶችን ይከታተሉ (Auto-daub ማብራት ይመረጣል)\n` +
          `4. መስመር ሲሞላ ሲስተሙ በራሱ አውቶማቲክ አሸናፊ ያደርግዎታል!`;
        return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', ...getBotMainMenu(webAppUrl) });
      }

    } catch (e) {}
  });

  bot.on('callback_query', async (query) => {
    const data = query.data || '';
    const telegramId = query.from.id.toString();

    if (data.startsWith('claim_rain_')) {
      const rainId = parseInt(data.replace('claim_rain_', ''), 10);

      try {
        const user = await DB.getUserByTelegramId(telegramId);
        if (!user) {
          return bot.answerCallbackQuery(query.id, {
            text: '⚠️ እባክዎ መጀመሪያ ቦቱ ላይ /start ብለው ይመዝገቡ!',
            show_alert: true
          });
        }

        const result = await DB.claimMoneyRain(user.id, rainId);
        const prof = await DB.getUserDetailedProfile(user.id);

        for (const [sockId, pInfo] of activeSockets.entries()) {
          if (pInfo.dbId === user.id) {
            pInfo.balance = result.newBalance;
            io.to(sockId).emit('balance_updated', {
              balance: result.newBalance,
              cashableBalance: prof.cashableBalance,
              playOnlyBalance: prof.playOnlyBalance
            });
          }
        }

        return bot.answerCallbackQuery(query.id, {
          text: `🎉 እንኳን ደስ አለዎት! የ ${result.rewardAmount} ETB የዝናብ ቦነስ ተቀብለዋል! አጠቃላይ ባላንስዎ: ${result.newBalance} ETB`,
          show_alert: true
        });

      } catch (err) {
        let msg = '❌ ቦነሱን መውሰድ አልተቻለም!';
        if (err.message === 'ALREADY_CLAIMED') {
          msg = '⚠️ አስቀድመው ወስደዋል! አንድ ሰው ከአንድ ጊዜ በላይ መውሰድ አይችልም።';
        } else if (err.message === 'RAIN_FULL') {
          msg = '❌ ይቅርታ! የዚህ ዝናብ ቦነስ ሙሉ በሙሉ አልቋል!';
        } else if (err.message === 'RAIN_CLOSED') {
          msg = '⏳ ይህ የገንዘብ ዝናብ በአድሚን ተዘግቷል!';
        }

        return bot.answerCallbackQuery(query.id, {
          text: msg,
          show_alert: true
        });
      }
    }
  });
}

function sendTelegramNotification(telegramId, message, withPlayButton = false) {
  if (!bot || !telegramId || String(telegramId).startsWith('demo_')) return;
  try {
    const options = { parse_mode: 'HTML' };
    if (withPlayButton) {
      const webAppUrl = `${getAppBaseUrl()}/?v=${Date.now()}`;
      options.reply_markup = {
        inline_keyboard: [[{ text: '🎮 አሁኑኑ ተጫወት (Play Now)', web_app: { url: webAppUrl } }]]
      };
    }
    bot.sendMessage(telegramId, message, options).catch((err) => {
      console.warn(`[!] Telegram notification failed to ${telegramId}:`, err.message);
    });
  } catch (e) {
    console.warn('[!] Notification error:', e.message);
  }
}

// ==================== BINGO ROOMS ENGINE (400 CARTELAS) ====================
function createRoomState(name, stake, callSpeed) {
  return {
    name,
    stake,
    callSpeed,
    state: 'LOBBY',
    timer: 30,
    timerInterval: null,
    gameInterval: null,
    cartelas: {},
    takenCartelas: new Map(),
    notifiedSoon: false,
    notifiedTelegram: false,
    calledNumbers: new Set(),
    uncalledNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
    drawnCount: 0,
    isPaused: false,
    winnerDeclared: false
  };
}

const rooms = {
  Beginner: createRoomState('Beginner', 10, 2500),
  Turbo: createRoomState('Turbo', 25, 1400),
  VIP: createRoomState('VIP', 100, 2500)
};

// ⚡ ካርቴላው የሚፈጠረው ተጫዋቹ ሲገዛው ብቻ ነው (400 ካርዶችን ለሁሉም አንልክም)
function getRoomCard(room, id) {
  if (!room.cartelas[id]) room.cartelas[id] = generateCartela();
  return room.cartelas[id];
}

function broadcastRealRoomsStatus() {
  const status = {};
  for (const [key, r] of Object.entries(rooms)) {
    status[key] = {
      stake: r.stake,
      playing: io.sockets.adapter.rooms.get(key)?.size || 0,
      cardsSold: r.takenCartelas.size,
      prize: Math.floor(r.takenCartelas.size * r.stake * ((100 - globalCommissionPercent) / 100)),
      state: r.state,
      timer: r.timer,
      calledCount: r.drawnCount
    };
  }
  io.emit('all_rooms_update', status);
}

// ==================== 🔔 LOBBY START NOTIFICATIONS ====================
const lobbyNotifyCooldown = new Map(); // userId -> last Telegram push time
const LOBBY_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
let lobbyTargetsCache = { at: 0, rows: [] };

function lobbySnapshot(roomName) {
  const room = rooms[roomName];
  const players = new Set(Array.from(room.takenCartelas.values()).map(c => c.dbId)).size;
  return {
    roomName,
    stake: room.stake,
    cardsSold: room.takenCartelas.size,
    players,
    needPlayers: Math.max(0, 3 - players),
    prize: Math.floor(room.takenCartelas.size * room.stake * ((100 - globalCommissionPercent) / 100))
  };
}

// በመተግበሪያው ውስጥ ላሉ ሁሉም ተጫዋቾች (ባንዲራ/ባነር)
function notifyLobbyInApp(roomName) {
  const room = rooms[roomName];
  if (!room || room.state !== 'LOBBY') return;
  io.emit('lobby_starting_soon', { ...lobbySnapshot(roomName), seconds: room.timer });
}

// መተግበሪያውን ለዘጉ (opt-in ለገቡ) ተጫዋቾች በቴሌግራም
async function notifyLobbyTelegram(roomName) {
  const room = rooms[roomName];
  if (!room || !bot) return;
  try {
    if (Date.now() - lobbyTargetsCache.at > 60000) {
      lobbyTargetsCache = { at: Date.now(), rows: await DB.getLobbyNotifyTargets() };
    }
    const snap = lobbySnapshot(roomName);
    const inRoom = new Set(Array.from(room.takenCartelas.values()).map(c => c.dbId));
    const online = new Set(Array.from(activeSockets.values()).map(p => p.dbId));
    const now = Date.now();

    const targets = lobbyTargetsCache.rows
      .filter(t => !inRoom.has(t.id) && !online.has(t.id) && now - (lobbyNotifyCooldown.get(t.id) || 0) > LOBBY_NOTIFY_COOLDOWN_MS)
      .slice(0, 500);

    const msg =
      `🔔 <b>${escapeHtml(roomName)} ክፍል ጨዋታ ሊጀምር ነው!</b>\n` +
      `🎟️ ${snap.cardsSold} ካርዶች ተሸጠዋል | 🏆 ሽልማት: ${snap.prize} ETB\n` +
      `💰 የካርድ ዋጋ: ${snap.stake} ETB\n` +
      (snap.needPlayers > 0 ? `👥 ለመጀመር ${snap.needPlayers} ተጫዋች ይፈለጋል!\n` : '') +
      `\nአሁኑኑ ይግቡ 👇`;

    targets.forEach((t, idx) => {
      lobbyNotifyCooldown.set(t.id, now);
      setTimeout(() => sendTelegramNotification(t.telegram_id, msg, true), idx * 60);
    });
  } catch (err) {
    console.warn('[!] Lobby Telegram notify failed:', err.message);
  }
}

function startRoomLobby(roomName) {
  const room = rooms[roomName];
  if (!room || room.isPaused) return;

  room.state = 'LOBBY';
  room.winnerDeclared = false;
  room.timer = 30;
  room.calledNumbers.clear();
  room.uncalledNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
  room.drawnCount = 0;
  room.takenCartelas.clear();
  room.cartelas = {};
  room.notifiedSoon = false;
  room.notifiedTelegram = false;

  io.to(roomName).emit('room_reset', {
    roomName,
    timer: room.timer,
    stake: room.stake
  });

  broadcastRealRoomsStatus();

  if (room.timerInterval) clearInterval(room.timerInterval);

  room.timerInterval = setInterval(() => {
    if (room.isPaused) return;
    room.timer--;
    io.to(roomName).emit('lobby_timer_tick', { timer: room.timer, roomName });

    if (room.takenCartelas.size > 0) {
      if (room.timer === 20 && !room.notifiedTelegram) {
        room.notifiedTelegram = true;
        notifyLobbyTelegram(roomName);
      }
      if (room.timer === 10 && !room.notifiedSoon) {
        room.notifiedSoon = true;
        notifyLobbyInApp(roomName);
      }
    }

    if (room.timer <= 0) {
      const uniquePlayerIds = new Set(Array.from(room.takenCartelas.values()).map(c => c.dbId));

      if (uniquePlayerIds.size >= 3 && room.takenCartelas.size >= 3) {
        clearInterval(room.timerInterval);
        startRoomGame(roomName);
      } else if (room.takenCartelas.size > 0) {
        room.timer = 20;
        room.notifiedSoon = false;
        io.to(roomName).emit('lobby_waiting_players', {
          message: `⏳ ጨዋታው እንዲጀምር ቢያንስ 3 ተጫዋቾች ያስፈልጋሉ! (${uniquePlayerIds.size}/3 ተጫዋቾች ገብተዋል)`,
          currentPlayers: uniquePlayerIds.size,
          minPlayers: 3,
          timer: room.timer,
          roomName
        });
        broadcastRealRoomsStatus();
      } else {
        clearInterval(room.timerInterval);
        startRoomLobby(roomName);
      }
    }
  }, 1000);
}

function startRoomGame(roomName) {
  const room = rooms[roomName];
  if (!room) return;
  room.state = 'PLAYING';
  room.winnerDeclared = false;

  const totalPot = room.takenCartelas.size * room.stake;
  const houseRake = (totalPot * globalCommissionPercent) / 100;
  const prizePool = Math.floor(totalPot - houseRake);

  io.to(roomName).emit('game_started', {
    roomName,
    prizePool,
    totalCards: room.takenCartelas.size
  });

  broadcastRealRoomsStatus();

  if (room.gameInterval) clearInterval(room.gameInterval);

  room.gameInterval = setInterval(async () => {
    if (room.isPaused || room.winnerDeclared) return;

    if (room.uncalledNumbers.length === 0 || room.state !== 'PLAYING') {
      clearInterval(room.gameInterval);
      endGame(roomName, null, 'ጨዋታው ተጠናቋል! ሁሉም 75 ኳሶች ወጥተዋል።');
      return;
    }

    const randIdx = Math.floor(Math.random() * room.uncalledNumbers.length);
    const num = room.uncalledNumbers.splice(randIdx, 1)[0];
    room.calledNumbers.add(num);
    room.drawnCount++;

    const letter = num <= 15 ? 'B' : num <= 30 ? 'I' : num <= 45 ? 'N' : num <= 60 ? 'G' : 'O';

    io.to(roomName).emit('ball_drawn', {
      number: num,
      letter,
      callString: `${letter}-${num}`,
      drawnCount: room.drawnCount
    });

    const detectedWinners = [];

    for (const [cardId, cardInfo] of room.takenCartelas.entries()) {
      const cardGrid = room.cartelas[cardId];
      if (!cardGrid) continue;

      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          if (cardGrid[r][c] === '★' || room.calledNumbers.has(cardGrid[r][c])) {
            cardInfo.markedMatrix[r][c] = true;
          }
        }
      }

      if (validateBingo(cardGrid, cardInfo.markedMatrix, room.calledNumbers)) {
        detectedWinners.push({
          dbId: cardInfo.dbId,
          username: cardInfo.username,
          cartelaId: cardId,
          socketId: cardInfo.socketId
        });
      }
    }

    if (detectedWinners.length > 0) {
      room.winnerDeclared = true;
      room.state = 'FINISHED';
      clearInterval(room.gameInterval);

      const totalWinners = detectedWinners.length;
      const eachPrize = Math.max(1, Math.floor(prizePool / totalWinners));

      detectedWinners.forEach(w => { w.prize = eachPrize; });

      let newBalances = [];
      try {
        newBalances = await DB.settleRoundWithPayouts(
          roomName,
          detectedWinners.map(w => ({ userId: w.dbId, amount: eachPrize }))
        );
      } catch (err) {
        console.error('Auto payout error:', err);
      }

      for (let i = 0; i < detectedWinners.length; i++) {
        const w = detectedWinners[i];
        try {
          const newBal = newBalances[i];
          if (newBal === undefined) continue;
          w.newBalance = newBal;

          const prof = await DB.getUserDetailedProfile(w.dbId);

          for (const [sockId, pInfo] of activeSockets.entries()) {
            if (pInfo.dbId === w.dbId) {
              pInfo.balance = newBal;
              io.to(sockId).emit('balance_updated', {
                balance: newBal,
                cashableBalance: prof.cashableBalance,
                playOnlyBalance: prof.playOnlyBalance
              });
            }
          }

          await DB.saveGameRound(roomName, w.username, w.cartelaId, eachPrize, room.takenCartelas.size, room.drawnCount);
        } catch (err) {
          console.error('Auto payout error:', err);
        }
      }

      endGame(roomName, detectedWinners, null);
    }
  }, room.callSpeed);
}

async function endGame(roomName, winnersData, fallbackMessage) {
  const room = rooms[roomName];
  if (!room) return;
  room.state = 'FINISHED';
  room.winnerDeclared = true;
  if (room.gameInterval) clearInterval(room.gameInterval);

  if (!winnersData || winnersData.length === 0) {
    try { await DB.settleRoomBets(roomName); } catch (e) { console.error('settleRoomBets error:', e.message); }
  }

  let finishMsg = fallbackMessage || 'ጨዋታው ተጠናቋል!';

  if (winnersData && winnersData.length > 0) {
    if (winnersData.length === 1) {
      const w = winnersData[0];
      finishMsg = `🎉 ቢንጎ! ${w.username} በካርቴላ #${w.cartelaId} ${w.prize} ETB አሸነፈ!`;
    } else {
      const namesList = winnersData.map(w => `${w.username} (#${w.cartelaId})`).join(', ');
      finishMsg = `🎉 ቢንጎ! ${winnersData.length} አሸናፊዎች እኩል ወጥተዋል! ደራሽ ብሩ እኩል ተከፋፍሏል፦ ${namesList} ለእያንዳንዳቸው ${winnersData[0].prize} ETB ተሸልመዋል!`;
    }
  }

  io.to(roomName).emit('game_finished', {
    winners: winnersData || [],
    winner: winnersData && winnersData.length > 0 ? winnersData[0] : null,
    message: finishMsg
  });

  broadcastRealRoomsStatus();
  setTimeout(() => { startRoomLobby(roomName); }, 6000);
}

async function notifyRefunds(refunds, message) {
  for (const r of refunds) {
    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === r.userId) {
        pInfo.balance = r.newBalance;
        try {
          const prof = await DB.getUserDetailedProfile(r.userId);
          io.to(sockId).emit('balance_updated', {
            balance: r.newBalance,
            cashableBalance: prof.cashableBalance,
            playOnlyBalance: prof.playOnlyBalance
          });
        } catch (e) {}
      }
    }
    sendTelegramNotification(r.telegramId, `${message}\n🪙 የተመለሰ: ${r.amount} ETB\n💰 ባላንስ: ${r.newBalance} ETB`, true);
  }
}

// 🛡️ ሰርቨር ሲነሳ ያልተጠናቀቁ ውርርዶችን በራስ-ሰር መልስ
async function recoverOrphanedBets() {
  await DB.ready;
  const refunds = await DB.refundActiveBets({ reason: 'Server Restart Refund' });
  if (refunds.length > 0) {
    console.log(`[+] Auto-refunded ${refunds.length} player(s) after restart`);
    await notifyRefunds(refunds, '⚠️ ሰርቨሩ ዳግም ስለተነሳ ያልተጠናቀቀው ዙር ተሰርዟል፤ ውርርድዎ ሙሉ በሙሉ ተመላሽ ሆኗል!');
  }
}

Object.keys(rooms).forEach(name => startRoomLobby(name));

// ==================== WEBSOCKET HANDLERS (STRICT AUTH & DYNAMIC INJECTION) ====================
io.on('connection', (socket) => {
  socket.on('auth_user', async ({ initData }) => {
    try {
      if (!initData || !process.env.BOT_TOKEN) {
        socket.emit('auth_error', { message: '⛔ እባክዎን በቴሌግራም ቦት (@Kokeb_Bingo_Bot) በኩል ብቻ ይግቡ!' });
        return socket.disconnect(true);
      }

      const tgUser = verifyTelegramAuth(initData, process.env.BOT_TOKEN);
      if (!tgUser) {
        socket.emit('auth_error', { message: '⛔ የተሳሳተ የቴሌግራም መለያ (Invalid Session)!' });
        return socket.disconnect(true);
      }

      const telegramId = tgUser.id.toString();
      const playerName = tgUser.username ? `@${tgUser.username}` : (tgUser.first_name + (tgUser.last_name ? ` ${tgUser.last_name}` : ''));

      const user = await DB.getOrCreateUser(telegramId, playerName, playerName);

      if (user.is_banned === 1) {
        socket.emit('account_banned', { message: '❌ የእርስዎ አካውንት በአድሚን ታግዷል!' });
        setTimeout(() => socket.disconnect(true), 500);
        return;
      }

      if (!user.phone_number) {
        socket.emit('phone_required', { message: '📲 እባክዎን መጀመሪያ ቦቱ ላይ ስልክ ቁጥርዎን ያረጋግጡ!' });
        return;
      }

      activeSockets.set(socket.id, {
        dbId: user.id,
        telegramId: user.telegram_id,
        username: user.username,
        balance: user.balance
      });

      const prof = await DB.getUserDetailedProfile(user.id);

      // 💡 እዚህ ጋር ስልክ ቁጥሩን በቅጽበት (Socket.io) ለተጫዋቾች እንልካለን
      socket.emit('auth_success', {
        id: user.id,
        telegramId: user.telegram_id,
        username: user.username,
        balance: user.balance,
        cashableBalance: prof.cashableBalance,
        playOnlyBalance: prof.playOnlyBalance,
        stats: prof.stats,
        botUsername: detectedBotUsername,
        checkinStreak: user.checkin_streak || 0,
        lastCheckinDate: user.last_checkin_date,
        wageringRemaining: prof.wageringRemaining,
        notifyLobby: !!user.notify_lobby,
        depositInfo: {
          phone: paymentInfo.phone,
          name: paymentInfo.name,
          minDeposit: 50,
          minWithdraw: 225,
          bonus: bonusSettings
        }
      });

      broadcastRealRoomsStatus();
    } catch (err) {
      socket.emit('error_message', 'Authentication failed');
    }
  });

  socket.on('set_lobby_notify', async ({ enabled }) => {
    const player = activeSockets.get(socket.id);
    if (!player) return;
    try {
      await DB.setLobbyNotify(player.dbId, !!enabled);
      socket.emit('lobby_notify_saved', { enabled: !!enabled });
    } catch (e) {
      socket.emit('error_message', 'ቅንብሩን መመዝገብ አልተቻለም!');
    }
  });

  socket.on('join_room', ({ roomName }) => {
    const room = rooms[roomName];
    if (!room) return;
    socket.join(roomName);
    broadcastRealRoomsStatus();

    const calledArr = Array.from(room.calledNumbers);
    const lastNum = calledArr.length > 0 ? calledArr[calledArr.length - 1] : null;
    let lastLetter = null;
    if (lastNum) {
      lastLetter = lastNum <= 15 ? 'B' : lastNum <= 30 ? 'I' : lastNum <= 45 ? 'N' : lastNum <= 60 ? 'G' : 'O';
    }

    socket.emit('room_snapshot', {
      roomName,
      state: room.state,
      timer: room.timer,
      stake: room.stake,
      takenCartelaIds: Array.from(room.takenCartelas.keys()),
      calledNumbers: calledArr,
      lastBall: lastNum ? { number: lastNum, letter: lastLetter, callString: `${lastLetter}-${lastNum}` } : null,
      drawnCount: room.drawnCount,
      prizePool: Math.floor(room.takenCartelas.size * room.stake * ((100 - globalCommissionPercent) / 100))
    });
  });

  socket.on('leave_room', async ({ roomName }) => {
    const player = activeSockets.get(socket.id);
    const room = rooms[roomName];

    if (room && room.state === 'LOBBY' && player) {
      let refundTotal = 0;
      for (const [cardId, cardInfo] of room.takenCartelas.entries()) {
        if (cardInfo.dbId === player.dbId) {
          room.takenCartelas.delete(cardId);
          refundTotal += room.stake;
        }
      }

      if (refundTotal > 0) {
        try {
          const refunds = await DB.refundActiveBets({ userId: player.dbId, roomName, reason: `${roomName} Lobby Leave` });
          const newBal = refunds.length > 0 ? refunds[0].newBalance : player.balance;
          player.balance = newBal;
          const prof = await DB.getUserDetailedProfile(player.dbId);

          socket.emit('balance_updated', {
            balance: newBal,
            cashableBalance: prof.cashableBalance,
            playOnlyBalance: prof.playOnlyBalance
          });

          io.to(roomName).emit('cartelas_locked', {
            takenIds: Array.from(room.takenCartelas.keys()),
            totalTaken: room.takenCartelas.size,
            prizePool: Math.floor(room.takenCartelas.size * room.stake * ((100 - globalCommissionPercent) / 100))
          });
        } catch (e) {}
      }
    }

    socket.leave(roomName);
    broadcastRealRoomsStatus();
  });

  socket.on('buy_cartelas', async ({ roomName, cartelaIds }) => {
    const player = activeSockets.get(socket.id);
    const room = rooms[roomName];
    if (!player || !room) return;

    if (room.state !== 'LOBBY') {
      return socket.emit('error_message', 'ይቅርታ! ጨዋታው ተጀምሯል፤ እባክዎ ቀጣዩን ዙር ይጠብቁ!');
    }

    if (!Array.isArray(cartelaIds) || cartelaIds.length === 0 || cartelaIds.length > 400) {
      return socket.emit('error_message', 'የተሳሳተ የካርቴላ ምርጫ ነው!');
    }
    cartelaIds = cartelaIds.map(Number);
    if (cartelaIds.some(id => !Number.isInteger(id) || id < 1 || id > 400) || new Set(cartelaIds).size !== cartelaIds.length) {
      return socket.emit('error_message', 'የተሳሳተ የካርቴላ ምርጫ ነው!');
    }

    if (cartelaIds.some(id => room.takenCartelas.has(id))) {
      return socket.emit('error_message', 'አንዱ ካርቴላ ቀድሞ በሌላ ተጫዋች ተይዟል!');
    }

    // 🔒 ክፍያው እስኪጠናቀቅ ካርቴላዎቹን ወዲያው መያዝ (ሁለት ሰው አንድ ካርድ እንዳይገዛ)
    cartelaIds.forEach(id => {
      const markedMatrix = Array.from({ length: 5 }, () => Array(5).fill(false));
      markedMatrix[2][2] = true;
      room.takenCartelas.set(id, {
        socketId: socket.id,
        dbId: player.dbId,
        username: player.username,
        markedMatrix
      });
    });

    try {
      const newBalance = await DB.placeBet(player.dbId, roomName, cartelaIds, room.stake);
      player.balance = newBalance;
      const prof = await DB.getUserDetailedProfile(player.dbId);

      const boughtCards = {};
      cartelaIds.forEach(id => { boughtCards[id] = getRoomCard(room, id); });

      const totalPot = room.takenCartelas.size * room.stake;
      const prizePool = Math.floor(totalPot * ((100 - globalCommissionPercent) / 100));

      socket.emit('cartelas_bought_success', {
        balance: newBalance,
        cashableBalance: prof.cashableBalance,
        playOnlyBalance: prof.playOnlyBalance,
        boughtIds: cartelaIds,
        cartelas: boughtCards,
        roomName,
        prizePool,
        totalCards: room.takenCartelas.size,
        timer: room.timer,
        state: room.state
      });

      io.to(roomName).emit('cartelas_locked', {
        takenIds: Array.from(room.takenCartelas.keys()),
        totalTaken: room.takenCartelas.size,
        prizePool
      });

      broadcastRealRoomsStatus();
    } catch (err) {
      cartelaIds.forEach(id => {
        const c = room.takenCartelas.get(id);
        if (c && c.socketId === socket.id) room.takenCartelas.delete(id);
      });
      socket.emit('error_message', err.message || 'ግዢው አልተሳካም');
    }
  });

  socket.on('mark_cell', ({ roomName, cartelaId, r, c, state }) => {
    const room = rooms[roomName];
    if (!room || !room.takenCartelas.has(cartelaId)) return;
    const card = room.takenCartelas.get(cartelaId);
    if (card.socketId === socket.id) {
      card.markedMatrix[r][c] = state;
    }
  });

  socket.on('claim_bingo', async ({ roomName, cartelaId }) => {
    const player = activeSockets.get(socket.id);
    const room = rooms[roomName];

    if (!player || !room || room.state !== 'PLAYING' || room.winnerDeclared) {
      return socket.emit('error_message', 'ይህ ዙር አስቀድሞ ተጠናቋል!');
    }

    const cardInfo = room.takenCartelas.get(cartelaId);
    if (!cardInfo || cardInfo.socketId !== socket.id) {
      return socket.emit('error_message', 'የተሳሳተ ካርቴላ ጥሪ ነው!');
    }

    const cardGrid = room.cartelas[cartelaId];
    if (!cardGrid) return socket.emit('error_message', 'የተሳሳተ ካርቴላ ጥሪ ነው!');
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        if (cardGrid[r][c] === '★' || room.calledNumbers.has(cardGrid[r][c])) {
          cardInfo.markedMatrix[r][c] = true;
        }
      }
    }

    if (validateBingo(cardGrid, cardInfo.markedMatrix, room.calledNumbers)) {
      room.winnerDeclared = true;
      room.state = 'FINISHED';
      if (room.gameInterval) clearInterval(room.gameInterval);

      const totalPot = room.takenCartelas.size * room.stake;
      const houseRake = (totalPot * globalCommissionPercent) / 100;
      const prize = Math.floor(totalPot - houseRake);

      try {
        const updatedBalance = await DB.updateBalance(player.dbId, prize, 'WIN', roomName);
        player.balance = updatedBalance;
        const prof = await DB.getUserDetailedProfile(player.dbId);

        socket.emit('balance_updated', {
          balance: updatedBalance,
          cashableBalance: prof.cashableBalance,
          playOnlyBalance: prof.playOnlyBalance
        });

        endGame(
          roomName,
          [{ username: player.username, cartelaId, prize, dbId: player.dbId }],
          null
        );
      } catch (dbErr) {
        console.error('Win payout error:', dbErr);
      }
    } else {
      socket.emit('error_message', 'ቢንጎ አልተሟላም! እባክዎን መስመሩን ያረጋግጡ።');
    }
  });

  socket.on('disconnect', () => {
    activeSockets.delete(socket.id);
    broadcastRealRoomsStatus();
  });
});

// ==================== REST APIS ====================
app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaders = await DB.getRealLeaderboard();
    res.json({ success: true, leaders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/user/profile', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });
  try {
    const prof = await DB.getUserDetailedProfile(userId);
    res.json({ success: true, ...prof });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/referral-contest/leaderboard', async (req, res) => {
  try {
    const data = await DB.getWeeklyReferralLeaderboard();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/checkin/claim', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'User ID required' });

  try {
    const result = await DB.claimDailyCheckinStreak(userId);
    const prof = await DB.getUserDetailedProfile(userId);

    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === userId) {
        pInfo.balance = result.newBalance;
        io.to(sockId).emit('balance_updated', {
          balance: result.newBalance,
          cashableBalance: prof.cashableBalance,
          playOnlyBalance: prof.playOnlyBalance
        });
      }
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/promo/claim', async (req, res) => {
  const { userId, code } = req.body;
  if (!userId || !code) return res.status(400).json({ error: 'እባክዎን ፕሮሞኮዱን ያስገቡ!' });

  try {
    const result = await DB.claimPromoCode(parseInt(userId, 10), code);
    const prof = await DB.getUserDetailedProfile(userId);

    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === parseInt(userId, 10)) {
        pInfo.balance = result.newBalance;
        io.to(sockId).emit('balance_updated', {
          balance: result.newBalance,
          cashableBalance: prof.cashableBalance,
          playOnlyBalance: prof.playOnlyBalance
        });
      }
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 📥 ዝቅተኛው ማስገቢያ 50 ETB
app.post('/api/payment/deposit-request', async (req, res) => {
  const { userId, amount, phoneNumber, txRef } = req.body;
  const depositAmount = parseFloat(amount);

  if (!depositAmount || isNaN(depositAmount) || depositAmount < 50) {
    return res.status(400).json({ error: 'ዝቅተኛው የማስገቢያ መጠን 50 ETB ነው!' });
  }
  if (!phoneNumber || phoneNumber.length < 9) {
    return res.status(400).json({ error: 'እባክዎን የላኩበትን ትክክለኛ ስልክ ቁጥር ያስገቡ!' });
  }
  if (!txRef || txRef.trim().length < 4) {
    return res.status(400).json({ error: 'እባክዎን ከቴሌብር የደረሶትን የትራንዛክሽን ቁጥር (Txn ID) ያስገቡ!' });
  }

  try {
    const result = await DB.requestDeposit(userId, depositAmount, phoneNumber, txRef.trim(), 'TELEBIRR');

    const userMsg = 
      `⏳ የማስገቢያ ጥያቄዎ ደርሶናል!\n\n` +
      `💰 መጠን: ${depositAmount} ETB\n` +
      `📱 የከፈሉበት ስልክ: ${phoneNumber}\n` +
      `🧾 Txn ID: ${txRef.trim()}\n\n` +
      `አድሚኑ ክፍያውን እንዳረጋገጠ ወዲያውኑ ወደ ዋሌትዎ ገቢ ይደረጋል!`;

    sendTelegramNotification(result.telegramId, userMsg);

    res.json({ success: true, message: 'የማስገቢያ ጥያቄዎ በተሳካ ሁኔታ ተልኳል! አድሚኑ እንደተመለከተው ባላንስዎ ይሞላል።' });
  } catch (err) {
    if (err.code === 'TXN_USED') {
      return res.status(409).json({
        error: '❌ ይህ Txn ID ቀድሞ ጥቅም ላይ ውሏል! ድጋሚ መጠቀም አይቻልም።\n(This Txn ID has already been used once, you can not use it again.)'
      });
    }
    if (err.code === 'TXN_PENDING') {
      return res.status(409).json({
        error: '⏳ ይህ Txn ID ቀድሞ ገብቷል፤ አድሚኑ እስኪያረጋግጠው ይጠብቁ።\n(This Txn ID was already submitted and is waiting for admin approval.)'
      });
    }
    res.status(400).json({ error: 'ጥያቄውን መላክ አልተቻለም!' });
  }
});

app.get('/api/payment/my-transactions', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.json({ transactions: [] });
  try {
    const txs = await DB.getUserTransactions(userId);
    res.json({ transactions: txs });
  } catch (e) {
    res.json({ transactions: [] });
  }
});

// 📤 ዝቅተኛው ማውጫ 225 ETB
app.post('/api/payment/withdraw', async (req, res) => {
  const { userId, amount, phoneNumber } = req.body;
  const withdrawAmount = parseFloat(amount);

  if (!withdrawAmount || isNaN(withdrawAmount) || withdrawAmount < 225) {
    return res.status(400).json({ error: 'ዝቅተኛው የማውጫ መጠን 225 ETB ነው!' });
  }
  if (!phoneNumber || phoneNumber.length < 9) {
    return res.status(400).json({ error: 'ትክክለኛ የቴሌብር ስልክ ቁጥር ያስገቡ!' });
  }

  try {
    const result = await DB.requestWithdrawal(userId, withdrawAmount, phoneNumber, 'TELEBIRR');
    const prof = await DB.getUserDetailedProfile(userId);

    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === userId) {
        pInfo.balance = result.remainingBalance;
        io.to(sockId).emit('balance_updated', {
          balance: result.remainingBalance,
          cashableBalance: prof.cashableBalance,
          playOnlyBalance: prof.playOnlyBalance
        });
      }
    }

    if (result.telegramId) {
      sendTelegramNotification(
        result.telegramId,
        `📤 የማውጣት ጥያቄዎ ተመዝግቧል!\n\n` +
        `💰 የተጠየቀው መጠን: ${withdrawAmount} ETB\n` +
        `📱 የሚላክበት የቴሌብር ስልክ: ${phoneNumber}\n\n` +
        `አድሚኑ ልኮ እንዳጠናቀቀ ማረጋገጫ ይደርስዎታል!`
      );
    }

    res.json({ success: true, message: 'የማውጣት ጥያቄዎ በተሳካ ሁኔታ ተልኳል!', txRef: result.txRef, remainingBalance: result.remainingBalance });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==================== ADMIN MIDDLEWARE & ENDPOINTS ====================
// ==================== 🧾 ADMIN AUDIT LOG ====================
const AUDIT_ROUTES = {
  '/api/admin/approve-deposit': 'APPROVE_DEPOSIT',
  '/api/admin/reject-deposit': 'REJECT_DEPOSIT',
  '/api/admin/approve-withdrawal': 'APPROVE_WITHDRAWAL',
  '/api/admin/reject-withdrawal': 'REJECT_WITHDRAWAL',
  '/api/admin/adjust-balance': 'ADJUST_BALANCE',
  '/api/admin/toggle-ban': 'TOGGLE_BAN',
  '/api/admin/update-settings': 'UPDATE_SETTINGS',
  '/api/admin/room-control': 'ROOM_CONTROL',
  '/api/admin/change-pin': 'CHANGE_PIN',
  '/api/admin/broadcast': 'BROADCAST',
  '/api/admin/create-promo': 'CREATE_PROMO',
  '/api/admin/delete-promo': 'DELETE_PROMO',
  '/api/admin/money-rain/create': 'MONEY_RAIN_CREATE',
  '/api/admin/money-rain/stop': 'MONEY_RAIN_STOP',
  '/api/admin/referral-contest/payout': 'REFERRAL_PAYOUT',
  '/api/admin/referral-contest/update-prizes': 'REFERRAL_PRIZES'
};

function cleanAdminName(raw) {
  const n = String(raw || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 30);
  return n || 'unknown';
}

app.use('/api/admin', (req, res, next) => {
  const action = req.method === 'POST' ? AUDIT_ROUTES[req.originalUrl.split('?')[0]] : null;
  if (!action) return next();

  const body = req.body || {};
  const adminName = cleanAdminName(req.headers['x-admin-name']);
  const ip = req.ip || req.connection?.remoteAddress || '';

  res.on('finish', async () => {
    if (res.statusCode >= 400) return;
    try {
      let targetUserId = body.userId ? parseInt(body.userId, 10) : null;
      let txId = body.txId ? parseInt(body.txId, 10) : null;
      let amount = body.amount !== undefined && body.amount !== '' ? parseFloat(body.amount) : null;
      let details = null;

      if (txId) {
        const t = await DB.getTransactionBrief(txId);
        if (t) { targetUserId = t.user_id; amount = parseFloat(t.amount); details = `${t.type} ${t.status} ref:${t.reference || '-'}`; }
      }
      if (action === 'ADJUST_BALANCE') details = `reason: ${String(body.reason || 'Admin action').slice(0, 200)}`;
      if (action === 'ROOM_CONTROL') details = `${body.roomName || ''} → ${body.action || ''}`;
      if (action === 'UPDATE_SETTINGS') {
        const keys = Object.keys(body).filter(k => body[k] !== undefined && body[k] !== '');
        details = `fields: ${keys.join(', ')}` + (body.commission !== undefined ? ` | commission=${body.commission}%` : '');
      }
      if (action === 'BROADCAST') details = String(body.message || '').slice(0, 120);
      if (!Number.isFinite(amount)) amount = null;

      await DB.addAuditLog({ adminName, ip, action, targetUserId: Number.isInteger(targetUserId) ? targetUserId : null, txId: Number.isInteger(txId) ? txId : null, amount, details });
    } catch (e) {
      console.warn('[!] Audit log failed:', e.message);
    }
  });
  next();
});

async function adminAuth(req, res, next) {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (!pin) return res.status(401).json({ error: 'PIN required' });
  const isValid = await DB.verifyAdminPin(String(pin));
  if (isValid) return next();
  return res.status(401).json({ error: 'የተሳሳተ ፒን ቁጥር ነው!' });
}

app.post('/api/admin/verify-pin', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const attempt = failedPinAttempts.get(ip) || { count: 0, lockUntil: 0 };

  if (attempt.lockUntil > now) {
    const remMins = Math.ceil((attempt.lockUntil - now) / 60000);
    return res.status(429).json({ success: false, error: `🚨 አካውንቱ ተቆልፏል! ከ ${remMins} ደቂቃ በኋላ ይሞክሩ።` });
  }

  const { pin } = req.body;
  const isValid = await DB.verifyAdminPin(String(pin));

  if (isValid) {
    failedPinAttempts.delete(ip);
    return res.json({ success: true, message: 'Authenticated' });
  } else {
    attempt.count++;
    if (attempt.count >= 5) attempt.lockUntil = now + 5 * 60 * 1000;
    failedPinAttempts.set(ip, attempt);
    const left = 5 - attempt.count;
    return res.status(401).json({ success: false, error: left > 0 ? `❌ የተሳሳተ ፒን! ${left} ሙከራ ቀርቶታል` : '🚨 5 ጊዜ ተሳስቷል! ለ 5 ደቂቃ ታግደዋል!' });
  }
});

function csvCell(v) {
  let t = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // CSV/Excel formula injection guard
  return `"${t.replace(/"/g, '""')}"`;
}
function toCsv(headers, rows) {
  return '\uFEFF' + [headers.map(csvCell).join(',')].concat(rows.map(r => r.map(csvCell).join(','))).join('\r\n');
}
function validDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')); }

app.get('/api/admin/reports/profit', adminAuth, async (req, res) => {
  try {
    const offset = parseInt(process.env.REPORT_UTC_OFFSET_HOURS, 10);
    const tzOffset = Number.isFinite(offset) ? offset : 3; // ኢትዮጵያ UTC+3
    const today = new Date(Date.now() + tzOffset * 3600 * 1000).toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() + tzOffset * 3600 * 1000 - 6 * 86400000).toISOString().slice(0, 10);
    const from = validDate(req.query.from) ? req.query.from : weekAgo;
    const to = validDate(req.query.to) ? req.query.to : today;

    const report = await DB.getProfitReport(from, to, tzOffset);

    if (req.query.format === 'csv') {
      const rows = [];
      report.perRoom.forEach(r => rows.push([r.day, r.room, r.bets, r.refunds, r.prizes, r.wins, r.profit, r.margin + '%']));
      rows.push(['TOTAL', 'ALL', report.totals.bets, report.totals.refunds, report.totals.prizes, report.totals.wins, report.totals.profit, '']);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="profit-report_${from}_to_${to}.csv"`);
      return res.send(toCsv(['Date', 'Room', 'Bets (ETB)', 'Refunds (ETB)', 'Prizes paid (ETB)', 'Wins', 'House profit (ETB)', 'Margin'], rows));
    }
    res.json({ success: true, from, to, ...report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/audit-log', adminAuth, async (req, res) => {
  try {
    const isCsv = req.query.format === 'csv';
    const rows = await DB.getAuditLog({ limit: isCsv ? 5000 : 200, search: req.query.search || '', action: req.query.action || 'ALL' });
    if (isCsv) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="admin-audit-log.csv"');
      return res.send(toCsv(
        ['Time', 'Admin', 'IP', 'Action', 'User ID', 'Username', 'Tx ID', 'Amount', 'Details'],
        rows.map(r => [new Date(r.created_at).toISOString(), r.admin_name, r.ip, r.action, r.target_user_id, r.target_username, r.tx_id, r.amount, r.details])
      ));
    }
    res.json({ success: true, log: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/fraud-flags', adminAuth, async (req, res) => {
  try {
    const flags = await DB.getFraudFlags();
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="fraud-flags.csv"');
      return res.send(toCsv(
        ['Severity', 'Type', 'Key', 'Detail', 'Users'],
        flags.map(f => [f.severity, f.type, f.key, f.detail, f.users.map(u => `#${u.id} ${u.username || u.firstName || ''}`).join(' | ')])
      ));
    }
    res.json({ success: true, flags });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const stats = await DB.getAdminStats();
    const todayStats = await DB.getTodayFinancialStats();

    stats.onlinePlayers = activeSockets.size;
    stats.globalCommission = globalCommissionPercent;
    stats.paymentInfo = paymentInfo;
    stats.bonusSettings = bonusSettings;
    stats.activeRooms = {
      Beginner: { stake: rooms.Beginner.stake, state: rooms.Beginner.state, cardsSold: rooms.Beginner.takenCartelas.size, speed: rooms.Beginner.callSpeed, isPaused: rooms.Beginner.isPaused },
      Turbo: { stake: rooms.Turbo.stake, state: rooms.Turbo.state, cardsSold: rooms.Turbo.takenCartelas.size, speed: rooms.Turbo.callSpeed, isPaused: rooms.Turbo.isPaused },
      VIP: { stake: rooms.VIP.stake, state: rooms.VIP.state, cardsSold: rooms.VIP.takenCartelas.size, speed: rooms.VIP.callSpeed, isPaused: rooms.VIP.isPaused }
    };
    const users = await DB.getAllUsers(req.query.search);
    const games = await DB.getRecentGames();
    const pendingDeposits = await DB.getPendingDeposits();
    const pendingWithdrawals = await DB.getPendingWithdrawals();
    res.json({ stats, todayStats, users, games, pendingDeposits, pendingWithdrawals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/pending-deposits', adminAuth, async (req, res) => {
  try {
    const list = await DB.getPendingDeposits();
    res.json({ success: true, deposits: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/approve-deposit', adminAuth, async (req, res) => {
  const { txId } = req.body;
  try {
    const result = await DB.approveDeposit(txId);
    const prof = await DB.getUserDetailedProfile(result.userId);

    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === result.userId) {
        pInfo.balance = result.newBalance;
        io.to(sockId).emit('balance_updated', {
          balance: result.newBalance,
          cashableBalance: prof.cashableBalance,
          playOnlyBalance: prof.playOnlyBalance
        });
        io.to(sockId).emit('deposit_approved', {
          txId,
          amount: result.amount,
          bonus: result.bonus,
          message: `🎉 የ ${result.amount} ETB ማስገቢያ ጥያቄዎ ጸድቋል፤ ሒሳብዎ ላይ ገቢ ሆኗል!` +
            (result.bonus > 0 ? `\n🎁 የ ${result.bonus} ETB ቦነስ ተጨምሯል! ቦነሱን ለማውጣት ተጨማሪ ${result.wageringRemaining.toFixed(2)} ETB ካርቴላ መጫወት ይኖርብዎታል።` : '')
        });
      }
    }

    const botMsg = 
      `🎉 እንኳን ደስ አለዎት! ዲፖዚትዎ ጸድቋል!\n` +
      `🎁 የ ${result.amount} ETB ክፍያ ወደ ዋሌትዎ ገቢ ሆኗል!\n` +
      (result.bonus > 0 ? `✨ የዲፖዚት ቦነስ: +${result.bonus} ETB (ለማውጣት ተጨማሪ ${result.wageringRemaining.toFixed(2)} ETB መጫወት ያስፈልጋል)\n` : '') +
      `💰 አጠቃላይ ባላንስዎ: ${result.newBalance} ETB\n\n` +
      `ለመጫወት ከታች ያለውን '🎮 ይጫወቱ' በተን ይጫኑ!`;

    sendTelegramNotification(result.telegramId, botMsg, true);
    res.json({ success: true, message: 'ማስገቢያው ጸድቋል፤ ለተጫዋቹ ገቢ ተደርጓል!' });
  } catch (err) {
    if (err.code === 'TXN_USED') {
      return res.status(409).json({
        error: '🚫 ይህ Txn ID ቀድሞ ጸድቆ ጥቅም ላይ ውሏል! ድጋሚ ማጽደቅ አይቻልም — እባክዎ ጥያቄውን ውድቅ (Reject) ያድርጉት።\n(This Txn ID was already used in an approved deposit. Please reject this request.)'
      });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reject-deposit', adminAuth, async (req, res) => {
  const { txId } = req.body;
  try {
    await DB.rejectDeposit(txId);
    res.json({ success: true, message: 'የማስገቢያ ጥያቄው ውድቅ ተደርጓል!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/pending-withdrawals', adminAuth, async (req, res) => {
  try {
    const list = await DB.getPendingWithdrawals();
    res.json({ success: true, withdrawals: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/approve-withdrawal', adminAuth, async (req, res) => {
  const { txId } = req.body;
  try {
    const result = await DB.approveWithdrawal(txId);
    if (result && result.telegramId) {
      sendTelegramNotification(
        result.telegramId,
        `✅ እንኳን ደስ አለዎት! ክፍያዎ ተፈጽሟል!\n\n` +
        `💸 የወጣው መጠን: ${result.amount} ETB\n` +
        `📱 የተላከበት: ${result.phoneNumber} (TELEBIRR)\n\n` +
        `ገቢ መደረጉን ያረጋግጡ። ስላሸነፉ እናመሰግናለን! 🌟`
      );
    }
    res.json({ success: true, message: 'ክፍያው ጸድቋል!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reject-withdrawal', adminAuth, async (req, res) => {
  const { txId } = req.body;
  try {
    const result = await DB.rejectWithdrawal(txId);
    const prof = await DB.getUserDetailedProfile(result.userId);

    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === result.userId) {
        pInfo.balance = result.newBalance;
        io.to(sockId).emit('balance_updated', {
          balance: result.newBalance,
          cashableBalance: prof.cashableBalance,
          playOnlyBalance: prof.playOnlyBalance
        });
        io.to(sockId).emit('withdrawal_rejected', {
          txId,
          amount: result.refundedAmount,
          newBalance: result.newBalance,
          message: `⚠️ የ ${result.refundedAmount} ETB ማውጣት ጥያቄዎ ውድቅ ተደርጓል፤ የተጠየቀው ${result.refundedAmount} ETB ወዲያውኑ ወደ ዋሌትዎ ተመልሷል!`
        });
      }
    }

    if (result.telegramId) {
      sendTelegramNotification(
        result.telegramId,
        `⚠️ የማውጣት ጥያቄዎ ውድቅ ተደርጓል!\n\n` +
        `🪙 የተመለሰው መጠን: ${result.refundedAmount} ETB\n` +
        `💰 አጠቃላይ ባላንስዎ: ${result.newBalance} ETB\n\n` +
        `የተጠየቀው ብር ወደ ዋሌትዎ ተመልሷል!`
      );
    }

    res.json({ success: true, message: `ጥያቄው ውድቅ ተደርጎ የ ${result.refundedAmount} ETB ተመላሽ ለተጫዋቹ ገቢ ሆኗል!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🏆 ሳምንታዊ የሪፈራል ውድድር ADMIN APIs
app.get('/api/admin/referral-contest', adminAuth, async (req, res) => {
  try {
    const data = await DB.getWeeklyReferralLeaderboard();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/referral-contest/update-prizes', adminAuth, async (req, res) => {
  const { prize1, prize2, prize3 } = req.body;
  try {
    await DB.updateReferralContestPrizes(parseFloat(prize1) || 0, parseFloat(prize2) || 0, parseFloat(prize3) || 0);

    io.emit('contest_prizes_updated', {
      prizes: { prize1: parseFloat(prize1) || 0, prize2: parseFloat(prize2) || 0, prize3: parseFloat(prize3) || 0 }
    });

    res.json({ success: true, message: 'የውድድር ሽልማት መጠኖች ተስተካክለዋል!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/referral-contest/payout', adminAuth, async (req, res) => {
  const { prize1, prize2, prize3 } = req.body;
  try {
    const result = await DB.payoutWeeklyReferralContest(prize1, prize2, prize3);

    for (const w of result.winners) {
      const prof = await DB.getUserDetailedProfile(w.userId);

      for (const [sockId, pInfo] of activeSockets.entries()) {
        if (pInfo.dbId === w.userId) {
          pInfo.balance = w.newBalance;
          io.to(sockId).emit('balance_updated', {
            balance: w.newBalance,
            cashableBalance: prof.cashableBalance,
            playOnlyBalance: prof.playOnlyBalance
          });
          io.to(sockId).emit('contest_winner', {
            rank: w.rank,
            prize: w.prize,
            message: `🎉 እንኳን ደስ አለዎት! በሳምንታዊው የግብዣ ውድድር የ ${w.rank}ኛ ደረጃ አሸናፊ በመሆን ${w.prize} ETB ተሸልመዋል!`
          });
        }
      }

      if (w.telegramId) {
        const medal = w.rank === 1 ? '🥇 1ኛ' : w.rank === 2 ? '🥈 2ኛ' : '🥉 3ኛ';
        sendTelegramNotification(
          w.telegramId,
          `🎉 <b>እንኳን ደስ አለዎት!</b>\n\n` +
          `🏆 በሳምንታዊው የግብዣ ውድድር <b>${medal} ደረጃ</b> በመውጣት የ <b>${w.prize} ETB</b> ተሸላሚ ሆነዋል!\n` +
          `👥 የጋበዟቸው ጓደኞች: ${w.inviteCount} ሰዎች\n` +
          `💰 አጠቃላይ ባላንስዎ: <b>${w.newBalance} ETB</b>\n\n` +
          `ሽልማትዎ በቀጥታ ወደ ዋሌትዎ ገቢ ተደርጓል፤ አሁኑኑ ይግቡና ይጫወቱ! 🌟`,
          true
        );
      }
    }

    res.json({
      success: true,
      message: `ሽልማቱ ለ ${result.winners.length} አሸናፊዎች በተሳካ ሁኔታ ተከፍሎ አዲሱ ሳምንት ጀምሯል!`,
      winners: result.winners
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🌧️ ==================== MONEY RAIN ADMIN APIs ====================
app.get('/api/admin/money-rain/list', adminAuth, async (req, res) => {
  try {
    const list = await DB.getAllMoneyRains();
    res.json({ success: true, list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/money-rain/create', adminAuth, async (req, res) => {
  const { title, rewardAmount, maxUsers } = req.body;
  const reward = parseFloat(rewardAmount);
  const max = parseInt(maxUsers, 10);

  if (!reward || reward <= 0 || !max || max <= 0) {
    return res.status(400).json({ error: 'ትክክለኛ የብር መጠንና የተጠቃሚዎች ቁጥር ያስገቡ!' });
  }

  try {
    const rainTitle = title ? title.trim() : 'ልዩ የገንዘብ ዝናብ!';
    const rain = await DB.createMoneyRain(rainTitle, reward, max);

    const rainMessage = 
      `🌧️ <b>ይፍጠኑ | MONEY RAIN ALERT!</b> 🌧️\n\n` +
      `<b>${reward} ETB Free Play Bonus</b> - ነፃ የመጫወቻ ገንዘብ እየዘነበ ነው!\n` +
      `<i>${rainTitle}</i>\n\n` +
      `👇 <b>የቀደሙ ${max} ሰዎች ብቻ!</b>`;

    const rainKeyboard = {
      inline_keyboard: [
        [{ text: '💰 ቦነስ ይቀበሉ (CLAIM) 💰', callback_data: `claim_rain_${rain.id}` }]
      ]
    };

    (async () => {
      const tgIds = await DB.getAllTelegramIds();
      for (const tgId of tgIds) {
        try {
          if (bot && tgId && !String(tgId).startsWith('demo_')) {
            await bot.sendMessage(tgId, rainMessage, { parse_mode: 'HTML', reply_markup: rainKeyboard });
            await new Promise(r => setTimeout(r, 35));
          }
        } catch (e) {}
      }
    })();

    res.json({
      success: true,
      message: `የ ${reward} ETB የገንዘብ ዝናብ ለቀደሙ ${max} ሰዎች በተሳካ ሁኔታ ተለቋል!`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/money-rain/stop', adminAuth, async (req, res) => {
  const { rainId } = req.body;
  try {
    await DB.stopMoneyRain(rainId);
    res.json({ success: true, message: 'የገንዘብ ዝናቡ በተሳካ ሁኔታ ተቋርጧል (ተዘግቷል)!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🎁 ፕሮሞኮድ APIs
app.get('/api/admin/promo-codes', adminAuth, async (req, res) => {
  try {
    const promos = await DB.getAllPromoCodes();
    res.json({ success: true, promos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/create-promo', adminAuth, async (req, res) => {
  const { code, rewardAmount, maxUsers, expiryHours } = req.body;
  if (!code || !rewardAmount) return res.status(400).json({ error: 'የኮድ ስም እና የብር መጠን ያስገቡ!' });

  try {
    const promo = await DB.createPromoCode(
      code,
      parseFloat(rewardAmount),
      parseInt(maxUsers, 10) || 50,
      parseFloat(expiryHours) || 24
    );
    res.json({ success: true, message: `ፕሮሞኮድ ${promo.code} በተሳካ ሁኔታ ተፈጥሯል!`, promo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/delete-promo', adminAuth, async (req, res) => {
  const { promoId } = req.body;
  try {
    await DB.deletePromoCode(promoId);
    res.json({ success: true, message: 'ፕሮሞኮዱ ተሰርዟል!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/transactions-archive', adminAuth, async (req, res) => {
  try {
    const { type = 'ALL', status = 'ALL', search = '' } = req.query;
    const transactions = await DB.getTransactionArchive(type, status, search);
    res.json({ success: true, transactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/user-profile/:id', adminAuth, async (req, res) => {
  try {
    const profile = await DB.getUserDetailedProfile(req.params.id);
    res.json({ success: true, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/update-settings', adminAuth, async (req, res) => {
  const { commission, beginnerStake, turboStake, vipStake, payPhone, payName, bonus } = req.body;
  if (commission !== undefined) globalCommissionPercent = parseInt(commission, 10);
  if (beginnerStake && rooms.Beginner) rooms.Beginner.stake = parseFloat(beginnerStake);
  if (turboStake && rooms.Turbo) rooms.Turbo.stake = parseFloat(turboStake);
  if (vipStake && rooms.VIP) rooms.VIP.stake = parseFloat(vipStake);

  try {
    const entries = {};

    if (payPhone !== undefined || payName !== undefined) {
      const phone = String(payPhone || '').replace(/\s+/g, '');
      const name = String(payName || '').trim();
      if (!/^[0-9+]{9,15}$/.test(phone)) {
        return res.status(400).json({ error: '❌ የቴሌብር ስልክ ቁጥር ትክክል አይደለም!' });
      }
      if (!name || name.length > 40) {
        return res.status(400).json({ error: '❌ የስም መስክ ባዶ ወይም ከ 40 ፊደል በላይ መሆን የለበትም!' });
      }
      entries.pay_phone = phone;
      entries.pay_name = name;
    }

    if (bonus && typeof bonus === 'object') {
      const pct = parseFloat(bonus.percent);
      const max = parseFloat(bonus.max);
      const minDep = parseFloat(bonus.minDeposit);
      const mult = parseFloat(bonus.wagerMultiplier);
      if (![pct, max, minDep, mult].every(n => Number.isFinite(n) && n >= 0) || pct > 300) {
        return res.status(400).json({ error: '❌ የቦነስ ቁጥሮች ትክክል አይደሉም!' });
      }
      entries.bonus_enabled = bonus.enabled ? '1' : '0';
      entries.bonus_percent = pct;
      entries.bonus_max = max;
      entries.bonus_min_deposit = minDep;
      entries.bonus_wager_multiplier = mult;
      entries.bonus_first_only = bonus.firstOnly ? '1' : '0';
    }

    if (Object.keys(entries).length > 0) {
      await DB.saveSettings(entries);
      paymentInfo = await DB.getPaymentSettings();
      bonusSettings = await DB.getBonusSettings();
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  broadcastRealRoomsStatus();
  res.json({ success: true, message: 'ቅንብሩ በተሳካ ሁኔታ ተቀይሯል!' });
});

app.post('/api/admin/adjust-balance', adminAuth, async (req, res) => {
  const { userId, amount, reason } = req.body;
  try {
    const newBalance = await DB.updateBalance(userId, parseFloat(amount), 'ADMIN_ADJUST', reason || 'Admin action');
    const prof = await DB.getUserDetailedProfile(userId);

    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === parseInt(userId, 10)) {
        pInfo.balance = newBalance;
        io.to(sockId).emit('balance_updated', {
          balance: newBalance,
          cashableBalance: prof.cashableBalance,
          playOnlyBalance: prof.playOnlyBalance
        });
      }
    }
    res.json({ success: true, message: 'ሒሳቡ ተስተካክሏል!', newBalance });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/toggle-ban', adminAuth, async (req, res) => {
  const { userId } = req.body;
  try {
    const newBanStatus = await DB.toggleBanUser(userId);
    if (newBanStatus === 1) {
      for (const [sockId, pInfo] of activeSockets.entries()) {
        if (pInfo.dbId === parseInt(userId, 10)) {
          io.to(sockId).emit('account_banned');
          io.sockets.sockets.get(sockId)?.disconnect(true);
        }
      }
    }
    res.json({ success: true, isBanned: newBanStatus === 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/room-control', adminAuth, async (req, res) => {
  const { roomName, action } = req.body;
  const room = rooms[roomName];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (action === 'TOGGLE_PAUSE') {
    room.isPaused = !room.isPaused;
  } else if (action === 'FORCE_START') {
    if (room.state === 'LOBBY' && room.takenCartelas.size > 0) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      startRoomGame(roomName);
    }
  } else if (action === 'RESTART_LOBBY') {
    if (room.gameInterval) clearInterval(room.gameInterval);
    try {
      const refunds = await DB.refundActiveBets({ roomName, reason: `${roomName} Admin Restart` });
      await notifyRefunds(refunds, '🔄 ዙሩ በአድሚን ዳግም ተጀምሯል፤ ውርርድዎ ተመላሽ ሆኗል!');
    } catch (e) { console.error('Restart refund error:', e.message); }
    startRoomLobby(roomName);
  }

  broadcastRealRoomsStatus();
  res.json({ success: true, message: `${roomName} ${action} ተፈጽሟል!` });
});

// Telegram HTML ፓርስ ካልተሳካ (ለምሳሌ ያልተዘጋ < ምልክት) በተራ ጽሁፍ እንደገና ይሞክራል
async function sendWithHtmlFallback(sendFn, opts) {
  try {
    return await sendFn(opts);
  } catch (err) {
    if (/parse entities/i.test(err.message || '')) {
      const plain = { ...opts };
      delete plain.parse_mode;
      return await sendFn(plain);
    }
    throw err;
  }
}

app.post('/api/admin/broadcast', adminAuth, async (req, res) => {
  const message = String((req.body && req.body.message) || '').trim();
  const imageData = req.body && req.body.image;

  if (!message && !imageData) {
    return res.status(400).json({ error: 'Message or image is required' });
  }

  // 🖼️ ምስል ካለ (data:image/...;base64,....) ወደ Buffer እንቀይራለን
  let photoBuffer = null;
  if (imageData) {
    const raw = String(imageData);
    const comma = raw.indexOf(',');
    const header = comma > -1 ? raw.slice(0, comma) : '';
    if (!/^data:image\/(jpeg|png|webp);base64$/i.test(header)) {
      return res.status(400).json({ error: 'ምስሉ JPG, PNG ወይም WEBP መሆን አለበት!' });
    }
    photoBuffer = Buffer.from(raw.slice(comma + 1), 'base64');
    if (photoBuffer.length === 0 || photoBuffer.length > 8 * 1024 * 1024) {
      return res.status(400).json({ error: 'የምስሉ መጠን ከ 8MB መብለጥ የለበትም!' });
    }
  }

  if (message) io.emit('admin_broadcast', { message });

  try {
    const tgIds = await DB.getAllTelegramIds();
    const webAppUrl = `${getAppBaseUrl()}/?v=${Date.now()}`;
    const options = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🎮 አሁኑኑ ተጫወት (Play Now)', web_app: { url: webAppUrl } }]]
      }
    };

    (async () => {
      let sentCount = 0;
      let failedCount = 0;
      let cachedFileId = null; // የመጀመሪያው ላይ ከተሰቀለ በኋላ ለሌሎች file_id ብቻ ነው የምንጠቀመው (ፈጣን)
      const CAPTION_LIMIT = 1024;
      const captionFits = message.length <= CAPTION_LIMIT;

      for (const tgId of tgIds) {
        if (!bot || !tgId || String(tgId).startsWith('demo_')) continue;
        try {
          if (photoBuffer) {
            const photoSource = cachedFileId || photoBuffer;
            const photoOpts = captionFits
              ? { ...options, caption: message }
              : {};

            const sentMsg = await sendWithHtmlFallback(
              (o) => bot.sendPhoto(tgId, photoSource, o, { filename: 'broadcast.jpg', contentType: 'image/jpeg' }),
              photoOpts
            );

            if (!cachedFileId && sentMsg && Array.isArray(sentMsg.photo) && sentMsg.photo.length > 0) {
              cachedFileId = sentMsg.photo[sentMsg.photo.length - 1].file_id;
            }

            // መልዕክቱ ከ 1024 ፊደል ከበለጠ ከምስሉ ቀጥሎ እንደ ሌላ መልዕክት ይላካል
            if (message && !captionFits) {
              await sendWithHtmlFallback((o) => bot.sendMessage(tgId, message, o), options);
            }
          } else {
            await sendWithHtmlFallback(
              (o) => bot.sendMessage(tgId, `📢 <b>መልዕክት ከአድሚን</b>\n\n${message}`, o),
              options
            );
          }
          sentCount++;
        } catch (err) {
          failedCount++;
        }
        await new Promise(r => setTimeout(r, 35));
      }
      console.log(`[+] Broadcast${photoBuffer ? ' (with image)' : ''} sent to ${sentCount}/${tgIds.length} Telegram users. Failed: ${failedCount}`);
    })();

    res.json({
      success: true,
      message: `ማስታወቂያው${photoBuffer ? ' (ከምስል ጋር)' : ''} ለ ${tgIds.length} ተጠቃሚዎች በቴሌግራም መላክ ጀምሯል!`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/change-pin', adminAuth, async (req, res) => {
  const { oldPin, newPin } = req.body;
  try {
    await DB.changeAdminPin(String(oldPin), String(newPin));
    res.json({ success: true, message: 'የአድሚን ፒን በተሳካ ሁኔታ ተቀይሯል!' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
(async () => {
  try {
    await loadLiveSettings();
  } catch (err) {
    console.error('[-] Loading settings failed (using defaults):', err.message);
  }
  try {
    await recoverOrphanedBets();
  } catch (err) {
    console.error('[-] Startup bet recovery failed:', err.message);
  }
  server.listen(PORT, () => {
    console.log(`🚀 Kokeb Live Bingo Server Running on port ${PORT}`);
  });
})();
