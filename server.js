const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// In-memory storage (resets on server restart)
const users = {}; // socketId -> { id, username, status, socketId }

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // --- USER SYSTEM ---
  socket.on('login', (userData) => {
    // userData = { id: 'uuid', username: 'Name' }
    // If no ID provided, generate one
    const userId = userData.id || uuidv4();
    
    users[socket.id] = {
      id: userId,
      username: userData.username || `Player_${userId.substring(0,4)}`,
      status: 'online', // online, playing
      socketId: socket.id
    };

    socket.emit('login-success', users[socket.id]);
    broadcastUserList();
  });

  socket.on('get-online-users', () => {
    // Return all users except self
    const list = Object.values(users).filter(u => u.id !== users[socket.id]?.id);
    socket.emit('online-users-update', list);
  });

  socket.on('send-challenge', (targetUserId) => {
    const challenger = users[socket.id];
    const targetSocketId = Object.values(users).find(u => u.id === targetUserId)?.socketId;
    
    if (targetSocketId && challenger) {
      io.to(targetSocketId).emit('challenge-received', {
        fromId: challenger.id,
        fromName: challenger.username,
        socketId: socket.id // challenger socket id
      });
    }
  });

  socket.on('accept-challenge', (challengerSocketId) => {
    const roomId = `BATTLE_${uuidv4().substring(0, 8)}`;
    // Notify both to join this room
    io.to(challengerSocketId).emit('match-start', roomId);
    socket.emit('match-start', roomId);
  });

  // --- GAME ROOMS ---
  socket.on('join-room', (roomId) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const numClients = room ? room.size : 0;

    if (numClients === 0) {
      socket.join(roomId);
      socket.emit('room-created', roomId);
    } else if (numClients === 1) {
      socket.join(roomId);
      socket.emit('room-joined', roomId);
      io.to(roomId).emit('ready-to-negotiate');
    } else {
      socket.emit('room-full');
    }
    
    if (users[socket.id]) {
        users[socket.id].status = 'playing';
        broadcastUserList();
    }
  });

  socket.on('leave-room', (roomId) => {
      socket.leave(roomId);
      if (users[socket.id]) {
          users[socket.id].status = 'online';
          broadcastUserList();
      }
  });

  // --- WebRTC SIGNALING ---
  socket.on('offer', (data) => socket.to(data.roomId).emit('offer', data.offer));
  socket.on('answer', (data) => socket.to(data.roomId).emit('answer', data.answer));
  socket.on('ice-candidate', (data) => socket.to(data.roomId).emit('ice-candidate', data.candidate));

  socket.on('disconnect', () => {
    delete users[socket.id];
    broadcastUserList();
  });

  function broadcastUserList() {
    const list = Object.values(users);
    io.emit('online-users-update', list);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
