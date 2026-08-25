// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const DB = require('./database');
const { generate100Cartelas, validateBingo } = require('./gameEngine');
const { verifyTelegramAuth } = require('./telegramAuth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Dynamic Bot Username Detection
let detectedBotUsername = process.env.BOT_USERNAME || 'KokebBingoBot';

// Automatically fetch your REAL Telegram bot username using BOT_TOKEN
async function autoDetectBotUsername() {
  if (!process.env.BOT_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (data.ok && data.result?.username) {
      detectedBotUsername = data.result.username;
      console.log(`[+] Auto-detected Telegram Bot: @${detectedBotUsername}`);
    }
  } catch (err) {
    console.error('Bot detection error:', err.message);
  }
}
autoDetectBotUsername();

const failedPinAttempts = new Map();
const activeSockets = new Map();

// Game Rooms Configuration
const rooms = {
  Beginner: createRoomState('Beginner', 10, 2500),
  Turbo: createRoomState('Turbo', 25, 1400),
  VIP: createRoomState('VIP', 100, 2500)
};

function createRoomState(name, stake, callSpeed) {
  return {
    name,
    stake,
    callSpeed,
    state: 'LOBBY',
    timer: 25,
    timerInterval: null,
    gameInterval: null,
    cartelas: generate100Cartelas(),
    takenCartelas: new Map(),
    calledNumbers: new Set(),
    uncalledNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
    drawnCount: 0,
    isPaused: false
  };
}

// LOBBY & ENGINE
function startRoomLobby(roomName) {
  const room = rooms[roomName];
  if (room.isPaused) return;

  room.state = 'LOBBY';
  room.timer = 25;
  room.calledNumbers.clear();
  room.uncalledNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
  room.drawnCount = 0;
  room.takenCartelas.clear();
  room.cartelas = generate100Cartelas();

  io.to(roomName).emit('room_reset', {
    roomName,
    cartelas: room.cartelas,
    timer: room.timer
  });

  if (room.timerInterval) clearInterval(room.timerInterval);

  room.timerInterval = setInterval(() => {
    if (room.isPaused) return;
    room.timer--;
    io.to(roomName).emit('lobby_timer_tick', { timer: room.timer });

    if (room.timer <= 0) {
      clearInterval(room.timerInterval);
      if (room.takenCartelas.size > 0) {
        startRoomGame(roomName);
      } else {
        startRoomLobby(roomName);
      }
    }
  }, 1000);
}

function startRoomGame(roomName) {
  const room = rooms[roomName];
  room.state = 'PLAYING';

  const totalPot = room.takenCartelas.size * room.stake;
  const houseRake = (totalPot * (parseInt(process.env.HOUSE_COMMISSION_PERCENT) || 10)) / 100;
  const prizePool = Math.floor(totalPot - houseRake);

  io.to(roomName).emit('game_started', {
    roomName,
    prizePool,
    totalCards: room.takenCartelas.size
  });

  if (room.gameInterval) clearInterval(room.gameInterval);

  room.gameInterval = setInterval(() => {
    if (room.isPaused) return;
    if (room.uncalledNumbers.length === 0 || room.state !== 'PLAYING') {
      clearInterval(room.gameInterval);
      endGame(roomName, null, 'Game finished. All 75 balls drawn!');
      return;
    }

    const randIdx = Math.floor(Math.random() * room.uncalledNumbers.length);
    const num = room.uncalledNumbers.splice(randIdx, 1)[0];
    room.calledNumbers.add(num);
    room.drawnCount++;

    let letter = num <= 15 ? 'B' : num <= 30 ? 'I' : num <= 45 ? 'N' : num <= 60 ? 'G' : 'O';

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
  room.state = 'FINISHED';
  if (room.gameInterval) clearInterval(room.gameInterval);

  if (winnerData) {
    await DB.saveGameRound(roomName, winnerData.username, winnerData.cartelaId, winnerData.prize, room.takenCartelas.size, room.drawnCount);
  }

  io.to(roomName).emit('game_finished', { winner: winnerData, message });

  setTimeout(() => { startRoomLobby(roomName); }, 5000);
}

Object.keys(rooms).forEach(name => startRoomLobby(name));

// WEBSOCKET EVENTS
io.on('connection', (socket) => {
  socket.on('auth_user', async ({ username, initData }) => {
    try {
      let telegramId = `demo_${socket.id.substring(0, 5)}`;
      let playerName = username || 'Player';

      if (initData && process.env.BOT_TOKEN) {
        const tgUser = verifyTelegramAuth(initData, process.env.BOT_TOKEN);
        if (tgUser) {
          telegramId = tgUser.id.toString();
          playerName = tgUser.username ? `@${tgUser.username}` : (tgUser.first_name + (tgUser.last_name ? ` ${tgUser.last_name}` : ''));
        }
      }

      const user = await DB.getOrCreateUser(telegramId, playerName, playerName);
      if (user.is_banned) {
        return socket.emit('error_message', '❌ የእርስዎ አካውንት ታግዷል!');
      }

      activeSockets.set(socket.id, {
        dbId: user.id,
        telegramId: user.telegram_id,
        username: user.username,
        balance: user.balance
      });

      // Send the REAL bot username to frontend
      socket.emit('auth_success', {
        id: user.id,
        username: user.username,
        balance: user.balance,
        botUsername: detectedBotUsername
      });
    } catch (err) {
      socket.emit('error_message', 'Authentication failed');
    }
  });

  socket.on('join_room', ({ roomName }) => {
    const room = rooms[roomName];
    if (!room) return;
    socket.join(roomName);
    socket.emit('room_snapshot', {
      roomName,
      state: room.state,
      timer: room.timer,
      stake: room.stake,
      cartelas: room.cartelas,
      takenCartelaIds: Array.from(room.takenCartelas.keys()),
      calledNumbers: Array.from(room.calledNumbers),
      prizePool: Math.floor(room.takenCartelas.size * room.stake * 0.9)
    });
  });

  socket.on('leave_room', ({ roomName }) => {
    socket.leave(roomName);
  });

  socket.on('buy_cartelas', async ({ roomName, cartelaIds }) => {
    const player = activeSockets.get(socket.id);
    const room = rooms[roomName];
    if (!player || !room || room.state !== 'LOBBY') return;

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
        room.takenCartelas.set(id, { socketId: socket.id, dbId: player.dbId, username: player.username, markedMatrix });
      });

      socket.emit('cartelas_bought_success', { balance: newBalance, boughtIds: cartelaIds });
      io.to(roomName).emit('cartelas_locked', {
        takenIds: Array.from(room.takenCartelas.keys()),
        totalTaken: room.takenCartelas.size,
        prizePool: Math.floor(room.takenCartelas.size * room.stake * 0.9)
      });
    } catch (err) {
      socket.emit('error_message', err.message || 'ግዢው አልተሳካም');
    }
  });

  socket.on('mark_cell', ({ roomName, cartelaId, r, c, state }) => {
    const room = rooms[roomName];
    if (!room || !room.takenCartelas.has(cartelaId)) return;
    const card = room.takenCartelas.get(cartelaId);
    if (card.socketId === socket.id) card.markedMatrix[r][c] = state;
  });

  socket.on('claim_bingo', async ({ roomName, cartelaId }) => {
    const player = activeSockets.get(socket.id);
    const room = rooms[roomName];
    if (!player || !room || room.state !== 'PLAYING') return;

    const cardInfo = room.takenCartelas.get(cartelaId);
    if (!cardInfo || cardInfo.socketId !== socket.id) return socket.emit('error_message', 'የተሳሳተ ካርቴላ ጥሪ ነው!');

    const cardGrid = room.cartelas[cartelaId];
    if (validateBingo(cardGrid, cardInfo.markedMatrix, room.calledNumbers)) {
      const totalPot = room.takenCartelas.size * room.stake;
      const prize = Math.floor(totalPot * 0.9);
      try {
        const updatedBalance = await DB.updateBalance(player.dbId, prize, 'WIN', roomName);
        player.balance = updatedBalance;
        socket.emit('balance_updated', { balance: updatedBalance });
        endGame(roomName, { username: player.username, cartelaId, prize }, `🎉 ቢንጎ! ${player.username} በካርቴላ #${cartelaId} ${prize} ETB አሸነፈ!`);
      } catch (dbErr) {}
    } else {
      socket.emit('error_message', 'ቢንጎ አልተሟላም! እባክዎን መስመሩን ያረጋግጡ።');
    }
  });

  socket.on('send_reaction', ({ roomName, emoji }) => {
    io.to(roomName).emit('broadcast_reaction', { emoji });
  });

  socket.on('disconnect', () => {
    activeSockets.delete(socket.id);
  });
});

// Admin PIN Middleware
async function adminAuth(req, res, next) {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (!pin) return res.status(401).json({ error: 'PIN required' });

  const isValid = await DB.verifyAdminPin(pin);
  if (isValid) return next();
  return res.status(401).json({ error: 'የተሳሳተ ፒን ቁጥር ነው!' });
}

// APIs
app.get('/api/bot-info', (req, res) => {
  res.json({ botUsername: detectedBotUsername });
});

app.post('/api/admin/verify-pin', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const attempt = failedPinAttempts.get(ip) || { count: 0, lockUntil: 0 };

  if (attempt.lockUntil > now) {
    const remMins = Math.ceil((attempt.lockUntil - now) / 60000);
    return res.status(429).json({ success: false, error: `🚨 አካውንቱ ተቆልፏል! ከ ${remMins} ደቂቃ በኋላ ይሞክሩ።` });
  }

  const { pin } = req.body;
  const isValid = await DB.verifyAdminPin(pin);

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

app.post('/api/admin/change-pin', adminAuth, async (req, res) => {
  const { oldPin, newPin } = req.body;
  if (!newPin || newPin.length < 4) return res.status(400).json({ error: 'አዲሱ ፒን ቢያንስ 4 ዲጂት መሆን አለበት!' });
  try {
    await DB.changeAdminPin(oldPin, newPin);
    res.json({ success: true, message: 'የአድሚን ፒን በተሳካ ሁኔታ ተቀይሯል!' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const stats = await DB.getAdminStats();
    stats.onlinePlayers = activeSockets.size;
    stats.activeRooms = {
      Beginner: { state: rooms.Beginner.state, cardsSold: rooms.Beginner.takenCartelas.size, speed: rooms.Beginner.callSpeed, isPaused: rooms.Beginner.isPaused },
      Turbo: { state: rooms.Turbo.state, cardsSold: rooms.Turbo.takenCartelas.size, speed: rooms.Turbo.callSpeed, isPaused: rooms.Turbo.isPaused },
      VIP: { state: rooms.VIP.state, cardsSold: rooms.VIP.takenCartelas.size, speed: rooms.VIP.callSpeed, isPaused: rooms.VIP.isPaused }
    };
    const users = await DB.getAllUsers(req.query.search);
    const games = await DB.getRecentGames();
    res.json({ stats, users, games });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/adjust-balance', adminAuth, async (req, res) => {
  const { userId, amount, reason } = req.body;
  try {
    const newBal = await DB.updateBalance(userId, parseFloat(amount), 'ADMIN_ADJUST', reason);
    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === userId) {
        pInfo.balance = newBal;
        io.to(sockId).emit('balance_updated', { balance: newBal });
      }
    }
    res.json({ success: true, newBalance: newBal });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/toggle-ban', adminAuth, async (req, res) => {
  const { userId } = req.body;
  try {
    await DB.toggleBanUser(userId);
    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === userId) {
        io.to(sockId).emit('error_message', '❌ አካውንትዎ በአድሚን ታግዷል!');
        const s = io.sockets.sockets.get(sockId);
        if (s) s.disconnect();
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/room-control', adminAuth, (req, res) => {
  const { roomName, action, value } = req.body;
  const room = rooms[roomName];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (action === 'TOGGLE_PAUSE') room.isPaused = !room.isPaused;
  else if (action === 'SET_SPEED') room.callSpeed = parseInt(value) || 2500;
  else if (action === 'FORCE_START' && room.state === 'LOBBY') {
    clearInterval(room.timerInterval);
    startRoomGame(roomName);
  } else if (action === 'RESTART_LOBBY') {
    if (room.gameInterval) clearInterval(room.gameInterval);
    startRoomLobby(roomName);
  }
  res.json({ success: true, roomState: room.state, isPaused: room.isPaused, speed: room.callSpeed });
});

app.post('/api/admin/broadcast', adminAuth, (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  io.emit('error_message', `📢 [ADMIN]: ${message}`);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Kokeb Live Bingo Server Running on http://localhost:${PORT}`);
  console.log(`👑 Admin Dashboard: http://localhost:${PORT}/admin.html`);
});