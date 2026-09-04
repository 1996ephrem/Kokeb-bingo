// gameEngine.js
const RANGES = {
  B: [1, 15],
  I: [16, 30],
  N: [31, 45],
  G: [46, 60],
  O: [61, 75]
};

function generateCartela() {
  const keys = ['B', 'I', 'N', 'G', 'O'];
  const columns = keys.map(key => {
    const [min, max] = RANGES[key];
    const nums = [];
    while (nums.length < 5) {
      const r = Math.floor(Math.random() * (max - min + 1)) + min;
      if (!nums.includes(r)) nums.push(r);
    }
    return nums.sort((a, b) => a - b);
  });

  const card = [];
  for (let r = 0; r < 5; r++) {
    card[r] = [];
    for (let c = 0; c < 5; c++) {
      card[r][c] = (r === 2 && c === 2) ? '★' : columns[c][r];
    }
  }
  return card;
}

function generate100Cartelas() {
  const cartelas = {};
  for (let i = 1; i <= 100; i++) {
    cartelas[i] = generateCartela();
  }
  return cartelas;
}

function validateBingo(cardGrid, markedMatrix, calledNumbersSet) {
  const isCellValid = (r, c) => {
    return cardGrid[r][c] === '★' || calledNumbersSet.has(cardGrid[r][c]);
  };

  // 1. Check Rows
  for (let r = 0; r < 5; r++) {
    if (markedMatrix[r].every((val, c) => val && isCellValid(r, c))) return true;
  }

  // 2. Check Columns
  for (let c = 0; c < 5; c++) {
    if ([0, 1, 2, 3, 4].every(r => markedMatrix[r][c] && isCellValid(r, c))) return true;
  }

  // 3. Check Main Diagonal (\)
  if ([0, 1, 2, 3, 4].every(i => markedMatrix[i][i] && isCellValid(i, i))) return true;

  // 4. Check Anti-Diagonal (/)
  if ([0, 1, 2, 3, 4].every(i => markedMatrix[i][4 - i] && isCellValid(i, 4 - i))) return true;

  // 5. Check 4 Corners
  if (
    markedMatrix[0][0] && markedMatrix[0][4] &&
    markedMatrix[4][0] && markedMatrix[4][4] &&
    isCellValid(0, 0) && isCellValid(0, 4) &&
    isCellValid(4, 0) && isCellValid(4, 4)
  ) {
    return true;
  }

  return false;
}

module.exports = {
  generateCartela,
  generate100Cartelas,
  validateBingo
};