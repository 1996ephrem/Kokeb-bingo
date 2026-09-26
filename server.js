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
const { generate100Cartelas, validateBingo } = require('./gameEngine');
const { verifyTelegramAuth } = require('./telegramAuth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

let detectedBotUsername = process.env.BOT_USERNAME || 'Kokeb_Bingo_Bot';
let globalCommissionPercent = parseInt(process.env.HOUSE_COMMISSION_PERCENT, 10) || 15;

const failedPinAttempts = new Map();
const activeSockets = new Map();

function getAppBaseUrl() {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  }
  return 'https://kokeb-bingo.onrender.com';
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

      // ጋባዡን ጓደኛህ ገብቷል ብሎ ማሳወቅ (ያለ ቦነስ ቃል)
      if (referrerRef && !user.phone_number) {
        bot.sendMessage(
          referrerRef,
          `👋 አንድ ጓደኛዎ (${firstName}) በእርስዎ ሊንክ ገብቷል!`
        ).catch(() => {});
      }

      if (!user.phone_number) {
        return bot.sendMessage(
          chatId,
          `🎯 Welcome to Kokeb Bingo 🌟!\n\nጨዋታውን ለመጀመር እባክዎ ከታች ያለውን ሰማያዊ '📲 ስልክ ቁጥር አረጋግጥ' የሚለውን በተን ይጫኑ።`,
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
        `🎯 እንኳን ደህና መጡ ${firstName}!\nአካውንትዎ አስቀድሞ ተመዝግቧል።\n💰 ቀሪ ሒሳብዎ: ${user.balance} ETB\n\nለመጫወት ከታች ያለውን Play Now በተን ይጫኑ!`,
        {
          reply_markup: {
            remove_keyboard: true,
            inline_keyboard: [
              [{ text: '🎮 አሁኑኑ ተጫወት (Play Now)', web_app: { url: webAppUrl } }],
              [{ text: 'ℹ️ መመሪያ (Help)', callback_data: 'help' }]
            ]
          }
        }
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
      const playKeyboard = {
        reply_markup: {
          remove_keyboard: true,
          inline_keyboard: [[{ text: '🎮 አሁኑኑ ተጫወት (Play Now)', web_app: { url: webAppUrl } }]]
        }
      };

      if (!regResult.alreadyRegistered) {
        bot.sendMessage(
          chatId,
          `🎉 እንኳን ደስ አለዎት ምዝገባዎ ተጠናቋል!\n\n✅ ስልክ ቁጥርዎ ተረጋግጧል (${phone})\n💰 ለመጫወት በቴሌብር ወይም በሲቢኢ ሒሳብዎን ይሙሉ!\n\nለመጫወት ከታች ያለውን Play Now በተን ይጫኑ!`,
          playKeyboard
        ).catch(() => {});
      } else {
        bot.sendMessage(
          chatId,
          `ℹ️ ይህ ስልክ ቁጥር (${phone}) አስቀድሞ የተመዘገበ ነው!\n\n💰 ቀሪ ሒሳብዎ: ${regResult.user.balance} ETB\n\nለመጫወት ከታች ያለውን Play Now በተን ይጫኑ!`,
          playKeyboard
        ).catch(() => {});
      }
    } catch (err) {
      if (err.message === 'DUPLICATE_PHONE_OTHER_ACCOUNT') {
        bot.sendMessage(chatId, `❌ ይቅርታ! ይህ ስልክ ቁጥር ቀድሞ በሌላ የቴሌግራም አካውንት ተመዝግቧል!`).catch(() => {});
      }
    }
  });

  bot.on('callback_query', (query) => {
    if (query.data === 'help') {
      bot.sendMessage(
        query.message.chat.id,
        `📖 የኮከብ ቢንጎ አጨዋወት መመሪያ:\n\n1. በቴሌብር ወይም CBE ብር ያስገቡ\n2. ካርቴላ ይቁረጡ (10፣ 25 ወይም 100 ETB)\n3. ኳሶችን ይከታተሉ\n4. መስመር ወይም 4 ማዕዘን ሲሞላ CLAIM BINGO ይጫኑ!`
      ).catch(() => {});
    }
  });
}

function sendTelegramNotification(telegramId, message, withPlayButton = false) {
  if (!bot || !telegramId || String(telegramId).startsWith('demo_')) return;
  try {
    const options = {};
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

// ==================== BINGO ROOMS ENGINE ====================
function createRoomState(name, stake, callSpeed) {
  return {
    name,
    stake,
    callSpeed,
    state: 'LOBBY',
    timer: 30,
    timerInterval: null,
    gameInterval: null,
    cartelas: generate100Cartelas(),
    takenCartelas: new Map(),
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
  room.cartelas = generate100Cartelas();

  io.to(roomName).emit('room_reset', {
    roomName,
    cartelas: room.cartelas,
    timer: room.timer,
    stake: room.stake
  });

  broadcastRealRoomsStatus();

  if (room.timerInterval) clearInterval(room.timerInterval);

  room.timerInterval = setInterval(() => {
    if (room.isPaused) return;
    room.timer--;
    io.to(roomName).emit('lobby_timer_tick', { timer: room.timer, roomName });

    if (room.timer <= 0) {
      const uniquePlayerIds = new Set(Array.from(room.takenCartelas.values()).map(c => c.dbId));

      if (uniquePlayerIds.size >= 3 && room.takenCartelas.size >= 3) {
        clearInterval(room.timerInterval);
        startRoomGame(roomName);
      } else if (room.takenCartelas.size > 0) {
        room.timer = 20;
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

  room.gameInterval = setInterval(() => {
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
  }, room.callSpeed);
}

async function endGame(roomName, winnerData, message) {
  const room = rooms[roomName];
  if (!room) return;
  room.state = 'FINISHED';
  room.winnerDeclared = true;
  if (room.gameInterval) clearInterval(room.gameInterval);

  if (winnerData) {
    await DB.saveGameRound(
      roomName,
      winnerData.username,
      winnerData.cartelaId,
      winnerData.prize,
      room.takenCartelas.size,
      room.drawnCount
    );
  }

  io.to(roomName).emit('game_finished', {
    winner: winnerData,
    message: winnerData ? `🎉 ${winnerData.username} በካርቴላ #${winnerData.cartelaId} ${winnerData.prize} ETB አሸነፈ!` : message
  });

  broadcastRealRoomsStatus();
  setTimeout(() => { startRoomLobby(roomName); }, 5000);
}

Object.keys(rooms).forEach(name => startRoomLobby(name));

// ==================== WEBSOCKET HANDLERS ====================
io.on('connection', (socket) => {
  socket.on('auth_user', async ({ username, initData, deviceId }) => {
    try {
      let telegramId = deviceId || `demo_${socket.id.substring(0, 5)}`;
      let playerName = username || 'Player';

      if (initData && process.env.BOT_TOKEN) {
        const tgUser = verifyTelegramAuth(initData, process.env.BOT_TOKEN);
        if (tgUser) {
          telegramId = tgUser.id.toString();
          playerName = tgUser.username ? `@${tgUser.username}` : (tgUser.first_name + (tgUser.last_name ? ` ${tgUser.last_name}` : ''));
        }
      }

      const user = await DB.getOrCreateUser(telegramId, playerName, playerName);

      if (user.is_banned === 1) {
        socket.emit('account_banned', { message: '❌ የእርስዎ አካውንት በአድሚን ታግዷል!' });
        setTimeout(() => socket.disconnect(true), 500);
        return;
      }

      activeSockets.set(socket.id, {
        dbId: user.id,
        telegramId: user.telegram_id,
        username: user.username,
        balance: user.balance
      });

      socket.emit('auth_success', {
        id: user.id,
        telegramId: user.telegram_id,
        username: user.username,
        balance: user.balance,
        botUsername: detectedBotUsername,
        checkinStreak: user.checkin_streak || 0,
        lastCheckinDate: user.last_checkin_date
      });

      broadcastRealRoomsStatus();
    } catch (err) {
      socket.emit('error_message', 'Authentication failed');
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
      cartelas: room.cartelas,
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
          const newBal = await DB.updateBalance(player.dbId, refundTotal, 'REFUND', `${roomName} Lobby Leave`);
          player.balance = newBal;
          socket.emit('balance_updated', { balance: newBal });
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

    const totalCost = cartelaIds.length * room.stake;
    if (cartelaIds.some(id => room.takenCartelas.has(id))) {
      return socket.emit('error_message', 'አንዱ ካርቴላ ቀድሞ በሌላ ተጫዋች ተይዟል!');
    }

    try {
      const newBalance = await DB.updateBalance(player.dbId, -totalCost, 'BET', roomName);
      player.balance = newBalance;

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

      const totalPot = room.takenCartelas.size * room.stake;
      const prizePool = Math.floor(totalPot * ((100 - globalCommissionPercent) / 100));

      socket.emit('cartelas_bought_success', {
        balance: newBalance,
        boughtIds: cartelaIds,
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
      return socket.emit('error_message', 'ይህ ዙር አስቀድሞ በሌላ ተጫዋች ተሸንፏል!');
    }

    const cardInfo = room.takenCartelas.get(cartelaId);
    if (!cardInfo || cardInfo.socketId !== socket.id) {
      return socket.emit('error_message', 'የተሳሳተ ካርቴላ ጥሪ ነው!');
    }

    const cardGrid = room.cartelas[cartelaId];

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
        socket.emit('balance_updated', { balance: updatedBalance });

        endGame(
          roomName,
          { username: player.username, cartelaId, prize },
          `🎉 ቢንጎ! ${player.username} በካርቴላ #${cartelaId} ${prize} ETB አሸነፈ!`
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

// ==================== PLAYER APIS ====================
app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaders = await DB.getRealLeaderboard();
    res.json({ success: true, leaders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/checkin/claim', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'User ID required' });

  try {
    const result = await DB.claimDailyCheckinStreak(userId);
    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === userId) {
        pInfo.balance = result.newBalance;
        io.to(sockId).emit('balance_updated', { balance: result.newBalance });
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
    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === parseInt(userId, 10)) {
        pInfo.balance = result.newBalance;
        io.to(sockId).emit('balance_updated', { balance: result.newBalance });
      }
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/payment/deposit-request', async (req, res) => {
  const { userId, amount, phoneNumber, txRef, method } = req.body;
  const depositAmount = parseFloat(amount);

  if (!depositAmount || isNaN(depositAmount) || depositAmount < 10) {
    return res.status(400).json({ error: 'ዝቅተኛው የማስገቢያ መጠን 10 ETB ነው!' });
  }
  if (!phoneNumber || phoneNumber.length < 9) {
    return res.status(400).json({ error: 'እባክዎን የላኩበትን ትክክለኛ ስልክ ቁጥር ያስገቡ!' });
  }
  if (!txRef || txRef.trim().length < 4) {
    return res.status(400).json({ error: 'እባክዎን ከቴሌብር/ሲቢኢ የደረሶትን የትራንዛክሽን ቁጥር (Txn ID) ያስገቡ!' });
  }

  try {
    const result = await DB.requestDeposit(userId, depositAmount, phoneNumber, txRef.trim(), method || 'TELEBIRR');

    const userMsg = 
      `⏳ የማስገቢያ ጥያቄዎ ደርሶናል!\n\n` +
      `💰 መጠን: ${depositAmount} ETB\n` +
      `📱 የከፈሉበት ስልክ: ${phoneNumber}\n` +
      `🧾 Txn ID: ${txRef.trim()}\n\n` +
      `አድሚኑ ክፍያውን እንዳረጋገጠ ወዲያውኑ ወደ ዋሌትዎ ገቢ ይደረጋል!`;

    sendTelegramNotification(result.telegramId, userMsg);

    res.json({ success: true, message: 'የማስገቢያ ጥያቄዎ በተሳካ ሁኔታ ተልኳል! አድሚኑ እንደተመለከተው ባላንስዎ ይሞላል።' });
  } catch (err) {
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

app.post('/api/payment/withdraw', async (req, res) => {
  const { userId, amount, phoneNumber, method } = req.body;
  const withdrawAmount = parseFloat(amount);

  if (!withdrawAmount || isNaN(withdrawAmount) || withdrawAmount < 50) {
    return res.status(400).json({ error: 'ዝቅተኛው የማውጫ መጠን 50 ETB ነው!' });
  }
  if (!phoneNumber || phoneNumber.length < 9) {
    return res.status(400).json({ error: 'ትክክለኛ የስልክ ቁጥር ወይም የባንክ አካውንት ያስገቡ!' });
  }

  try {
    const result = await DB.requestWithdrawal(userId, withdrawAmount, phoneNumber, method || 'TELEBIRR');
    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === userId) {
        pInfo.balance = result.remainingBalance;
        io.to(sockId).emit('balance_updated', { balance: result.remainingBalance });
      }
    }

    if (result.telegramId) {
      sendTelegramNotification(
        result.telegramId,
        `📤 የማውጣት ጥያቄዎ ተመዝግቧል!\n\n` +
        `💰 የተጠየቀው መጠን: ${withdrawAmount} ETB\n` +
        `📱 የሚላክበት: ${phoneNumber} (${method || 'TELEBIRR'})\n\n` +
        `አድሚኑ ልኮ እንዳጠናቀቀ ማረጋገጫ ይደርስዎታል!`
      );
    }

    res.json({ success: true, message: 'የማውጣት ጥያቄዎ በተሳካ ሁኔታ ተልኳል!', txRef: result.txRef, remainingBalance: result.remainingBalance });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==================== ADMIN MIDDLEWARE & ENDPOINTS ====================
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

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const stats = await DB.getAdminStats();
    const todayStats = await DB.getTodayFinancialStats();

    stats.onlinePlayers = activeSockets.size;
    stats.globalCommission = globalCommissionPercent;
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
    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === result.userId) {
        pInfo.balance = result.newBalance;
        io.to(sockId).emit('balance_updated', { balance: result.newBalance });
        io.to(sockId).emit('deposit_approved', {
          txId,
          amount: result.amount,
          message: `🎉 የ ${result.amount} ETB ማስገቢያ ጥያቄዎ ጸድቋል፤ ሒሳብዎ ላይ ገቢ ሆኗል!`
        });
      }
    }

    const botMsg = 
      `🎉 እንኳን ደስ አለዎት! ዲፖዚትዎ ጸድቋል!\n` +
      `🎁 የ ${result.amount} ETB ክፍያ ወደ ዋሌትዎ ገቢ ሆኗል!\n` +
      `💰 አጠቃላይ ባላንስዎ: ${result.newBalance} ETB\n\n` +
      `ለመጫወት ከታች ያለውን Play Now በተን ይጫኑ!`;

    sendTelegramNotification(result.telegramId, botMsg, true);
    res.json({ success: true, message: 'ማስገቢያው ጸድቋል፤ ለተጫዋቹ ገቢ ተደርጓል!' });
  } catch (err) {
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
        `📱 የተላከበት: ${result.phoneNumber} (${result.paymentMethod})\n\n` +
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

    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === result.userId) {
        pInfo.balance = result.newBalance;
        io.to(sockId).emit('balance_updated', { balance: result.newBalance });
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
  const { commission, beginnerStake, turboStake, vipStake } = req.body;
  if (commission !== undefined) globalCommissionPercent = parseInt(commission, 10);
  if (beginnerStake && rooms.Beginner) rooms.Beginner.stake = parseFloat(beginnerStake);
  if (turboStake && rooms.Turbo) rooms.Turbo.stake = parseFloat(turboStake);
  if (vipStake && rooms.VIP) rooms.VIP.stake = parseFloat(vipStake);

  broadcastRealRoomsStatus();
  res.json({ success: true, message: 'ቅንብሩ በተሳካ ሁኔታ ተቀይሯል!' });
});

app.post('/api/admin/adjust-balance', adminAuth, async (req, res) => {
  const { userId, amount, reason } = req.body;
  try {
    const newBalance = await DB.updateBalance(userId, parseFloat(amount), 'ADMIN_ADJUST', reason || 'Admin action');
    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === parseInt(userId, 10)) {
        pInfo.balance = newBalance;
        io.to(sockId).emit('balance_updated', { balance: newBalance });
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

app.post('/api/admin/room-control', adminAuth, (req, res) => {
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
    startRoomLobby(roomName);
  }

  broadcastRealRoomsStatus();
  res.json({ success: true, message: `${roomName} ${action} ተፈጽሟል!` });
});

app.post('/api/admin/broadcast', adminAuth, (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  io.emit('admin_broadcast', { message });
  res.json({ success: true, message: 'መልዕክቱ ለሁሉም ተጫዋቾች ተልኳል!' });
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
server.listen(PORT, () => {
  console.log(`🚀 Kokeb Live Bingo Server Running on port ${PORT}`);
});