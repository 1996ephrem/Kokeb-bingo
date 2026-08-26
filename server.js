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

let detectedBotUsername = 'Kokeb_Bingo_Bot';
let globalCommissionPercent = parseInt(process.env.HOUSE_COMMISSION_PERCENT) || 10;

const failedPinAttempts = new Map();
const activeSockets = new Map();

// Game Rooms Configuration (Live Dynamic Config)
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
    timer: room.timer,
    stake: room.stake
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
  const houseRake = (totalPot * globalCommissionPercent) / 100;
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
    await DB.saveGameRound(
      roomName,
      winnerData.username,
      winnerData.cartelaId,
      winnerData.prize,
      room.takenCartelas.size,
      room.drawnCount
    );
  }

  io.to(roomName).emit('game_finished', { winner: winnerData, message });
  setTimeout(() => { startRoomLobby(roomName); }, 5000);
}

Object.keys(rooms).forEach(name => startRoomLobby(name));

// WEBSOCKET EVENTS
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
      
      if (user.is_banned === 1 || user.is_banned === '1') {
        socket.emit('account_banned', { message: '❌ የእርስዎ አካውንት በአድሚን ታግዷል!' });
        setTimeout(() => socket.disconnect(true), 800);
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
      prizePool: Math.floor(room.takenCartelas.size * room.stake * ((100 - globalCommissionPercent) / 100))
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
        room.takenCartelas.set(id, {
          socketId: socket.id,
          dbId: player.dbId,
          username: player.username,
          markedMatrix
        });
      });

      socket.emit('cartelas_bought_success', {
        balance: newBalance,
        boughtIds: cartelaIds
      });

      const totalPot = room.takenCartelas.size * room.stake;
      const prizePool = Math.floor(totalPot * ((100 - globalCommissionPercent) / 100));

      io.to(roomName).emit('cartelas_locked', {
        takenIds: Array.from(room.takenCartelas.keys()),
        totalTaken: room.takenCartelas.size,
        prizePool: prizePool
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
      const prize = Math.floor(totalPot * ((100 - globalCommissionPercent) / 100));
      try {
        const updatedBalance = await DB.updateBalance(player.dbId, prize, 'WIN', roomName);
        player.balance = updatedBalance;
        socket.emit('balance_updated', { balance: updatedBalance });
        endGame(
          roomName,
          { username: player.username, cartelaId, prize },
          `🎉 ቢንጎ! ${player.username} በካርቴላ #${cartelaId} ${prize} ETB አሸነፈ!`
        );
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

// ==================== REAL LEADERBOARD API ====================
app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaders = await DB.getRealLeaderboard();
    res.json({ success: true, leaders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== PAYMENT APIS ====================
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
    await DB.requestDeposit(userId, depositAmount, phoneNumber, txRef.trim(), method || 'TELEBIRR');
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

    res.json({ 
      success: true, 
      message: 'የማውጣት ጥያቄዎ በተሳካ ሁኔታ ተልኳል!', 
      txRef: result.txRef,
      remainingBalance: result.remainingBalance 
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==================== ADVANCED ADMIN APIS ====================
async function adminAuth(req, res, next) {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (!pin) return res.status(401).json({ error: 'PIN required' });
  const isValid = await DB.verifyAdminPin(pin);
  if (isValid) return next();
  return res.status(401).json({ error: 'የተሳሳተ ፒን ቁጥር ነው!' });
}

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

// Admin Pending Deposits
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
    
    // ለተጫዋቹ በሪል-ታይም ባላንሱንና የድል መልእክቱን ይልካል
    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === result.userId) {
        pInfo.balance += result.amount;
        io.to(sockId).emit('balance_updated', { balance: pInfo.balance });
        io.to(sockId).emit('deposit_approved', {
          txId: txId,
          amount: result.amount,
          message: `🎉 የ ${result.amount} ETB ማስገቢያ ጥያቄዎ ጸድቋል፤ ሒሳብዎ ላይ ገቢ ሆኗል!`
        });
      }
    }

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

// Admin Pending Withdrawals
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
    await DB.approveWithdrawal(txId);
    res.json({ success: true, message: 'ክፍያው ጸድቋል!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reject-withdrawal', adminAuth, async (req, res) => {
  const { txId } = req.body;
  try {
    await DB.rejectWithdrawal(txId);
    res.json({ success: true, message: 'ጥያቄው ውድቅ ተደርጎ ብሩ ለተጫዋቹ ተመልሷል!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Dashboard Overview & Today Stats
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

// Admin Transactions Archive (Search & Filter)
app.get('/api/admin/transactions-archive', adminAuth, async (req, res) => {
  const { type, status, search } = req.query;
  try {
    const list = await DB.getTransactionArchive(type, status, search);
    res.json({ success: true, transactions: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin User Detailed Profile
app.get('/api/admin/user-profile/:userId', adminAuth, async (req, res) => {
  try {
    const profile = await DB.getUserDetailedProfile(req.params.userId);
    res.json({ success: true, profile });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Admin Update Room Stake & Global Commission Rate
app.post('/api/admin/update-settings', adminAuth, (req, res) => {
  const { commission, beginnerStake, turboStake, vipStake } = req.body;
  if (commission) globalCommissionPercent = parseInt(commission) || 10;
  if (beginnerStake) rooms.Beginner.stake = parseInt(beginnerStake) || 10;
  if (turboStake) rooms.Turbo.stake = parseInt(turboStake) || 25;
  if (vipStake) rooms.VIP.stake = parseInt(vipStake) || 100;
  res.json({ success: true, message: 'የክፍሎች ዋጋ እና ኮሚሽን በተሳካ ሁኔታ ተቀይሯል!' });
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
    const isBanned = await DB.toggleBanUser(userId);
    for (const [sockId, pInfo] of activeSockets.entries()) {
      if (pInfo.dbId === userId) {
        if (isBanned === 1) {
          io.to(sockId).emit('account_banned', { message: '❌ የእርስዎ አካውንት በአድሚን ታግዷል!' });
          const s = io.sockets.sockets.get(sockId);
          if (s) s.disconnect(true);
        }
      }
    }
    res.json({ success: true, isBanned });
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
  console.log(`🚀 Kokeb Live Bingo Running on http://localhost:${PORT}`);
  console.log(`👑 Admin Dashboard: http://localhost:${PORT}/admin.html`);
});