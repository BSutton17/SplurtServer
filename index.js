const express = require("express");
const app = express();
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://splurt.netlify.app",
    methods: ["GET", "POST"],
  },
});

let players = [];
let availablePrompts = [];
let availableRules = [];

io.on('connection', (socket) => {
  console.log('A user connected');

  socket.on("joinGame", (playerName) => {
    // Check if player already exists
    const existingPlayer = players.find(p => p.id === socket.id);
    
    if (existingPlayer) {
      // Update existing player's name
      existingPlayer.name = playerName;
      console.log(`${playerName} updated their name`);
    } else {
      // Add new player
      const newPlayer = {
        id: socket.id,
        name: playerName,
        score: 0
      };
      players.push(newPlayer);
      console.log(`${playerName} joined the game`);
    }
    
    io.emit("updatePlayers", players);
  });

  socket.on("ruleChange", ({ prompts, rules }) => {
    // Reset availablePrompts if empty
    if (availablePrompts.length === 0) {
      availablePrompts = [...prompts];
    }
    // Reset availableRules if empty
    if (availableRules.length === 0) {
      availableRules = [...rules];
    }

    // Pick random prompt
    const promptIndex = Math.floor(Math.random() * availablePrompts.length);
    const selectedPrompt = availablePrompts[promptIndex];
    availablePrompts = availablePrompts.filter((_, index) => index !== promptIndex);

    // Pick random rule
    const ruleIndex = Math.floor(Math.random() * availableRules.length);
    const selectedRule = availableRules[ruleIndex];
    availableRules = availableRules.filter((_, index) => index !== ruleIndex);

    // Send prompt immediately
    io.emit("updatePrompt", selectedPrompt);

    // Send rule after 2-4 second delay
    const delay = Math.floor(Math.random() * 2000) + 2000; // 2000-4000ms
    setTimeout(() => {
      io.emit("updateRule", selectedRule);
    }, delay);
  });

  socket.on("updateScore", ({ playerId, delta }) => {
    const player = players.find(p => p.id === playerId);
    if (player) {
      player.score += delta;
      io.emit("updatePlayers", players);
    }
  });

  socket.on("disconnect", () => {
    console.log("A user disconnected");
    players = players.filter(p => p.id !== socket.id);
    io.emit("updatePlayers", players);
  });
});

server.listen(process.env.PORT || 3001, () => {
  console.log("SERVER RUNNING");
});
