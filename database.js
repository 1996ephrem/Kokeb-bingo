// database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const dbPath = path.resolve(__dirname, 'bingo.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('[-] Database connection error:', err.message);
  else console.log('[+] Connected to SQLite Database (bingo.db)');
});

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

db.serialize(() => {
  // Users Table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE,
      username TEXT,
      first_name TEXT,
      phone_number TEXT,
      balance REAL DEFAULT 10.0,
      is_banned INTEGER DEFAULT 0,
      referred_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run("ALTER TABLE users ADD COLUMN phone_number TEXT", () => {});
  db.run("ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0", () => {});
  db.run("ALTER TABLE users ADD COLUMN referred_by TEXT", () => {});

  // Transactions Ledger
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT, -- 'DEPOSIT', 'WITHDRAW', 'BET', 'WIN', 'SPIN_REWARD', 'ADMIN_ADJUST'
      amount REAL,
      status TEXT DEFAULT 'COMPLETED', -- 'PENDING', 'COMPLETED', 'REJECTED'
      reference TEXT,
      phone_number TEXT,
      payment_method TEXT DEFAULT 'TELEBIRR',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  db.run("ALTER TABLE transactions ADD COLUMN phone_number TEXT", () => {});
  db.run("ALTER TABLE transactions ADD COLUMN payment_method TEXT DEFAULT 'TELEBIRR'", () => {});

  // Game Rounds History
  db.run(`
    CREATE TABLE IF NOT EXISTS game_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_name TEXT,
      winner_username TEXT,
      winner_cartela_id INTEGER,
      prize_pool REAL,
      total_cartelas INTEGER,
      called_balls_count INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Admin Config Table
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      salt TEXT
    )
  `);

  // Default Admin PIN 1234
  db.get("SELECT * FROM admin_config WHERE key = 'admin_pin'", (err, row) => {
    if (!row) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword("1234", salt);
      db.run("INSERT INTO admin_config (key, value, salt) VALUES ('admin_pin', ?, ?)", [hash, salt]);
    }
  });
});

const DB = {
  getOrCreateUser: (telegramId, username, firstName) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, row) => {
        if (err) return reject(err);
        if (row) return resolve(row);

        const stmt = db.prepare('INSERT INTO users (telegram_id, username, first_name, balance, is_banned) VALUES (?, ?, ?, 10.0, 0)');
        stmt.run(telegramId, username || 'Player', firstName || 'User', function (insertErr) {
          if (insertErr) return reject(insertErr);
          db.get('SELECT * FROM users WHERE id = ?', [this.lastID], (fetchErr, newUser) => {
            if (fetchErr) return reject(fetchErr);
            resolve(newUser);
          });
        });
      });
    });
  },

  registerVerifiedPhone: (telegramId, username, firstName, phoneNumber, refBy = null) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
        if (err) return reject(err);

        if (user) {
          db.run('UPDATE users SET phone_number = ?, username = ?, first_name = ? WHERE telegram_id = ?',
            [phoneNumber, username || user.username, firstName || user.first_name, telegramId],
            (uErr) => {
              if (uErr) return reject(uErr);
              resolve({ ...user, phone_number: phoneNumber, isNew: false });
            }
          );
        } else {
          db.run(
            'INSERT INTO users (telegram_id, username, first_name, phone_number, balance, is_banned, referred_by) VALUES (?, ?, ?, ?, 10.0, 0, ?)',
            [telegramId, username || 'Player', firstName || 'User', phoneNumber, refBy],
            function (iErr) {
              if (iErr) return reject(iErr);
              resolve({ id: this.lastID, telegram_id: telegramId, username, phone_number: phoneNumber, balance: 10.0, isNew: true });
            }
          );
        }
      });
    });
  },

  updateBalance: (userId, amountChange, type, reference = null) => {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.get('SELECT balance, is_banned FROM users WHERE id = ?', [userId], (err, user) => {
          if (err || !user) { db.run('ROLLBACK'); return reject(err || new Error('User not found')); }
          if (user.is_banned === 1) { db.run('ROLLBACK'); return reject(new Error('❌ ተጠቃሚው ታግዷል!')); }

          const newBalance = user.balance + amountChange;
          if (newBalance < 0) { db.run('ROLLBACK'); return reject(new Error('Insufficient balance')); }

          db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId], (upErr) => {
            if (upErr) { db.run('ROLLBACK'); return reject(upErr); }
            db.run(
              'INSERT INTO transactions (user_id, type, amount, status, reference) VALUES (?, ?, ?, ?, ?)',
              [userId, type, amountChange, 'COMPLETED', reference],
              (txErr) => {
                if (txErr) { db.run('ROLLBACK'); return reject(txErr); }
                db.run('COMMIT');
                resolve(newBalance);
              }
            );
          });
        });
      });
    });
  },

  requestDeposit: (userId, amount, phoneNumber, txRef, paymentMethod = 'TELEBIRR') => {
    return new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO transactions (user_id, type, amount, status, reference, phone_number, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, 'DEPOSIT', amount, 'PENDING', txRef, phoneNumber, paymentMethod],
        function (err) {
          if (err) return reject(err);
          resolve({ success: true, txId: this.lastID });
        }
      );
    });
  },

  requestWithdrawal: (userId, amount, phoneNumber, paymentMethod = 'TELEBIRR') => {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.get('SELECT balance, is_banned FROM users WHERE id = ?', [userId], (err, user) => {
          if (err || !user) { db.run('ROLLBACK'); return reject(err || new Error('User not found')); }
          if (user.is_banned === 1) { db.run('ROLLBACK'); return reject(new Error('❌ ተጠቃሚው ታግዷል!')); }
          if (user.balance < amount) { db.run('ROLLBACK'); return reject(new Error('በቂ ሒሳብ የለዎትም!')); }

          const txRef = 'CW_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
          db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, userId], (upErr) => {
            if (upErr) { db.run('ROLLBACK'); return reject(upErr); }
            db.run(
              'INSERT INTO transactions (user_id, type, amount, status, reference, phone_number, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [userId, 'WITHDRAW', -amount, 'PENDING', txRef, phoneNumber, paymentMethod],
              (txErr) => {
                if (txErr) { db.run('ROLLBACK'); return reject(txErr); }
                db.run('COMMIT');
                resolve({ success: true, txRef, remainingBalance: user.balance - amount });
              }
            );
          });
        });
      });
    });
  },

  getUserTransactions: (userId) => {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM transactions WHERE user_id = ? AND type IN ("DEPOSIT", "WITHDRAW") ORDER BY id DESC LIMIT 15',
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  },

  getPendingDeposits: () => {
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT t.*, COALESCE(u.username, 'Player') as username, u.telegram_id, u.phone_number as user_registered_phone 
        FROM transactions t 
        LEFT JOIN users u ON t.user_id = u.id 
        WHERE t.type = 'DEPOSIT' AND t.status = 'PENDING' 
        ORDER BY t.id DESC
      `, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  },

  approveDeposit: (txId) => {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.get('SELECT * FROM transactions WHERE id = ? AND status = "PENDING" AND type = "DEPOSIT"', [txId], (err, tx) => {
          if (err || !tx) { db.run('ROLLBACK'); return reject(err || new Error('Transaction not found')); }

          db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [tx.amount, tx.user_id], (upErr) => {
            if (upErr) { db.run('ROLLBACK'); return reject(upErr); }
            db.run("UPDATE transactions SET status = 'COMPLETED' WHERE id = ?", [txId], (inErr) => {
              if (inErr) { db.run('ROLLBACK'); return reject(inErr); }
              db.run('COMMIT');
              resolve({ success: true, userId: tx.user_id, amount: tx.amount });
            });
          });
        });
      });
    });
  },

  rejectDeposit: (txId) => {
    return new Promise((resolve, reject) => {
      db.run("UPDATE transactions SET status = 'REJECTED' WHERE id = ? AND status = 'PENDING'", [txId], function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      });
    });
  },

  getPendingWithdrawals: () => {
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT t.*, COALESCE(u.username, 'Player') as username, u.telegram_id, u.balance as current_user_balance 
        FROM transactions t 
        LEFT JOIN users u ON t.user_id = u.id 
        WHERE t.type = 'WITHDRAW' AND t.status = 'PENDING' 
        ORDER BY t.id DESC
      `, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  },

  approveWithdrawal: (txId) => {
    return new Promise((resolve, reject) => {
      db.run("UPDATE transactions SET status = 'COMPLETED' WHERE id = ? AND status = 'PENDING'", [txId], function(err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      });
    });
  },

  rejectWithdrawal: (txId) => {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.get('SELECT * FROM transactions WHERE id = ? AND status = "PENDING"', [txId], (err, tx) => {
          if (err || !tx) { db.run('ROLLBACK'); return reject(err || new Error('Transaction not found')); }

          db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [Math.abs(tx.amount), tx.user_id], (upErr) => {
            if (upErr) { db.run('ROLLBACK'); return reject(upErr); }
            db.run("UPDATE transactions SET status = 'REJECTED' WHERE id = ?", [txId], (inErr) => {
              if (inErr) { db.run('ROLLBACK'); return reject(inErr); }
              db.run('COMMIT');
              resolve(true);
            });
          });
        });
      });
    });
  },

  getTodayFinancialStats: () => {
    return new Promise((resolve, reject) => {
      const today = new Date().toISOString().split('T')[0];
      db.get(`
        SELECT 
          COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'COMPLETED' THEN amount ELSE 0 END), 0) as today_deposits,
          COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'COMPLETED' THEN ABS(amount) ELSE 0 END), 0) as today_withdrawals
        FROM transactions 
        WHERE DATE(created_at) = DATE(?)
      `, [today], (err, row) => {
        if (err) return reject(err);

        db.get(`
          SELECT 
            COALESCE(SUM(prize_pool), 0) as today_payouts,
            COUNT(*) as today_rounds
          FROM game_rounds 
          WHERE DATE(created_at) = DATE(?)
        `, [today], (err2, gRow) => {
          if (err2) return reject(err2);
          const deposits = row.today_deposits;
          const payouts = gRow.today_payouts;
          const estProfit = Math.floor(payouts * 0.111);

          resolve({
            todayDeposits: deposits,
            todayWithdrawals: row.today_withdrawals,
            todayPayouts: payouts,
            todayRounds: gRow.today_rounds,
            todayProfit: estProfit
          });
        });
      });
    });
  },

  getTransactionArchive: (type = 'ALL', status = 'ALL', search = '') => {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT t.*, COALESCE(u.username, 'Player') as username, u.telegram_id 
        FROM transactions t 
        LEFT JOIN users u ON t.user_id = u.id 
        WHERE 1=1
      `;
      const params = [];

      if (type !== 'ALL') { query += ` AND t.type = ?`; params.push(type); }
      if (status !== 'ALL') { query += ` AND t.status = ?`; params.push(status); }
      if (search) {
        query += ` AND (u.username LIKE ? OR t.phone_number LIKE ? OR t.reference LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }

      query += ` ORDER BY t.id DESC LIMIT 100`;

      db.all(query, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  },

  getUserDetailedProfile: (userId) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) return reject(err || new Error('User not found'));

        db.get(`
          SELECT 
            COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'COMPLETED' THEN amount ELSE 0 END), 0) as total_deposited,
            COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'COMPLETED' THEN ABS(amount) ELSE 0 END), 0) as total_withdrawn,
            COALESCE(SUM(CASE WHEN type = 'BET' THEN ABS(amount) ELSE 0 END), 0) as total_bet_amount,
            COALESCE(SUM(CASE WHEN type = 'WIN' THEN amount ELSE 0 END), 0) as total_won_amount
          FROM transactions 
          WHERE user_id = ?
        `, [userId], (err2, stats) => {
          if (err2) return reject(err2);

          db.get('SELECT COUNT(*) as win_count FROM game_rounds WHERE winner_username = ?', [user.username], (err3, wRow) => {
            if (err3) return reject(err3);
            resolve({
              user,
              stats: {
                totalDeposited: stats.total_deposited,
                totalWithdrawn: stats.total_withdrawn,
                totalBet: stats.total_bet_amount,
                totalWon: stats.total_won_amount,
                winCount: wRow.win_count || 0
              }
            });
          });
        });
      });
    });
  },

  saveGameRound: (roomName, winnerUsername, winnerCartelaId, prizePool, totalCartelas, calledCount) => {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO game_rounds (room_name, winner_username, winner_cartela_id, prize_pool, total_cartelas, called_balls_count) 
        VALUES (?, ?, ?, ?, ?, ?)`,
        [roomName, winnerUsername, winnerCartelaId, prizePool, totalCartelas, calledCount],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });
  },

  getRealLeaderboard: () => {
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT 
          winner_username as username, 
          COUNT(*) as total_wins, 
          SUM(prize_pool) as total_won 
        FROM game_rounds 
        WHERE winner_username IS NOT NULL AND winner_username != ''
        GROUP BY winner_username 
        ORDER BY total_won DESC 
        LIMIT 10
      `, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  },

  getAdminStats: () => {
    return new Promise((resolve, reject) => {
      const stats = {};
      db.get('SELECT COUNT(*) as total_users, SUM(balance) as total_user_balance FROM users', (err, row) => {
        if (err) return reject(err);
        stats.totalUsers = row.total_users || 0;
        stats.totalUserBalance = row.total_user_balance || 0;

        db.get('SELECT COUNT(*) as total_rounds, SUM(prize_pool) as total_payouts, SUM(total_cartelas) as total_cartelas_sold FROM game_rounds', (err2, row2) => {
          if (err2) return reject(err2);
          stats.totalRounds = row2.total_rounds || 0;
          stats.totalPayouts = row2.total_payouts || 0;
          stats.totalCartelasSold = row2.total_cartelas_sold || 0;
          stats.estimatedProfit = Math.floor(stats.totalPayouts * 0.111);
          resolve(stats);
        });
      });
    });
  },

  getAllUsers: (search = '') => {
    return new Promise((resolve, reject) => {
      const query = search ? 'SELECT * FROM users WHERE username LIKE ? OR telegram_id LIKE ? OR phone_number LIKE ? ORDER BY id DESC LIMIT 50' : 'SELECT * FROM users ORDER BY id DESC LIMIT 50';
      const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];
      db.all(query, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  },

  toggleBanUser: (userId) => {
    return new Promise((resolve, reject) => {
      db.run('UPDATE users SET is_banned = CASE WHEN is_banned = 1 THEN 0 ELSE 1 END WHERE id = ?', [userId], function (err) {
        if (err) return reject(err);
        db.get('SELECT is_banned FROM users WHERE id = ?', [userId], (gErr, row) => {
          resolve(row ? row.is_banned : 1);
        });
      });
    });
  },

  getRecentGames: () => {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM game_rounds ORDER BY id DESC LIMIT 15', (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  },

  verifyAdminPin: (inputPin) => {
    return new Promise((resolve) => {
      db.get("SELECT * FROM admin_config WHERE key = 'admin_pin'", (err, row) => {
        if (err || !row) return resolve(false);
        const inputHash = hashPassword(inputPin, row.salt);
        resolve(inputHash === row.value);
      });
    });
  },

  changeAdminPin: (oldPin, newPin) => {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM admin_config WHERE key = 'admin_pin'", (err, row) => {
        if (err || !row) return reject(new Error('Config not found'));
        const oldHash = hashPassword(oldPin, row.salt);
        if (oldHash !== row.value) return reject(new Error('የቀድሞው ፒን ቁጥር የተሳሳተ ነው!'));

        const newSalt = crypto.randomBytes(16).toString('hex');
        const newHash = hashPassword(newPin, newSalt);
        db.run("UPDATE admin_config SET value = ?, salt = ? WHERE key = 'admin_pin'", [newHash, newSalt], (upErr) => {
          if (upErr) return reject(upErr);
          resolve(true);
        });
      });
    });
  }
};

module.exports = DB;