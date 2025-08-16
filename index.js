import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const app = express();
app.use(cors());

app.get("/", (_req, res) => {
  res.send("Tic Tac Toe Realtime Server is running.");
});

const server = http.createServer(app);

const allowedOrigins = process.env.CLIENT_URLS
  ? process.env.CLIENT_URLS.split(",")
  : ["http://localhost:3000"];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["polling", "websocket"],
});

const PORT = process.env.PORT || 4000;
const rooms = new Map();

function emptyState() {
  return {
    board: Array(9).fill(null),
    currentPlayer: "X",
    winner: null,
    line: null,
    players: {}, // { userId: { symbol: 'X'|'O'|null, socketId } }
    adminId: null, // userId of admin
    scores: {
      // ✅ player-wise scoreboard
      byUser: {}, // { [userId]: wins }
      draws: 0,
    },
  };
}

function calculateWinner(board) {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }
  if (board.every(Boolean)) return { winner: "draw", line: null };
  return null;
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, emptyState());
  }
  return rooms.get(roomId);
}

function serializeState(room) {
  return {
    board: room.board,
    currentPlayer: room.currentPlayer,
    winner: room.winner,
    line: room.line,
    players: Object.entries(room.players).map(([userId, p]) => ({
      userId,
      symbol: p.symbol,
    })),
    scores: room.scores,
  };
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  let joinedRoom = null;
  let myUserId = null;

  socket.on("joinRoom", ({ roomId, userId }) => {
    joinedRoom = roomId;
    myUserId = userId;

    socket.join(roomId);
    const room = ensureRoom(roomId);

    // If new player, assign symbol if slot available
    if (!room.players[userId]) {
      const symbols = Object.values(room.players).map((p) => p.symbol);
      let mySymbol = null;
      if (!symbols.includes("X")) mySymbol = "X";
      else if (!symbols.includes("O")) mySymbol = "O";

      room.players[userId] = { symbol: mySymbol, socketId: socket.id };

      // If no admin yet, this user becomes admin
      if (!room.adminId) {
        room.adminId = userId;
      }
    } else {
      // Reconnect → update socketId
      room.players[userId].socketId = socket.id;
    }

    // Ensure scoreboard entry exists for this user
    if (room.scores.byUser[userId] === undefined) {
      room.scores.byUser[userId] = 0;
    }

    socket.emit("joined", {
      symbol: room.players[userId].symbol,
      isAdmin: room.adminId === userId,
    });

    io.to(roomId).emit("state", serializeState(room));
  });

  socket.on("move", (index) => {
    if (!joinedRoom || !myUserId) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;

    const me = room.players[myUserId];
    if (
      !me?.symbol ||
      room.winner ||
      room.board[index] !== null ||
      room.currentPlayer !== me.symbol
    )
      return;

    room.board[index] = me.symbol;
    const result = calculateWinner(room.board);
    if (result) {
      room.winner = result.winner;
      room.line = result.line;

      // ✅ Update player-wise scores
      if (room.winner === "X" || room.winner === "O") {
        const winnerId = Object.keys(room.players).find(
          (uid) => room.players[uid].symbol === room.winner
        );
        if (winnerId) {
          if (room.scores.byUser[winnerId] === undefined)
            room.scores.byUser[winnerId] = 0;
          room.scores.byUser[winnerId] += 1;
        }
      } else if (room.winner === "draw") {
        room.scores.draws += 1;
      }
    } else {
      room.currentPlayer = room.currentPlayer === "X" ? "O" : "X";
    }

    io.to(joinedRoom).emit("state", serializeState(room));
  });

  socket.on("reset", () => {
    if (!joinedRoom || !myUserId) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;

    // ✅ Only admin can reset
    if (myUserId !== room.adminId) return;

    const lastWinner = room.winner; // save before clearing

    // Clear board
    room.board = Array(9).fill(null);
    room.currentPlayer = "X";
    room.winner = null;
    room.line = null;

    // Winner-stays-X rule on reset (draw => keep roles)
    const playerIds = Object.keys(room.players);
    if (playerIds.length >= 2) {
      const active = playerIds.filter(
        (uid) =>
          room.players[uid].symbol === "X" || room.players[uid].symbol === "O"
      );

      if (lastWinner && lastWinner !== "draw") {
        const winnerId = active.find(
          (uid) => room.players[uid].symbol === lastWinner
        );
        const loserId = active.find((uid) => uid !== winnerId);
        if (winnerId) room.players[winnerId].symbol = "X";
        if (loserId) room.players[loserId].symbol = "O";
      }
      // draw → leave symbols as-is
    }

    io.to(joinedRoom).emit("state", serializeState(room));

    // Reaffirm personal status
    for (const [uid, p] of Object.entries(room.players)) {
      io.to(p.socketId).emit("joined", {
        symbol: p.symbol,
        isAdmin: uid === room.adminId,
      });
    }
  });

  socket.on("leaveRoom", () => {
    if (!joinedRoom || !myUserId) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;

    delete room.players[myUserId];

    if (room.adminId === myUserId) {
      const remaining = Object.keys(room.players);
      room.adminId = remaining.length > 0 ? remaining[0] : null;
    }

    if (Object.keys(room.players).length === 0) {
      rooms.delete(joinedRoom); // destroy empty room (scores vanish with room)
    } else {
      io.to(joinedRoom).emit("state", serializeState(room));

      for (const [uid, p] of Object.entries(room.players)) {
        io.to(p.socketId).emit("joined", {
          symbol: p.symbol,
          isAdmin: uid === room.adminId,
        });
      }
    }
  });

  socket.on("cheat", ({ action }) => {
    if (!joinedRoom || !myUserId) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;

    // ✅ Only admin can cheat
    if (myUserId !== room.adminId) return;

    if (action === "forceX" || action === "forceO") {
      room.winner = action === "forceX" ? "X" : "O";
      room.line = null;
      const winnerId = Object.keys(room.players).find(
        (uid) => room.players[uid].symbol === room.winner
      );
      if (winnerId) {
        room.scores.byUser[winnerId] = (room.scores.byUser[winnerId] || 0) + 1;
      }
    }

    if (action === "forceDraw") {
      room.winner = "draw";
      room.line = null;
      room.scores.draws += 1;
    }

    if (action === "clearScores") {
      room.scores = { byUser: {}, draws: 0 };
      for (const uid of Object.keys(room.players)) {
        room.scores.byUser[uid] = 0;
      }
    }

    if (action === "skipTurn") {
      room.currentPlayer = room.currentPlayer === "X" ? "O" : "X";
    }

    if (action === "clearBoard") {
      room.board = Array(9).fill(null);
      room.winner = null;
      room.line = null;
      room.currentPlayer = "X";
    }

    if (action === "fillRandom") {
      const empty = room.board
        .map((v, i) => (v === null ? i : null))
        .filter((i) => i !== null);
      if (empty.length > 0 && !room.winner) {
        const randIndex = empty[Math.floor(Math.random() * empty.length)];
        room.board[randIndex] = room.currentPlayer;
        const result = calculateWinner(room.board);
        if (result) {
          room.winner = result.winner;
          room.line = result.line;
          if (room.winner === "draw") {
            room.scores.draws += 1;
          } else {
            const winnerId = Object.keys(room.players).find(
              (uid) => room.players[uid].symbol === room.winner
            );
            if (winnerId) {
              room.scores.byUser[winnerId] =
                (room.scores.byUser[winnerId] || 0) + 1;
            }
          }
        } else {
          room.currentPlayer = room.currentPlayer === "X" ? "O" : "X";
        }
      }
    }

    io.to(joinedRoom).emit("state", serializeState(room));
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
