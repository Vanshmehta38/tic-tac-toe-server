
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
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 4000;

// In-memory game rooms: { [roomId]: { board, currentPlayer, winner, line, players: { socketId: "X"|"O" } } }
const rooms = new Map();

function emptyState() {
  return {
    board: Array(9).fill(null),
    currentPlayer: "X",
    winner: null,
    line: null,
  };
}

function calculateWinner(board) {
  const lines = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a,b,c] };
    }
  }
  if (board.every(Boolean)) return { winner: "draw", line: null };
  return null;
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { ...emptyState(), players: {} });
  }
  return rooms.get(roomId);
}

io.on("connection", (socket) => {
  let joinedRoom = null;

  socket.on("joinRoom", (roomId) => {
    joinedRoom = roomId;
    socket.join(roomId);
    const room = ensureRoom(roomId);

    // Assign symbol
    const symbols = Object.values(room.players);
    let mySymbol = null;
    if (!symbols.includes("X")) mySymbol = "X";
    else if (!symbols.includes("O")) mySymbol = "O";
    // Spectator if both taken
    room.players[socket.id] = mySymbol; // may be null for spectator

    // Send initial state + your symbol
    socket.emit("joined", { symbol: mySymbol });
    io.to(roomId).emit("state", {
      board: room.board,
      currentPlayer: room.currentPlayer,
      winner: room.winner,
      line: room.line,
      players: Object.values(room.players).filter(Boolean)
    });
  });

  socket.on("move", (index) => {
    if (joinedRoom == null) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    const mySymbol = room.players[socket.id];
    if (!mySymbol) return; // spectators can't move
    if (room.winner) return; // game over
    if (room.board[index] !== null) return; // occupied
    if (room.currentPlayer !== mySymbol) return; // not your turn

    room.board[index] = mySymbol;
    const result = calculateWinner(room.board);
    if (result) {
      if (result.winner === "draw") {
        room.winner = "draw";
        room.line = null;
      } else {
        room.winner = result.winner;
        room.line = result.line;
      }
    } else {
      room.currentPlayer = (room.currentPlayer === "X") ? "O" : "X";
    }
    io.to(joinedRoom).emit("state", {
      board: room.board,
      currentPlayer: room.currentPlayer,
      winner: room.winner,
      line: room.line,
      players: Object.values(room.players).filter(Boolean)
    });
  });

  socket.on("reset", () => {
    if (joinedRoom == null) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    const st = emptyState();
    room.board = st.board;
    room.currentPlayer = st.currentPlayer;
    room.winner = st.winner;
    room.line = st.line;

    io.to(joinedRoom).emit("state", {
      board: room.board,
      currentPlayer: room.currentPlayer,
      winner: room.winner,
      line: room.line,
      players: Object.values(room.players).filter(Boolean)
    });
  });

  socket.on("disconnect", () => {
    if (joinedRoom) {
      const room = rooms.get(joinedRoom);
      if (room) {
        delete room.players[socket.id];
        // If everyone left, clean up
        if (Object.keys(room.players).length === 0) {
          rooms.delete(joinedRoom);
        } else {
          io.to(joinedRoom).emit("state", {
            board: room.board,
            currentPlayer: room.currentPlayer,
            winner: room.winner,
            line: room.line,
            players: Object.values(room.players).filter(Boolean)
          });
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
