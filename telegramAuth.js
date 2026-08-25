// telegramAuth.js
const crypto = require('crypto');

function verifyTelegramAuth(initData, botToken) {
  if (!initData || !botToken) return null;

  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const dataCheckString = Array.from(urlParams.entries())
      .map(([key, val]) => `${key}=${val}`)
      .sort()
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (calculatedHash === hash) {
      const userJSON = urlParams.get('user');
      return userJSON ? JSON.parse(userJSON) : null;
    }
  } catch (err) {
    console.error('Telegram validation error:', err.message);
  }
  return null;
}

module.exports = { verifyTelegramAuth };