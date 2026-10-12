const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

// Heroku eco dynos sleep after 30 minutes without an HTTP request, and an open
// socket does not count. The client hits this every few minutes mid-game.
app.get("/ping", (_req, res) => {
  res.set("Cache-Control", "no-store").send("pong");
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "https://splurt.netlify.app"],
    methods: ["GET", "POST"],
  },
});

// A dropped player keeps their score this long - long enough for a phone to
// lock and come back between rounds.
const RECONNECT_GRACE_MS = 10 * 60 * 1000;
const MAX_NAME_LENGTH = 20;
const MAX_ID_LENGTH = 64;
const MAX_CARD_LENGTH = 200;
const MAX_DECK_SIZE = 2000;
const MAX_SCORE_STEP = 10;

// One shared game for the whole party. Players are keyed by a playerId the
// browser keeps across reloads (not socket.id, which changes on every
// reconnect), so a dropped connection gets its score back.
let players = []; // { id, name, score, socketId, connected }
const graceTimers = {};

let availablePrompts = [];
let availableRules = [];

// What is on screen right now, so a reloaded or reconnected phone catches up.
let currentPrompt = null;
let currentRule = null;
let pendingRuleTimer = null;

const publicPlayers = () =>
  players.map(({ id, name, score, connected }) => ({ id, name, score, connected }));

const emitPlayers = () => io.emit("updatePlayers", publicPlayers());

// Trimmed string, or "" when the value is missing, not a string, or too long.
const cleanString = (value, maxLength) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : "";
};

// The client sends its card lists; keep only sane string entries.
const cleanDeck = (deck) =>
  Array.isArray(deck)
    ? deck.slice(0, MAX_DECK_SIZE).map((card) => cleanString(card, MAX_CARD_LENGTH)).filter(Boolean)
    : [];

const drawCard = (deck) => {
  const index = Math.floor(Math.random() * deck.length);
  return deck.splice(index, 1)[0];
};

function clearGraceTimer(id) {
  clearTimeout(graceTimers[id]);
  delete graceTimers[id];
}

// The player record this socket currently owns, if any.
const seatFor = (socket) => {
  const player = players.find((p) => p.id === socket.data.playerId);
  return player && player.socketId === socket.id ? player : null;
};

// One bad packet must never crash the process - the scores live in memory.
const safely = (event, handler) => (...args) => {
  try {
    handler(...args);
  } catch (error) {
    console.error(`Error handling "${event}":`, error);
  }
};

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);
  const on = (event, handler) => socket.on(event, safely(event, handler));

  // Catch up whoever just (re)connected.
  socket.emit("updatePlayers", publicPlayers());
  if (currentPrompt) socket.emit("updatePrompt", currentPrompt);
  if (currentRule) socket.emit("updateRule", currentRule);

  // Accepts joinGame({ name, playerId }) or the older joinGame(name).
  on("joinGame", (data) => {
    const payload = typeof data === "string" ? { name: data } : data || {};
    const name = cleanString(payload.name, MAX_NAME_LENGTH);
    const id = cleanString(payload.playerId, MAX_ID_LENGTH) || socket.id;
    if (!name) return;

    const existing = players.find((p) => p.id === id);
    if (existing) {
      // Rename, refresh or reconnect - keep the score.
      clearGraceTimer(id);
      existing.name = name;
      existing.socketId = socket.id;
      existing.connected = true;
      console.log(`${name} is back`);
    } else {
      players.push({ id, name, score: 0, socketId: socket.id, connected: true });
      console.log(`${name} joined the game`);
    }

    socket.data.playerId = id;
    emitPlayers();
  });

  on("ruleChange", (data) => {
    // Refill a deck once it runs out.
    if (availablePrompts.length === 0) availablePrompts = cleanDeck(data?.prompts);
    if (availableRules.length === 0) availableRules = cleanDeck(data?.rules);
    if (availablePrompts.length === 0 || availableRules.length === 0) return;

    currentPrompt = drawCard(availablePrompts);
    currentRule = null;
    io.emit("updatePrompt", currentPrompt);

    // The rule lands 2-4 seconds later. A quick second click cancels the
    // pending rule so an old one can't show up under the new prompt.
    clearTimeout(pendingRuleTimer);
    const rule = drawCard(availableRules);
    const delay = Math.floor(Math.random() * 2000) + 2000;
    pendingRuleTimer = setTimeout(() => {
      pendingRuleTimer = null;
      currentRule = rule;
      io.emit("updateRule", rule);
    }, delay);
  });

  on("updateScore", (data) => {
    const player = players.find((p) => p.id === data?.playerId);
    const delta = Number(data?.delta);
    if (!player || !Number.isInteger(delta) || Math.abs(delta) > MAX_SCORE_STEP) return;

    player.score += delta;
    emitPlayers();
  });

  on("disconnect", (reason) => {
    console.log(`A user disconnected: ${socket.id} (${reason})`);

    const player = seatFor(socket);
    if (!player) return;

    // Hold the seat and score; only drop them if they never come back.
    player.connected = false;
    emitPlayers();

    clearGraceTimer(player.id);
    graceTimers[player.id] = setTimeout(() => {
      const stillGone = players.find((p) => p.id === player.id);
      if (stillGone && !stillGone.connected) {
        console.log(`${stillGone.name} did not come back - removing`);
        players = players.filter((p) => p.id !== player.id);
        delete graceTimers[player.id];
        emitPlayers();
      }
    }, RECONNECT_GRACE_MS);
  });
});

server.listen(process.env.PORT || 3001, () => {
  console.log("SERVER RUNNING");
});

// Heroku sends SIGTERM when it restarts or sleeps the dyno. Close sockets
// cleanly so every client starts reconnecting straight away.
process.on("SIGTERM", () => {
  console.log("SIGTERM received - shutting down");
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
