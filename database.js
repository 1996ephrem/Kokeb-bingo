// database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'bingo.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('[-] Database connection error:', err.message);
  else console.log('[+] Connected to SQLite Database (bingo.db)');
});

db.serialize(() => {
  // Users Table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE,
      username TEXT,
      first_name TEXT,
      balance REAL DEFAULT 1000.0,
      is_banned INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Transactions Ledger
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT, -- 'DEPOSIT', 'WITHDRAW', 'BET', 'WIN', 'ADMIN_ADJUST'
      amount REAL,
      status TEXT DEFAULT 'COMPLETED', -- 'PENDING', 'COMPLETED', 'REJECTED'
      reference TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

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
});

const DB = {
  getOrCreateUser: (telegramId, username, firstName) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, row) => {
        if (err) return reject(err);
        if (row) return resolve(row);

        const stmt = db.prepare('INSERT INTO users (telegram_id, username, first_name, balance) VALUES (?, ?, ?, ?)');
        stmt.run(telegramId, username || 'Player', firstName || 'User', 1000.0, function (insertErr) {
          if (insertErr) return reject(insertErr);
          db.get('SELECT * FROM users WHERE id = ?', [this.lastID], (fetchErr, newUser) => {
            if (fetchErr) return reject(fetchErr);
            resolve(newUser);
          });
        });
      });
    });
  },

  updateBalance: (userId, amountChange, type, reference = null) => {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.get('SELECT balance, is_banned FROM users WHERE id = ?', [userId], (err, user) => {
          if (err || !user) { db.run('ROLLBACK'); return reject(err || new Error('User not found')); }
          if (user.is_banned) { db.run('ROLLBACK'); return reject(new Error('User is banned')); }

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

  // ===== ADMIN ADVANCED CONTROLS =====
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
      const query = search ? 'SELECT * FROM users WHERE username LIKE ? OR telegram_id LIKE ? ORDER BY id DESC LIMIT 50' : 'SELECT * FROM users ORDER BY id DESC LIMIT 50';
      const params = search ? [`%${search}%`, `%${search}%`] : [];
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
        resolve(true);
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

  getPendingRequests: () => {
    return new Promise((resolve, reject) => {
      db.all(`SELECT t.*, u.username FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.status = 'PENDING' ORDER BY t.id DESC`, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  }
};

module.exports = DB;