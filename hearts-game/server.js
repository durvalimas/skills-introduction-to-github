'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Card helpers ────────────────────────────────────────────────────────────

const SUITS = ['C', 'D', 'S', 'H']; // Clubs, Diamonds, Spades, Hearts
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

function makeCard(rank, suit) {
  return `${rank}${suit}`;
}

function cardRank(card) {
  return RANKS.indexOf(card[0]);
}

function cardSuit(card) {
  return card[1];
}

function cardPoints(card) {
  if (cardSuit(card) === 'H') return 1;
  if (card === 'QS') return 13;
  return 0;
}

function makeDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push(makeCard(r, s));
    }
  }
  return deck;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function deal() {
  const deck = shuffle(makeDeck());
  return [
    deck.slice(0, 13).sort(sortCards),
    deck.slice(13, 26).sort(sortCards),
    deck.slice(26, 39).sort(sortCards),
    deck.slice(39, 52).sort(sortCards),
  ];
}

function sortCards(a, b) {
  const suitOrder = { C: 0, D: 1, S: 2, H: 3 };
  if (suitOrder[cardSuit(a)] !== suitOrder[cardSuit(b)]) {
    return suitOrder[cardSuit(a)] - suitOrder[cardSuit(b)];
  }
  return cardRank(a) - cardRank(b);
}

// ─── Valid plays ─────────────────────────────────────────────────────────────

function validPlays(hand, trick, heartsBroken, isFirstTrick) {
  if (trick.length === 0) {
    // Leading a trick
    if (isFirstTrick) {
      return hand.filter(c => c === '2C');
    }
    if (!heartsBroken) {
      const nonHearts = hand.filter(c => cardSuit(c) !== 'H');
      return nonHearts.length > 0 ? nonHearts : hand;
    }
    return hand;
  }

  const ledSuit = cardSuit(trick[0].card);
  const followSuit = hand.filter(c => cardSuit(c) === ledSuit);
  if (followSuit.length > 0) return followSuit;

  if (isFirstTrick) {
    // Can't play hearts or QS on first trick if alternatives exist
    const safe = hand.filter(c => cardSuit(c) !== 'H' && c !== 'QS');
    return safe.length > 0 ? safe : hand;
  }

  return hand;
}

// ─── AI logic ────────────────────────────────────────────────────────────────

function aiChoosePass(hand) {
  // Pass 3 highest-point cards (QS, high hearts, high spades)
  const scored = hand.map(c => ({
    card: c,
    score: c === 'QS' ? 100 : cardSuit(c) === 'H' ? 10 + cardRank(c) : cardSuit(c) === 'S' ? cardRank(c) : 0
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(x => x.card);
}

function aiChooseCard(hand, trick, heartsBroken, isFirstTrick) {
  const valid = validPlays(hand, trick, heartsBroken, isFirstTrick);

  if (trick.length === 0) {
    // Lead the lowest non-heart if possible
    const nonH = valid.filter(c => cardSuit(c) !== 'H').sort(sortCards);
    return nonH.length > 0 ? nonH[0] : valid.sort(sortCards)[0];
  }

  const ledSuit = cardSuit(trick[0].card);
  const following = valid.filter(c => cardSuit(c) === ledSuit);

  if (following.length > 0) {
    // Determine highest card currently winning
    const maxRank = Math.max(...trick.filter(t => cardSuit(t.card) === ledSuit).map(t => cardRank(t.card)));
    // If last to play, try to win if safe
    const higher = following.filter(c => cardRank(c) > maxRank);
    const lower = following.filter(c => cardRank(c) <= maxRank);
    // Always dump if we have lower cards
    if (lower.length > 0) return lower[lower.length - 1]; // highest safe card below winner
    // Must win; pick lowest winner
    return higher.sort(sortCards)[0];
  }

  // Discarding – dump QS first, then highest hearts, then highest cards
  const qs = valid.find(c => c === 'QS');
  if (qs) return qs;
  const hearts = valid.filter(c => cardSuit(c) === 'H').sort(sortCards);
  if (hearts.length > 0) return hearts[hearts.length - 1]; // highest heart
  const sorted = valid.slice().sort(sortCards);
  return sorted[sorted.length - 1]; // highest card
}

// ─── Game state ───────────────────────────────────────────────────────────────

let game = null;

function createGame() {
  return {
    players: [null, null, null, null], // socket ids or 'ai'
    names: ['Jogador 1', 'Jogador 2', 'Jogador 3', 'Jogador 4'],
    hands: [[], [], [], []],
    scores: [0, 0, 0, 0],
    roundScores: [0, 0, 0, 0],
    tricksTaken: [[], [], [], []],
    trick: [],             // { seatIndex, card }
    currentPlayer: 0,
    heartsBroken: false,
    isFirstTrick: true,
    phase: 'waiting',      // waiting | passing | playing | roundEnd | gameOver
    passDirection: 0,      // 0=left,1=right,2=across,3=none
    passRound: 0,
    pendingPass: [null, null, null, null], // cards each player chose to pass
    gameOver: false,
    winner: null,
  };
}

function resetRound(g) {
  const hands = deal();
  g.hands = hands;
  g.roundScores = [0, 0, 0, 0];
  g.tricksTaken = [[], [], [], []];
  g.trick = [];
  g.heartsBroken = false;
  g.isFirstTrick = true;
  g.pendingPass = [null, null, null, null];
  // Find who has 2C
  for (let i = 0; i < 4; i++) {
    if (g.hands[i].includes('2C')) {
      g.currentPlayer = i;
      break;
    }
  }
  // Determine pass direction
  const directions = ['left', 'right', 'across', 'none'];
  g.passDirectionName = directions[g.passRound % 4];
  if (g.passDirectionName !== 'none') {
    g.phase = 'passing';
  } else {
    g.phase = 'playing';
  }
}

function passOffset(dirName) {
  return { left: 1, right: 3, across: 2, none: 0 }[dirName];
}

function broadcastState() {
  if (!game) return;
  for (let i = 0; i < 4; i++) {
    const sid = game.players[i];
    if (!sid || sid === 'ai') continue;
    const stateData = game.phase === 'waiting'
      ? Object.assign({}, buildLobbyState(), { seatIndex: i })
      : buildStateForPlayer(i);
    io.to(sid).emit('gameState', stateData);
  }
}

function buildStateForPlayer(seatIndex) {
  const g = game;
  return {
    seatIndex,
    hand: g.hands[seatIndex],
    handCounts: g.hands.map(h => h.length),
    scores: g.scores,
    roundScores: g.roundScores,
    trick: g.trick,
    currentPlayer: g.currentPlayer,
    heartsBroken: g.heartsBroken,
    isFirstTrick: g.isFirstTrick,
    phase: g.phase,
    passDirectionName: g.passDirectionName,
    passRound: g.passRound,
    pendingPass: g.pendingPass[seatIndex] ? true : false,
    names: g.names,
    playerTypes: g.players.map(p => (p === 'ai' ? 'ai' : (p ? 'human' : 'empty'))),
    gameOver: g.gameOver,
    winner: g.winner,
    trickCount: g.tricksTaken.reduce((s, t) => s + t.length, 0) / 4,
    validPlays: g.phase === 'playing' && g.currentPlayer === seatIndex
      ? validPlays(g.hands[seatIndex], g.trick, g.heartsBroken, g.isFirstTrick)
      : [],
  };
}

function buildLobbyState() {
  const g = game;
  return {
    phase: g.phase,
    names: g.names,
    players: g.players.map(p => (p === 'ai' ? 'ai' : (p ? 'human' : null))),
    scores: g.scores,
    roundScores: g.roundScores,
    trick: [],
    hand: [],
    handCounts: [0, 0, 0, 0],
    currentPlayer: 0,
    heartsBroken: false,
    isFirstTrick: true,
    passDirectionName: 'left',
    passRound: 0,
    pendingPass: false,
    playerTypes: g.players.map(p => (p === 'ai' ? 'ai' : (p ? 'human' : 'empty'))),
    gameOver: false,
    winner: null,
    trickCount: 0,
    validPlays: [],
  };
}

// ─── Game flow ────────────────────────────────────────────────────────────────

function startGameIfReady() {
  if (!game) return;
  if (game.phase !== 'waiting') return;
  // Fill empty slots with AI
  for (let i = 0; i < 4; i++) {
    if (!game.players[i]) {
      game.players[i] = 'ai';
    }
  }
  game.passRound = 0;
  resetRound(game);
  broadcastState();
  // If phase is passing and AI needs to pass, handle AI passes
  if (game.phase === 'passing') {
    setTimeout(handleAIPasses, 400);
  } else {
    setTimeout(handleAITurn, 400);
  }
}

function handleAIPasses() {
  if (!game || game.phase !== 'passing') return;
  for (let i = 0; i < 4; i++) {
    if (game.players[i] === 'ai' && !game.pendingPass[i]) {
      game.pendingPass[i] = aiChoosePass(game.hands[i]);
    }
  }
  checkAllPassed();
}

function checkAllPassed() {
  if (!game || game.phase !== 'passing') return;
  if (game.pendingPass.some(p => !p)) return;

  // Execute passes
  const dir = passOffset(game.passDirectionName);
  const newHands = game.hands.map(h => h.slice());
  for (let i = 0; i < 4; i++) {
    const target = (i + dir) % 4;
    newHands[target] = newHands[target].concat(game.pendingPass[i]);
  }
  for (let i = 0; i < 4; i++) {
    const passed = game.pendingPass[i];
    newHands[i] = newHands[i].filter(c => !passed.includes(c));
    newHands[i].sort(sortCards);
  }
  game.hands = newHands;
  game.phase = 'playing';

  // Find who has 2C
  for (let i = 0; i < 4; i++) {
    if (game.hands[i].includes('2C')) {
      game.currentPlayer = i;
      break;
    }
  }

  broadcastState();
  setTimeout(handleAITurn, 400);
}

function handleAITurn() {
  if (!game || game.phase !== 'playing') return;
  const cp = game.currentPlayer;
  if (game.players[cp] !== 'ai') return;

  const card = aiChooseCard(game.hands[cp], game.trick, game.heartsBroken, game.isFirstTrick);
  setTimeout(() => {
    playCard(cp, card);
  }, 600);
}

function playCard(seatIndex, card) {
  if (!game || game.phase !== 'playing') return;
  if (game.currentPlayer !== seatIndex) return;

  const hand = game.hands[seatIndex];
  if (!hand.includes(card)) return;

  const valid = validPlays(hand, game.trick, game.heartsBroken, game.isFirstTrick);
  if (!valid.includes(card)) return;

  // Remove from hand
  game.hands[seatIndex] = hand.filter(c => c !== card);

  // Break hearts
  if (cardSuit(card) === 'H' || card === 'QS') {
    game.heartsBroken = true;
  }

  game.trick.push({ seatIndex, card });

  if (game.trick.length === 4) {
    // Resolve trick
    resolveTrick();
  } else {
    game.currentPlayer = (seatIndex + 1) % 4;
    broadcastState();
    setTimeout(handleAITurn, 400);
  }
}

function resolveTrick() {
  const trick = game.trick;
  const ledSuit = cardSuit(trick[0].card);
  let winnerIdx = 0;
  for (let i = 1; i < 4; i++) {
    if (cardSuit(trick[i].card) === ledSuit && cardRank(trick[i].card) > cardRank(trick[winnerIdx].card)) {
      winnerIdx = i;
    }
  }
  const winner = trick[winnerIdx].seatIndex;
  const pts = trick.reduce((s, t) => s + cardPoints(t.card), 0);
  game.roundScores[winner] += pts;
  game.tricksTaken[winner] = game.tricksTaken[winner].concat(trick.map(t => t.card));
  game.isFirstTrick = false;
  game.trick = [];
  game.currentPlayer = winner;

  broadcastState();

  // Check if round over
  if (game.hands.every(h => h.length === 0)) {
    setTimeout(endRound, 800);
  } else {
    setTimeout(handleAITurn, 600);
  }
}

function endRound() {
  // Check shoot the moon
  for (let i = 0; i < 4; i++) {
    if (game.roundScores[i] === 26) {
      // Shot the moon! Others get 26
      for (let j = 0; j < 4; j++) {
        game.roundScores[j] = j === i ? 0 : 26;
      }
      break;
    }
  }

  for (let i = 0; i < 4; i++) {
    game.scores[i] += game.roundScores[i];
  }

  // Check game over
  const maxScore = Math.max(...game.scores);
  if (maxScore >= 100) {
    game.gameOver = true;
    const minScore = Math.min(...game.scores);
    game.winner = game.scores.indexOf(minScore);
    game.phase = 'gameOver';
    broadcastState();
    return;
  }

  game.phase = 'roundEnd';
  broadcastState();

  // Auto-start next round after delay
  setTimeout(() => {
    if (!game || game.phase !== 'roundEnd') return;
    game.passRound++;
    resetRound(game);
    broadcastState();
    if (game.phase === 'passing') {
      setTimeout(handleAIPasses, 400);
    } else {
      setTimeout(handleAITurn, 400);
    }
  }, 4000);
}

// ─── Socket.IO ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join', ({ name }) => {
    if (!game) {
      game = createGame();
    }

    if (game.phase !== 'waiting') {
      socket.emit('error', { message: 'Partida em andamento. Aguarde.' });
      return;
    }

    // Find empty seat
    const seat = game.players.findIndex(p => !p);
    if (seat === -1) {
      socket.emit('error', { message: 'Sala cheia.' });
      return;
    }

    game.players[seat] = socket.id;
    game.names[seat] = name || `Jogador ${seat + 1}`;
    socket.emit('joined', { seatIndex: seat });
    broadcastState();
    console.log(`${game.names[seat]} joined seat ${seat}`);
  });

  socket.on('startGame', () => {
    if (!game) return;
    if (game.phase !== 'waiting') return;
    // Only allow start if at least one human is in
    const hasHuman = game.players.some(p => p && p !== 'ai');
    if (!hasHuman) return;
    startGameIfReady();
  });

  socket.on('pass', ({ cards }) => {
    if (!game || game.phase !== 'passing') return;
    const seat = game.players.indexOf(socket.id);
    if (seat === -1) return;
    if (game.pendingPass[seat]) return; // already passed
    if (!Array.isArray(cards) || cards.length !== 3) return;
    // Validate cards belong to hand
    if (!cards.every(c => game.hands[seat].includes(c))) return;

    game.pendingPass[seat] = cards;
    socket.emit('passSent');
    broadcastState();
    // Fill any AI passes first, then check if all have passed
    handleAIPasses();
    // Always check if all have passed (AI may have already passed earlier)
    checkAllPassed();
  });

  socket.on('playCard', ({ card }) => {
    if (!game || game.phase !== 'playing') return;
    const seat = game.players.indexOf(socket.id);
    if (seat === -1) return;
    playCard(seat, card);
  });

  socket.on('newGame', () => {
    game = null;
    broadcastState();
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    if (!game) return;
    const seat = game.players.indexOf(socket.id);
    if (seat === -1) return;
    if (game.phase === 'waiting') {
      game.players[seat] = null;
      game.names[seat] = `Jogador ${seat + 1}`;
      broadcastState();
    } else {
      // Replace with AI mid-game
      game.players[seat] = 'ai';
      game.names[seat] = `IA ${seat + 1}`;
      broadcastState();
      if (game.phase === 'playing' && game.currentPlayer === seat) {
        setTimeout(handleAITurn, 600);
      } else if (game.phase === 'passing' && !game.pendingPass[seat]) {
        setTimeout(handleAIPasses, 400);
      }
    }
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Hearts game server running on http://localhost:${PORT}`);
});
