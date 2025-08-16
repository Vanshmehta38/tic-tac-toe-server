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

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
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
    players: {},
    adminId: null,
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

  socket.on("joinRoom", (roomId) => {
    console.log(`📥 joinRoom from ${socket.id} -> ${roomId}`);

    joinedRoom = roomId;
    socket.join(roomId);
    const room = ensureRoom(roomId);

    const symbols = Object.values(room.players);
    let mySymbol = null;
    if (!symbols.includes("X")) mySymbol = "X";
    else if (!symbols.includes("O")) mySymbol = "O";
    else mySymbol = null; // spectator

    // ✅ assign admin if not set
    if (!room.adminId) {
      room.adminId = socket.id;
    }

    room.players[socket.id] = mySymbol;
    console.log(
      `➡️ ${socket.id} assigned as ${mySymbol}, admin=${
        socket.id === room.adminId
      }`
    );

    socket.emit("joined", {
      symbol: mySymbol,
      isAdmin: socket.id === room.adminId,
    });

    io.to(roomId).emit("state", {
      board: room.board,
      currentPlayer: room.currentPlayer,
      winner: room.winner,
      line: room.line,
      players: Object.values(room.players).filter(Boolean),
    });
  });

  socket.on("move", (index) => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;

    const mySymbol = room.players[socket.id];
    if (
      !mySymbol ||
      room.winner ||
      room.board[index] !== null ||
      room.currentPlayer !== mySymbol
    )
      return;

    room.board[index] = mySymbol;
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
      players: Object.values(room.players).filter(Boolean),
    });
  });

  socket.on("reset", () => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;

    // Reset only board state
    room.board = Array(9).fill(null);
    room.currentPlayer = "X";
    room.winner = null;
    room.line = null;

    // Shuffle X and O
    const playerIds = Object.keys(room.players);
    if (playerIds.length >= 2) {
      const shuffled = playerIds.sort(() => Math.random() - 0.5);
      room.players[shuffled[0]] = "X";
      room.players[shuffled[1]] = "O";
      for (let i = 2; i < shuffled.length; i++) {
        room.players[shuffled[i]] = null;
      }
    }

    // Broadcast updated state
    io.to(joinedRoom).emit("state", {
      board: room.board,
      currentPlayer: room.currentPlayer,
      winner: room.winner,
      line: room.line,
      players: Object.values(room.players).filter(Boolean),
    });

    // Tell each player their symbol & admin status
    for (const [id, symbol] of Object.entries(room.players)) {
      io.to(id).emit("joined", {
        symbol,
        isAdmin: id === room.adminId,
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
    if (joinedRoom) {
      const room = rooms.get(joinedRoom);
      if (room) {
        delete room.players[socket.id];

        // If admin left, promote first remaining player
        if (room.adminId === socket.id) {
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
            players: Object.values(room.players).filter(Boolean),
          });

          // Update admin info to everyone
          for (const [id, symbol] of Object.entries(room.players)) {
            io.to(id).emit("joined", {
              symbol,
              isAdmin: id === room.adminId,
            });
          }
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
