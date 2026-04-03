'use strict';

const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let mySeat = null;
let state = null;
let passSelection = [];

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const joinScreen    = document.getElementById('joinScreen');
const lobbyScreen   = document.getElementById('lobbyScreen');
const gameScreen    = document.getElementById('gameScreen');
const nameInput     = document.getElementById('nameInput');
const joinBtn       = document.getElementById('joinBtn');
const joinError     = document.getElementById('joinError');
const seatList      = document.getElementById('seatList');
const startBtn      = document.getElementById('startBtn');

const scoreList         = document.getElementById('scoreList');
const topName           = document.getElementById('topName');
const leftName          = document.getElementById('leftName');
const rightName         = document.getElementById('rightName');
const myNameEl          = document.getElementById('myName');
const topCards          = document.getElementById('topCards');
const leftCards         = document.getElementById('leftCards');
const rightCards        = document.getElementById('rightCards');
const trickCards        = document.getElementById('trickCards');
const phaseMsg          = document.getElementById('phaseMsg');
const myHand            = document.getElementById('myHand');

const passPanel         = document.getElementById('passPanel');
const passTitle         = document.getElementById('passTitle');
const passCount         = document.getElementById('passCount');
const confirmPassBtn    = document.getElementById('confirmPass');

const roundEndOverlay   = document.getElementById('roundEndOverlay');
const roundEndScores    = document.getElementById('roundEndScores');
const gameOverOverlay   = document.getElementById('gameOverOverlay');
const gameOverScores    = document.getElementById('gameOverScores');
const newGameBtn        = document.getElementById('newGameBtn');

// ─── Card helpers ─────────────────────────────────────────────────────────────
const SUIT_SYMBOL = { C: '♣', D: '♦', S: '♠', H: '♥' };
const RANK_DISPLAY = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };
const RED_SUITS = new Set(['H', 'D']);

function rankDisplay(card) {
  const r = card[0];
  return RANK_DISPLAY[r] || r;
}
function suitDisplay(card) {
  return SUIT_SYMBOL[card[1]];
}
function isRed(card) { return RED_SUITS.has(card[1]); }

function makeCardEl(card, { playable = false, small = false, onClick = null } = {}) {
  const el = document.createElement('div');
  el.className = 'card' + (isRed(card) ? ' red' : ' black') + (playable ? ' playable' : '') + (small ? ' trick-card' : '');
  el.dataset.card = card;

  const top = document.createElement('div');
  top.className = 'card-top';
  top.textContent = rankDisplay(card) + suitDisplay(card);

  const center = document.createElement('div');
  center.className = 'card-center';
  center.textContent = suitDisplay(card);

  const bot = document.createElement('div');
  bot.className = 'card-bot';
  bot.textContent = rankDisplay(card) + suitDisplay(card);

  el.appendChild(top);
  el.appendChild(center);
  el.appendChild(bot);

  if (onClick) el.addEventListener('click', onClick);
  return el;
}

function makeCardBack(vertical = false) {
  const el = document.createElement('div');
  el.className = 'card-back';
  if (vertical) el.style.width = '52px';
  return el;
}

// ─── Relative seat positions ──────────────────────────────────────────────────
// Given my seat (0-3), determine which seat is top, left, right
function relativeSeats(mySeat) {
  return {
    bottom: mySeat,
    left:   (mySeat + 3) % 4,
    top:    (mySeat + 2) % 4,
    right:  (mySeat + 1) % 4,
  };
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  if (!state) return;
  const s = state;
  const seats = relativeSeats(mySeat);

  // Names
  topName.textContent   = s.names[seats.top]   + (s.playerTypes && s.playerTypes[seats.top]   === 'ai' ? ' 🤖' : '');
  leftName.textContent  = s.names[seats.left]  + (s.playerTypes && s.playerTypes[seats.left]  === 'ai' ? ' 🤖' : '');
  rightName.textContent = s.names[seats.right] + (s.playerTypes && s.playerTypes[seats.right] === 'ai' ? ' 🤖' : '');
  myNameEl.textContent  = s.names[mySeat]      + (s.currentPlayer === mySeat ? ' ▶' : '');

  // Highlight current player names
  [{ id: 'topPlayer',   seat: seats.top },
   { id: 'leftPlayer',  seat: seats.left },
   { id: 'rightPlayer', seat: seats.right }].forEach(({ id, seat }) => {
    const el = document.getElementById(id);
    el.style.opacity = s.currentPlayer === seat ? '1' : '0.6';
  });

  // Score panel
  scoreList.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const row = document.createElement('div');
    row.className = 'score-row' + (i === mySeat ? ' me' : '');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = s.names[i];
    const scoreSpan = document.createElement('span');
    scoreSpan.textContent = s.scores[i] + (s.roundScores[i] ? ` (+${s.roundScores[i]})` : '');
    row.appendChild(nameSpan);
    row.appendChild(scoreSpan);
    scoreList.appendChild(row);
  }

  // Opponent card backs
  renderOpponentCards(topCards,   s.hands ? s.handCounts[seats.top]   : 0, false);
  renderOpponentCards(leftCards,  s.hands ? s.handCounts[seats.left]  : 0, true);
  renderOpponentCards(rightCards, s.hands ? s.handCounts[seats.right] : 0, true);

  // Trick
  trickCards.innerHTML = '';
  s.trick.forEach(({ seatIndex, card }) => {
    const slot = document.createElement('div');
    slot.className = 'trick-slot';
    const label = document.createElement('div');
    label.className = 'trick-player-label';
    label.textContent = s.names[seatIndex];
    const cardEl = makeCardEl(card, { small: true });
    slot.appendChild(label);
    slot.appendChild(cardEl);
    trickCards.appendChild(slot);
  });

  // Phase message
  renderPhaseMsg(s, seats);

  // My hand
  renderMyHand(s);

  // Pass panel
  if (s.phase === 'passing' && !s.pendingPass) {
    passPanel.classList.remove('hidden');
    const dirNames = { left: 'esquerda', right: 'direita', across: 'frente', none: '' };
    passTitle.textContent = `Escolha 3 cartas para passar para a ${dirNames[s.passDirectionName] || s.passDirectionName}`;
    passCount.textContent = `${passSelection.length} / 3 cartas selecionadas`;
    confirmPassBtn.disabled = passSelection.length !== 3;
  } else {
    passPanel.classList.add('hidden');
    passSelection = [];
  }

  // Overlays
  if (s.phase === 'roundEnd') {
    roundEndOverlay.classList.remove('hidden');
    gameOverOverlay.classList.add('hidden');
    roundEndScores.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const row = document.createElement('div');
      row.className = 'overlay-score-row';
      row.innerHTML = `<span>${s.names[i]}</span><span>Total: ${s.scores[i]}</span>`;
      roundEndScores.appendChild(row);
    }
  } else {
    roundEndOverlay.classList.add('hidden');
  }

  if (s.phase === 'gameOver') {
    gameOverOverlay.classList.remove('hidden');
    roundEndOverlay.classList.add('hidden');
    gameOverScores.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const row = document.createElement('div');
      row.className = 'overlay-score-row' + (i === s.winner ? ' winner' : '');
      row.innerHTML = `<span>${i === s.winner ? '🏆 ' : ''}${s.names[i]}</span><span>${s.scores[i]} pts</span>`;
      gameOverScores.appendChild(row);
    }
  } else if (s.phase !== 'roundEnd') {
    gameOverOverlay.classList.add('hidden');
  }
}

function renderOpponentCards(container, count, vertical) {
  container.innerHTML = '';
  const n = Math.min(count, 13);
  for (let i = 0; i < n; i++) {
    container.appendChild(makeCardBack(vertical));
  }
}

function renderPhaseMsg(s, seats) {
  if (s.phase === 'passing') {
    if (s.pendingPass) {
      phaseMsg.textContent = 'Aguardando outros jogadores passarem cartas…';
    } else {
      phaseMsg.textContent = 'Fase de passe — escolha 3 cartas';
    }
  } else if (s.phase === 'playing') {
    if (s.currentPlayer === mySeat) {
      phaseMsg.textContent = 'Sua vez! Escolha uma carta para jogar.';
    } else {
      phaseMsg.textContent = `Vez de ${s.names[s.currentPlayer]}…`;
    }
  } else {
    phaseMsg.textContent = '';
  }
}

function renderMyHand(s) {
  myHand.innerHTML = '';
  const isMyTurn = s.phase === 'playing' && s.currentPlayer === mySeat;
  const isPassing = s.phase === 'passing' && !s.pendingPass;
  const valid = new Set(s.validPlays || []);

  s.hand.forEach(card => {
    const playable = isMyTurn && valid.has(card);
    const el = makeCardEl(card, {
      playable,
      onClick: () => {
        if (isPassing) handlePassClick(card, el, s);
        else if (playable) socket.emit('playCard', { card });
      }
    });
    if (isPassing && passSelection.includes(card)) {
      el.classList.add('selected-pass');
    }
    myHand.appendChild(el);
  });
}


function handlePassClick(card, el, s) {
  if (passSelection.includes(card)) {
    passSelection = passSelection.filter(c => c !== card);
    el.classList.remove('selected-pass');
  } else if (passSelection.length < 3) {
    passSelection.push(card);
    el.classList.add('selected-pass');
  }
  passCount.textContent = `${passSelection.length} / 3 cartas selecionadas`;
  confirmPassBtn.disabled = passSelection.length !== 3;
}

// ─── Lobby render ─────────────────────────────────────────────────────────────
function renderLobby(s) {
  seatList.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    const num = document.createElement('span');
    num.className = 'seat-num';
    num.textContent = i + 1;
    const name = document.createElement('span');
    name.className = 'seat-name';
    name.textContent = s.names[i];
    const tag = document.createElement('span');
    if (i === mySeat) {
      tag.className = 'seat-you';
      tag.textContent = '(você)';
    } else if (!s.players || !s.players[i]) {
      tag.className = 'seat-ai';
      tag.textContent = '(vazio → IA)';
    } else {
      tag.className = 'seat-you';
      tag.textContent = '(conectado)';
    }
    row.appendChild(num);
    row.appendChild(name);
    row.appendChild(tag);
    seatList.appendChild(row);
  }
}

// ─── Socket events ────────────────────────────────────────────────────────────
socket.on('joined', ({ seatIndex }) => {
  mySeat = seatIndex;
  joinScreen.classList.add('hidden');
  lobbyScreen.classList.remove('hidden');
  gameScreen.classList.add('hidden');
});

socket.on('gameState', (s) => {
  state = s;
  passSelection = passSelection.filter(c => s.hand && s.hand.includes(c));

  if (s.phase === 'waiting') {
    joinScreen.classList.add('hidden');
    lobbyScreen.classList.remove('hidden');
    gameScreen.classList.add('hidden');
    renderLobby(s);
    return;
  }

  joinScreen.classList.add('hidden');
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  render();
});

socket.on('passSent', () => {
  passPanel.classList.add('hidden');
  passSelection = [];
});

socket.on('error', ({ message }) => {
  joinError.textContent = message;
});

// ─── UI events ────────────────────────────────────────────────────────────────
joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) { joinError.textContent = 'Digite seu nome'; return; }
  joinError.textContent = '';
  socket.emit('join', { name });
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

startBtn.addEventListener('click', () => {
  socket.emit('startGame');
});

confirmPassBtn.addEventListener('click', () => {
  if (passSelection.length !== 3) return;
  socket.emit('pass', { cards: passSelection });
});

newGameBtn.addEventListener('click', () => {
  socket.emit('newGame');
  gameOverOverlay.classList.add('hidden');
  joinScreen.classList.remove('hidden');
  gameScreen.classList.add('hidden');
  lobbyScreen.classList.add('hidden');
  mySeat = null;
  state = null;
  passSelection = [];
});
