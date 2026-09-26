// database.js
const { Pool } = require('pg');
const crypto = require('crypto');

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/bingo',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => {
  console.log('[+] Connected to Persistent PostgreSQL Database');
});

pool.on('error', (err) => {
  console.error('[-] PostgreSQL Pool Error:', err.message);
});

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 1000, 64, 'sha512').toString('hex');
}

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id TEXT UNIQUE,
        username TEXT,
        first_name TEXT,
        phone_number TEXT,
        referred_by TEXT,
        balance NUMERIC(14, 2) DEFAULT 0.0,
        is_banned INT DEFAULT 0,
        checkin_streak INT DEFAULT 0,
        last_checkin_date TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT;

      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        type TEXT,
        amount NUMERIC(14, 2),
        status TEXT DEFAULT 'COMPLETED',
        reference TEXT,
        phone_number TEXT,
        payment_method TEXT DEFAULT 'TELEBIRR',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS game_rounds (
        id SERIAL PRIMARY KEY,
        room_name TEXT,
        winner_username TEXT,
        winner_cartela_id INT,
        prize_pool NUMERIC(14, 2),
        total_cartelas INT,
        called_balls_count INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS admin_config (
        key TEXT PRIMARY KEY,
        value TEXT,
        salt TEXT
      );

      CREATE TABLE IF NOT EXISTS promo_codes (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        reward_amount NUMERIC(14, 2) NOT NULL,
        max_users INT DEFAULT 100,
        used_count INT DEFAULT 0,
        expires_at TIMESTAMP,
        is_active INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS promo_claims (
        id SERIAL PRIMARY KEY,
        promo_id INT REFERENCES promo_codes(id),
        user_id INT REFERENCES users(id),
        claimed_amount NUMERIC(14, 2),
        claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(promo_id, user_id)
      );
    `);

    const pinRes = await pool.query("SELECT * FROM admin_config WHERE key = 'admin_pin'");
    if (pinRes.rows.length === 0) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(process.env.ADMIN_PIN || "1234", salt);
      await pool.query("INSERT INTO admin_config (key, value, salt) VALUES ('admin_pin', $1, $2)", [hash, salt]);
    }
  } catch (err) {
    console.error('[-] Database initialization error:', err.message);
  }
}

initDB();

const DB = {
  getOrCreateUser: async (telegramId, username, firstName, referrerRef = null) => {
    const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);

    if (res.rows.length > 0) {
      const u = res.rows[0];
      if (!u.referred_by && referrerRef && u.telegram_id !== String(referrerRef) && String(u.id) !== String(referrerRef) && !u.phone_number) {
        await pool.query('UPDATE users SET referred_by = $1 WHERE id = $2', [String(referrerRef), u.id]);
        u.referred_by = String(referrerRef);
      }
      u.balance = parseFloat(u.balance);
      return u;
    }

    // አዲስ ተጠቃሚ 0.0 ETB ይዞ ይመዘገባል
    const insertRes = await pool.query(
      'INSERT INTO users (telegram_id, username, first_name, referred_by, balance, is_banned, checkin_streak) VALUES ($1, $2, $3, $4, 0.0, 0, 0) RETURNING *',
      [telegramId, username || 'Player', firstName || 'User', referrerRef ? String(referrerRef) : null]
    );
    const newUser = insertRes.rows[0];
    newUser.balance = parseFloat(newUser.balance);
    return newUser;
  },

  // 🚨 የተስተካከለ፡ ምንም አይነት የነጻ 10 ETB ጀማሪ ቦነስም ሆነ የ 5 ETB የሪፈራል ቦነስ አይሰጥም!
  registerVerifiedPhone: async (telegramId, username, firstName, phoneNumber) => {
    const phoneCheck = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber]);
    if (phoneCheck.rows.length > 0) {
      const existingUser = phoneCheck.rows[0];
      existingUser.balance = parseFloat(existingUser.balance);

      if (existingUser.telegram_id !== telegramId) {
        throw new Error('DUPLICATE_PHONE_OTHER_ACCOUNT');
      }

      return {
        user: existingUser,
        isNewBonus: false,
        alreadyRegistered: true
      };
    }

    const tgCheck = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    let currentUser = null;

    if (tgCheck.rows.length > 0) {
      const tgUser = tgCheck.rows[0];
      // ባላንስ አይጨመርም፤ ስልኩ ብቻ ይመዘገባል
      const upRes = await pool.query(
        'UPDATE users SET phone_number = $1, username = $2, first_name = $3 WHERE id = $4 RETURNING *',
        [phoneNumber, username || tgUser.username, firstName || tgUser.first_name, tgUser.id]
      );
      currentUser = upRes.rows[0];
    } else {
      const inRes = await pool.query(
        'INSERT INTO users (telegram_id, username, first_name, phone_number, balance, is_banned, checkin_streak) VALUES ($1, $2, $3, $4, 0.0, 0, 0) RETURNING *',
        [telegramId, username || 'Player', firstName || 'User', phoneNumber]
      );
      currentUser = inRes.rows[0];
    }

    currentUser.balance = parseFloat(currentUser.balance);

    return {
      user: currentUser,
      isNewBonus: false,
      alreadyRegistered: false
    };
  },

  claimDailyCheckinStreak: async (userId) => {
    const today = new Date().toISOString().split('T')[0];
    const yesterdayDate = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (uRes.rows.length === 0) throw new Error('User not found');
    const user = uRes.rows[0];
    user.balance = parseFloat(user.balance);

    if (user.is_banned === 1) throw new Error('❌ ተጠቃሚው ታግዷል!');
    if (user.last_checkin_date === today) throw new Error('ዛሬ የዕለቱን ቦነስ ወስደዋል! እባክዎን ነገ ይመለሱ።');

    let newStreak = 1;
    if (user.last_checkin_date === yesterdayDate) {
      newStreak = (user.checkin_streak || 0) + 1;
      if (newStreak > 7) newStreak = 7;
    }

    const rewardAmount = newStreak;
    const newBalance = user.balance + rewardAmount;

    await pool.query(
      'UPDATE users SET balance = $1, checkin_streak = $2, last_checkin_date = $3 WHERE id = $4',
      [newBalance, newStreak, today, userId]
    );

    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, reference) VALUES ($1, $2, $3, $4, $5)',
      [userId, 'SPIN_REWARD', rewardAmount, 'COMPLETED', `STREAK_DAY_${newStreak}`]
    );

    return { success: true, rewardAmount, newStreak, newBalance };
  },

  updateBalance: async (userId, amountChange, type, reference = null) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const uRes = await client.query('SELECT balance, is_banned FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (uRes.rows.length === 0) throw new Error('User not found');
      const user = uRes.rows[0];
      user.balance = parseFloat(user.balance);

      if (user.is_banned === 1) throw new Error('❌ ተጠቃሚው ታግዷል!');

      const newBalance = user.balance + amountChange;
      if (newBalance < 0) throw new Error('Insufficient balance');

      await client.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, userId]);
      await client.query(
        'INSERT INTO transactions (user_id, type, amount, status, reference) VALUES ($1, $2, $3, $4, $5)',
        [userId, type, amountChange, 'COMPLETED', reference]
      );
      await client.query('COMMIT');
      return newBalance;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  requestDeposit: async (userId, amount, phoneNumber, txRef, paymentMethod = 'TELEBIRR') => {
    const res = await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, reference, phone_number, payment_method) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [userId, 'DEPOSIT', amount, 'PENDING', txRef, phoneNumber, paymentMethod]
    );
    const uRes = await pool.query('SELECT telegram_id, username, first_name FROM users WHERE id = $1', [userId]);
    const user = uRes.rows[0] || {};
    return { 
      success: true, 
      txId: res.rows[0].id, 
      telegramId: user.telegram_id,
      name: user.first_name || user.username
    };
  },

  requestWithdrawal: async (userId, amount, phoneNumber, paymentMethod = 'TELEBIRR') => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const uRes = await client.query('SELECT username, balance, is_banned, telegram_id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (uRes.rows.length === 0) throw new Error('User not found');
      const user = uRes.rows[0];
      user.balance = parseFloat(user.balance);

      if (user.is_banned === 1) throw new Error('❌ ተጠቃሚው ታግዷል!');

      if (user.balance - amount < 25) {
        const maxAllowed = Math.max(0, Math.floor(user.balance - 25));
        throw new Error(`❌ ብር ሲያወጡ አካውንትዎ ላይ ቢያንስ 25 ETB ቀሪ ተቀማጭ መኖር አለበት! በአሁኑ ሰዓት ማውጣት የሚችሉት ከፍተኛው መጠን ${maxAllowed} ETB ነው።`);
      }

      const depRes = await client.query(
        "SELECT COALESCE(SUM(amount), 0) as total_deposited, COUNT(*) as dep_count FROM transactions WHERE user_id = $1 AND type = 'DEPOSIT' AND status = 'COMPLETED'",
        [userId]
      );
      const totalDeposited = parseFloat(depRes.rows[0].total_deposited) || 0;
      const depCount = parseInt(depRes.rows[0].dep_count, 10) || 0;

      if (totalDeposited < 50 || depCount === 0) {
        throw new Error('❌ ብር ለማውጣት መጀመሪያ ቢያንስ አንድ ጊዜ 50 ETB ማስገባት (Deposit ማድረግ) አለብዎት!');
      }

      const txRef = 'CW_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      const remainingBalance = user.balance - amount;

      await client.query('UPDATE users SET balance = $1 WHERE id = $2', [remainingBalance, userId]);
      await client.query(
        'INSERT INTO transactions (user_id, type, amount, status, reference, phone_number, payment_method) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [userId, 'WITHDRAW', -amount, 'PENDING', txRef, phoneNumber, paymentMethod]
      );

      await client.query('COMMIT');
      return { success: true, txRef, remainingBalance, telegramId: user.telegram_id };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  getUserTransactions: async (userId) => {
    const res = await pool.query(
      "SELECT * FROM transactions WHERE user_id = $1 AND type IN ('DEPOSIT', 'WITHDRAW', 'REFERRAL_BONUS', 'PROMO_BONUS') ORDER BY id DESC LIMIT 20",
      [userId]
    );
    return res.rows.map(r => ({ ...r, amount: parseFloat(r.amount) }));
  },

  getPendingDeposits: async () => {
    const res = await pool.query(`
      SELECT t.*, COALESCE(u.username, 'Player') as username, u.telegram_id, u.phone_number as user_registered_phone 
      FROM transactions t 
      LEFT JOIN users u ON t.user_id = u.id 
      WHERE t.type = 'DEPOSIT' AND t.status = 'PENDING' 
      ORDER BY t.id DESC
    `);
    return res.rows.map(r => ({ ...r, amount: parseFloat(r.amount) }));
  },

  approveDeposit: async (txId) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tRes = await client.query("SELECT * FROM transactions WHERE id = $1 AND status = 'PENDING' AND type = 'DEPOSIT' FOR UPDATE", [txId]);
      if (tRes.rows.length === 0) throw new Error('Transaction not found');
      const tx = tRes.rows[0];
      const amount = parseFloat(tx.amount);

      const uRes = await client.query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance, telegram_id, first_name, username',
        [amount, tx.user_id]
      );
      await client.query("UPDATE transactions SET status = 'COMPLETED' WHERE id = $1", [txId]);

      await client.query('COMMIT');
      const user = uRes.rows[0];
      return {
        success: true,
        userId: tx.user_id,
        amount,
        newBalance: parseFloat(user.balance),
        telegramId: user.telegram_id,
        name: user.first_name || user.username
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  rejectDeposit: async (txId) => {
    const res = await pool.query("UPDATE transactions SET status = 'REJECTED' WHERE id = $1 AND status = 'PENDING'", [txId]);
    return res.rowCount > 0;
  },

  getPendingWithdrawals: async () => {
    const res = await pool.query(`
      SELECT t.*, COALESCE(u.username, 'Player') as username, u.telegram_id, u.balance as current_user_balance 
      FROM transactions t 
      LEFT JOIN users u ON t.user_id = u.id 
      WHERE t.type = 'WITHDRAW' AND t.status = 'PENDING' 
      ORDER BY t.id DESC
    `);
    return res.rows.map(r => ({ 
      ...r, 
      amount: parseFloat(r.amount), 
      current_user_balance: parseFloat(r.current_user_balance),
      payment_method: r.payment_method || 'TELEBIRR'
    }));
  },

  approveWithdrawal: async (txId) => {
    const res = await pool.query(`
      UPDATE transactions 
      SET status = 'COMPLETED' 
      WHERE id = $1 AND status = 'PENDING'
      RETURNING user_id, amount, phone_number, payment_method
    `, [txId]);
    if (res.rows.length === 0) return null;
    const tx = res.rows[0];
    const uRes = await pool.query("SELECT telegram_id, balance FROM users WHERE id = $1", [tx.user_id]);
    return {
      success: true,
      userId: tx.user_id,
      amount: Math.abs(parseFloat(tx.amount)),
      phoneNumber: tx.phone_number,
      paymentMethod: tx.payment_method || 'TELEBIRR',
      telegramId: uRes.rows[0]?.telegram_id,
      balance: parseFloat(uRes.rows[0]?.balance)
    };
  },

  rejectWithdrawal: async (txId) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tRes = await client.query("SELECT * FROM transactions WHERE id = $1 AND status = 'PENDING' AND type = 'WITHDRAW' FOR UPDATE", [txId]);
      if (tRes.rows.length === 0) throw new Error('የማውጣት ጥያቄው አልተገኘም ወይም አስቀድሞ ተጠናቋል!');
      const tx = tRes.rows[0];
      const refundAmount = Math.abs(parseFloat(tx.amount));

      const uRes = await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance, telegram_id', [refundAmount, tx.user_id]);
      await client.query("UPDATE transactions SET status = 'REJECTED' WHERE id = $1", [txId]);

      await client.query('COMMIT');
      return {
        success: true,
        userId: tx.user_id,
        refundedAmount: refundAmount,
        newBalance: parseFloat(uRes.rows[0].balance),
        telegramId: uRes.rows[0].telegram_id
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  createPromoCode: async (code, rewardAmount, maxUsers = 50, expiryHours = 24) => {
    const cleanCode = code.trim().toUpperCase();
    const expiresAt = new Date(Date.now() + expiryHours * 3600 * 1000);
    const res = await pool.query(
      `INSERT INTO promo_codes (code, reward_amount, max_users, expires_at) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (code) DO UPDATE 
       SET reward_amount = $2, max_users = $3, expires_at = $4, is_active = 1, used_count = 0 
       RETURNING *`,
      [cleanCode, rewardAmount, maxUsers, expiresAt]
    );
    return res.rows[0];
  },

  getAllPromoCodes: async () => {
    const res = await pool.query('SELECT * FROM promo_codes ORDER BY id DESC LIMIT 50');
    return res.rows.map(r => ({
      ...r,
      reward_amount: parseFloat(r.reward_amount),
      is_expired: new Date(r.expires_at) < new Date()
    }));
  },

  deletePromoCode: async (id) => {
    await pool.query('DELETE FROM promo_claims WHERE promo_id = $1', [id]);
    const res = await pool.query('DELETE FROM promo_codes WHERE id = $1', [id]);
    return res.rowCount > 0;
  },

  claimPromoCode: async (userId, codeStr) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cleanCode = codeStr.trim().toUpperCase();

      const pRes = await client.query('SELECT * FROM promo_codes WHERE code = $1 FOR UPDATE', [cleanCode]);
      if (pRes.rows.length === 0) throw new Error('❌ የተሳሳተ ፕሮሞኮድ ነው!');
      const promo = pRes.rows[0];

      if (promo.is_active !== 1) throw new Error('❌ ይህ ፕሮሞኮድ በአድሚን ተዘግቷል!');
      if (new Date(promo.expires_at) < new Date()) throw new Error('⏳ የዚህ ፕሮሞኮድ ጊዜ አልቋል!');
      if (promo.used_count >= promo.max_users) throw new Error('❌ ይህ ፕሮሞኮድ ሙሉ በሙሉ አልቋል!');

      const cCheck = await client.query('SELECT id FROM promo_claims WHERE promo_id = $1 AND user_id = $2', [promo.id, userId]);
      if (cCheck.rows.length > 0) throw new Error('⚠️ ይህንን ፕሮሞኮድ አስቀድመው ተጠቅመዋል!');

      const reward = parseFloat(promo.reward_amount);

      const uRes = await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance', [reward, userId]);
      if (uRes.rows.length === 0) throw new Error('User not found');

      await client.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1', [promo.id]);
      await client.query(
        'INSERT INTO promo_claims (promo_id, user_id, claimed_amount) VALUES ($1, $2, $3)',
        [promo.id, userId, reward]
      );
      await client.query(
        'INSERT INTO transactions (user_id, type, amount, status, reference) VALUES ($1, $2, $3, $4, $5)',
        [userId, 'PROMO_BONUS', reward, 'COMPLETED', `PROMO_${cleanCode}`]
      );

      await client.query('COMMIT');
      return { success: true, rewardAmount: reward, newBalance: parseFloat(uRes.rows[0].balance), code: cleanCode };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  getTodayFinancialStats: async () => {
    const rowRes = await pool.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'COMPLETED' THEN amount ELSE 0 END), 0) as today_deposits,
        COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'COMPLETED' THEN ABS(amount) ELSE 0 END), 0) as today_withdrawals
      FROM transactions 
      WHERE DATE(created_at) = CURRENT_DATE
    `);

    const gRes = await pool.query(`
      SELECT 
        COALESCE(SUM(prize_pool), 0) as today_payouts,
        COUNT(*) as today_rounds
      FROM game_rounds 
      WHERE DATE(created_at) = CURRENT_DATE
    `);

    const deposits = parseFloat(rowRes.rows[0].today_deposits);
    const withdrawals = parseFloat(rowRes.rows[0].today_withdrawals);
    const payouts = parseFloat(gRes.rows[0].today_payouts);
    const rounds = parseInt(gRes.rows[0].today_rounds, 10);
    const estProfit = Math.floor(payouts * 0.15);

    return {
      todayDeposits: deposits,
      todayWithdrawals: withdrawals,
      todayPayouts: payouts,
      todayRounds: rounds,
      todayProfit: estProfit
    };
  },

  getTransactionArchive: async (type = 'ALL', status = 'ALL', search = '') => {
    let query = `
      SELECT t.*, COALESCE(u.username, 'Player') as username, u.telegram_id 
      FROM transactions t 
      LEFT JOIN users u ON t.user_id = u.id 
      WHERE 1=1
    `;
    const params = [];

    if (type !== 'ALL') {
      params.push(type);
      query += ` AND t.type = $${params.length}`;
    }
    if (status !== 'ALL') {
      params.push(status);
      query += ` AND t.status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (u.username ILIKE $${params.length} OR t.phone_number ILIKE $${params.length} OR t.reference ILIKE $${params.length})`;
    }

    query += ` ORDER BY t.id DESC LIMIT 100`;

    const res = await pool.query(query, params);
    return res.rows.map(r => ({ ...r, amount: parseFloat(r.amount) }));
  },

  getUserDetailedProfile: async (userId) => {
    const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (uRes.rows.length === 0) throw new Error('User not found');
    const user = uRes.rows[0];
    user.balance = parseFloat(user.balance);

    const statsRes = await pool.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'COMPLETED' THEN amount ELSE 0 END), 0) as total_deposited,
        COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'COMPLETED' THEN ABS(amount) ELSE 0 END), 0) as total_withdrawn,
        COALESCE(SUM(CASE WHEN type = 'BET' THEN ABS(amount) ELSE 0 END), 0) as total_bet_amount,
        COALESCE(SUM(CASE WHEN type = 'WIN' THEN amount ELSE 0 END), 0) as total_won_amount
      FROM transactions 
      WHERE user_id = $1
    `, [userId]);

    const winRes = await pool.query('SELECT COUNT(*) as win_count FROM game_rounds WHERE winner_username = $1', [user.username]);

    const stats = statsRes.rows[0];
    return {
      user,
      stats: {
        totalDeposited: parseFloat(stats.total_deposited),
        totalWithdrawn: parseFloat(stats.total_withdrawn),
        totalBet: parseFloat(stats.total_bet_amount),
        totalWon: parseFloat(stats.total_won_amount),
        winCount: parseInt(winRes.rows[0].win_count, 10) || 0
      }
    };
  },

  saveGameRound: async (roomName, winnerUsername, winnerCartelaId, prizePool, totalCartelas, calledCount) => {
    const res = await pool.query(
      `INSERT INTO game_rounds (room_name, winner_username, winner_cartela_id, prize_pool, total_cartelas, called_balls_count) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [roomName, winnerUsername, winnerCartelaId, prizePool, totalCartelas, calledCount]
    );
    return res.rows[0].id;
  },

  getRealLeaderboard: async () => {
    const res = await pool.query(`
      SELECT 
        winner_username as username, 
        COUNT(*) as total_wins, 
        SUM(prize_pool) as total_won 
      FROM game_rounds 
      WHERE winner_username IS NOT NULL AND winner_username != ''
      GROUP BY winner_username 
      ORDER BY total_won DESC 
      LIMIT 10
    `);
    return res.rows.map(r => ({
      username: r.username,
      total_wins: parseInt(r.total_wins, 10),
      total_won: parseFloat(r.total_won)
    }));
  },

  getAdminStats: async () => {
    const uRes = await pool.query('SELECT COUNT(*) as total_users, COALESCE(SUM(balance), 0) as total_user_balance FROM users');
    const gRes = await pool.query('SELECT COUNT(*) as total_rounds, COALESCE(SUM(prize_pool), 0) as total_payouts, COALESCE(SUM(total_cartelas), 0) as total_cartelas_sold FROM game_rounds');

    const totalUsers = parseInt(uRes.rows[0].total_users, 10);
    const totalUserBalance = parseFloat(uRes.rows[0].total_user_balance);
    const totalRounds = parseInt(gRes.rows[0].total_rounds, 10);
    const totalPayouts = parseFloat(gRes.rows[0].total_payouts);
    const totalCartelasSold = parseInt(gRes.rows[0].total_cartelas_sold, 10);
    const estimatedProfit = Math.floor(totalPayouts * 0.15);

    return {
      totalUsers,
      totalUserBalance,
      totalRounds,
      totalPayouts,
      totalCartelasSold,
      estimatedProfit
    };
  },

  getAllUsers: async (search = '') => {
    let query = 'SELECT * FROM users';
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      query += ' WHERE username ILIKE $1 OR telegram_id ILIKE $1 OR phone_number ILIKE $1';
    }
    query += ' ORDER BY id DESC LIMIT 50';

    const res = await pool.query(query, params);
    return res.rows.map(r => ({ ...r, balance: parseFloat(r.balance) }));
  },

  toggleBanUser: async (userId) => {
    const res = await pool.query(
      'UPDATE users SET is_banned = CASE WHEN is_banned = 1 THEN 0 ELSE 1 END WHERE id = $1 RETURNING is_banned',
      [userId]
    );
    return res.rows[0].is_banned;
  },

  getRecentGames: async () => {
    const res = await pool.query('SELECT * FROM game_rounds ORDER BY id DESC LIMIT 15');
    return res.rows.map(r => ({ ...r, prize_pool: parseFloat(r.prize_pool) }));
  },

  verifyAdminPin: async (inputPin) => {
    const res = await pool.query("SELECT * FROM admin_config WHERE key = 'admin_pin'");
    if (res.rows.length === 0) return false;
    const row = res.rows[0];
    const inputHash = hashPassword(String(inputPin), row.salt);
    return inputHash === row.value;
  },

  changeAdminPin: async (oldPin, newPin) => {
    const res = await pool.query("SELECT * FROM admin_config WHERE key = 'admin_pin'");
    if (res.rows.length === 0) throw new Error('Config not found');
    const row = res.rows[0];
    const oldHash = hashPassword(String(oldPin), row.salt);
    if (oldHash !== row.value) throw new Error('የቀድሞው ፒን ቁጥር የተሳሳተ ነው!');

    const newSalt = crypto.randomBytes(16).toString('hex');
    const newHash = hashPassword(String(newPin), newSalt);
    await pool.query("UPDATE admin_config SET value = $1, salt = $2 WHERE key = 'admin_pin'", [newHash, newSalt]);
    return true;
  }
};

module.exports = DB;