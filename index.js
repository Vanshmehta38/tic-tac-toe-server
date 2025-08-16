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
    players: {}, // { userId: { symbol, socketId } }
    adminId: null, // userId of admin
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

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  let joinedRoom = null;
  let myUserId = null;

  socket.on("joinRoom", ({ roomId, userId }) => {
    joinedRoom = roomId;
    myUserId = userId;

    socket.join(roomId);
    const room = ensureRoom(roomId);

    // Assign symbol if new
    if (!room.players[userId]) {
      const symbols = Object.values(room.players).map((p) => p.symbol);
      let mySymbol = null;
      if (!symbols.includes("X")) mySymbol = "X";
      else if (!symbols.includes("O")) mySymbol = "O";

      room.players[userId] = { symbol: mySymbol, socketId: socket.id };

      // If no admin, make this user admin
      if (!room.adminId) {
        room.adminId = userId;
      }
    } else {
      // Update socketId if reconnected
      room.players[userId].socketId = socket.id;
    }

    socket.emit("joined", {
      symbol: room.players[userId].symbol,
      isAdmin: room.adminId === userId,
    });

    io.to(roomId).emit("state", {
      board: room.board,
      currentPlayer: room.currentPlayer,
      winner: room.winner,
      line: room.line,
      players: Object.values(room.players)
        .map((p) => p.symbol)
        .filter(Boolean),
    });
  });

  socket.on("move", (index) => {
    if (!joinedRoom || !myUserId) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;

    const player = room.players[myUserId];
    if (
      !player?.symbol ||
      room.winner ||
      room.board[index] !== null ||
      room.currentPlayer !== player.symbol
    )
      return;

    room.board[index] = player.symbol;
    const result = calculateWinner(room.board);
    if (result) {
      room.winner = result.winner;
      room.line = result.line;
    } else {
      room.currentPlayer = room.currentPlayer === "X" ? "O" : "X";
    }

    io.to(joinedRoom).emit("state", {
      board: room.board,
      currentPlayer: room.currentPlayer,
      winner: room.winner,
      line: room.line,
      players: Object.values(room.players)
        .map((p) => p.symbol)
        .filter(Boolean),
    });
  });

  socket.on("reset", () => {
    if (!joinedRoom || !myUserId) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;

    // ✅ Only admin can reset
    if (myUserId !== room.adminId) return;

    // Save last winner before clearing
    const lastWinner = room.winner;

    // Reset board state
    room.board = Array(9).fill(null);
    room.currentPlayer = "X";
    room.winner = null;
    room.line = null;

    const playerIds = Object.keys(room.players);
    if (playerIds.length >= 2) {
      // Get active players
      const activePlayers = playerIds.filter(
        (uid) =>
          room.players[uid].symbol === "X" || room.players[uid].symbol === "O"
      );

      if (lastWinner && lastWinner !== "draw") {
        // ✅ Winner stays X, loser becomes O
        const winnerId = activePlayers.find(
          (uid) => room.players[uid].symbol === lastWinner
        );
        const loserId = activePlayers.find((uid) => uid !== winnerId);

        if (winnerId) room.players[winnerId].symbol = "X";
        if (loserId) room.players[loserId].symbol = "O";
      }
      // ✅ On draw → do nothing (keep same symbols)
    }

    // Broadcast updated state
    io.to(joinedRoom).emit("state", {
      board: room.board,
      currentPlayer: room.currentPlayer,
      winner: room.winner,
      line: room.line,
      players: Object.values(room.players)
        .map((p) => p.symbol)
        .filter(Boolean),
    });

    // Tell each player their updated symbol & admin status
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
      const remainingIds = Object.keys(room.players);
      room.adminId = remainingIds.length > 0 ? remainingIds[0] : null;
    }

    if (Object.keys(room.players).length === 0) {
      rooms.delete(joinedRoom);
    } else {
      io.to(joinedRoom).emit("state", {
        board: room.board,
        currentPlayer: room.currentPlayer,
        winner: room.winner,
        line: room.line,
        players: Object.values(room.players)
          .map((p) => p.symbol)
          .filter(Boolean),
      });

      // Update joined info for each player
      for (const [uid, p] of Object.entries(room.players)) {
        io.to(p.socketId).emit("joined", {
          symbol: p.symbol,
          isAdmin: uid === room.adminId,
        });
      }
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
    // we don't remove player here, only on leaveRoom
  });
});

server.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
