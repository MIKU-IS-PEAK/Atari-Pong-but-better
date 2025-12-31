const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from the same directory
app.use(express.static(path.join(__dirname)));

// Matchmaking queue
const matchmakingQueue = [];

// Active game rooms
const rooms = new Map();

// Store player socket info
const players = new Map();

// Generate unique room ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Handle socket connections
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Add player to map
  players.set(socket.id, {
    socketId: socket.id,
    roomId: null,
    side: null
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    
    const player = players.get(socket.id);
    if (player && player.roomId) {
      handlePlayerDisconnect(socket.id, player.roomId);
    }
    
    // Remove from queue if in queue
    const queueIndex = matchmakingQueue.findIndex(p => p.socketId === socket.id);
    if (queueIndex !== -1) {
      matchmakingQueue.splice(queueIndex, 1);
      console.log('Removed from queue:', socket.id);
    }
    
    players.delete(socket.id);
  });

  // Join matchmaking queue
  socket.on('joinQueue', () => {
    console.log('Player joined queue:', socket.id);
    
    // Check if already in queue
    if (matchmakingQueue.find(p => p.socketId === socket.id)) {
      return;
    }
    
    // Check if already in a room
    const player = players.get(socket.id);
    if (player && player.roomId) {
      return;
    }
    
    // Add to queue
    matchmakingQueue.push({
      socketId: socket.id,
      timestamp: Date.now()
    });
    
    // Try to match players
    if (matchmakingQueue.length >= 2) {
      matchPlayers();
    }
  });

  // Leave matchmaking queue
  socket.on('leaveQueue', () => {
    console.log('Player left queue:', socket.id);
    const queueIndex = matchmakingQueue.findIndex(p => p.socketId === socket.id);
    if (queueIndex !== -1) {
      matchmakingQueue.splice(queueIndex, 1);
    }
  });

  // Handle paddle updates
  socket.on('paddleUpdate', (data) => {
    const player = players.get(socket.id);
    if (player && player.roomId && rooms.has(player.roomId)) {
      const room = rooms.get(player.roomId);
      // Broadcast to opponent
      const opponentSocketId = player.side === 'left' ? room.rightPlayer : room.leftPlayer;
      if (opponentSocketId) {
        io.to(opponentSocketId).emit('paddleUpdate', data);
      }
    }
  });

  // Handle game state updates (from host)
  socket.on('gameState', (data) => {
    const player = players.get(socket.id);
    if (player && player.roomId && rooms.has(player.roomId)) {
      const room = rooms.get(player.roomId);
      // Broadcast to opponent
      const opponentSocketId = player.side === 'left' ? room.rightPlayer : room.leftPlayer;
      if (opponentSocketId && room.host === socket.id) {
        io.to(opponentSocketId).emit('gameState', data);
      }
    }
  });

  // Handle ability usage
  socket.on('abilityUsed', (data) => {
    const player = players.get(socket.id);
    if (player && player.roomId && rooms.has(player.roomId)) {
      const room = rooms.get(player.roomId);
      // Broadcast to opponent
      const opponentSocketId = player.side === 'left' ? room.rightPlayer : room.leftPlayer;
      if (opponentSocketId) {
        io.to(opponentSocketId).emit('abilityUsed', data);
      }
    }
  });

  // Handle score updates
  socket.on('score', (data) => {
    const player = players.get(socket.id);
    if (player && player.roomId && rooms.has(player.roomId)) {
      const room = rooms.get(player.roomId);
      // Update room scores
      room.scores = {
        left: data.leftScore,
        right: data.rightScore
      };
      // Broadcast to opponent
      const opponentSocketId = player.side === 'left' ? room.rightPlayer : room.leftPlayer;
      if (opponentSocketId && room.host === socket.id) {
        io.to(opponentSocketId).emit('score', data);
      }
    }
  });
});

// Match two players from queue
function matchPlayers() {
  if (matchmakingQueue.length < 2) {
    return;
  }

  // Get first two players from queue
  const player1 = matchmakingQueue.shift();
  const player2 = matchmakingQueue.shift();

  // Create room
  const roomId = generateRoomId();
  const room = {
    roomId: roomId,
    leftPlayer: player1.socketId,
    rightPlayer: player2.socketId,
    host: player1.socketId, // First player is host (controls ball physics)
    scores: {
      left: 0,
      right: 0
    },
    createdAt: Date.now()
  };

  rooms.set(roomId, room);

  // Update player info
  const p1 = players.get(player1.socketId);
  const p2 = players.get(player2.socketId);
  
  if (p1) {
    p1.roomId = roomId;
    p1.side = 'left';
    p1.isHost = true;
  }
  
  if (p2) {
    p2.roomId = roomId;
    p2.side = 'right';
    p2.isHost = false;
  }

  // Notify both players
  io.to(player1.socketId).emit('matchFound', {
    roomId: roomId,
    side: 'left',
    isHost: true
  });

  io.to(player2.socketId).emit('matchFound', {
    roomId: roomId,
    side: 'right',
    isHost: false
  });

  console.log('Matched players:', player1.socketId, player2.socketId, 'in room:', roomId);
}

// Handle player disconnect
function handlePlayerDisconnect(socketId, roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  // Notify opponent
  const opponentSocketId = socketId === room.leftPlayer ? room.rightPlayer : room.leftPlayer;
  if (opponentSocketId) {
    io.to(opponentSocketId).emit('opponentLeft');
    
    // Clean up opponent's room info
    const opponent = players.get(opponentSocketId);
    if (opponent) {
      opponent.roomId = null;
      opponent.side = null;
    }
  }

  // Remove room
  rooms.delete(roomId);
  console.log('Room deleted:', roomId);
}

// Clean up empty rooms periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    // Check if room is empty or very old (1 hour)
    if (now - room.createdAt > 3600000) {
      rooms.delete(roomId);
      console.log('Cleaned up old room:', roomId);
    }
  }
}, 300000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT}/ATARI_PONG.html to play`);
});

