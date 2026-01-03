const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow connections from Netlify frontend
    methods: ["GET", "POST"]
  }
});

// Simple root route to check if server is running
app.get('/', (req, res) => {
  res.send('Battleship Signaling Server is Running');
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', (roomId) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const numClients = room ? room.size : 0;

    if (numClients === 0) {
      socket.join(roomId);
      socket.emit('room-created', roomId); // First player is host
    } else if (numClients === 1) {
      socket.join(roomId);
      socket.emit('room-joined', roomId); // Second player joins
      io.to(roomId).emit('ready-to-negotiate'); // Tell both to start WebRTC
    } else {
      socket.emit('room-full');
    }
  });

  // WebRTC Signaling Events
  socket.on('offer', (data) => {
    socket.to(data.roomId).emit('offer', data.offer);
  });

  socket.on('answer', (data) => {
    socket.to(data.roomId).emit('answer', data.answer);
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.roomId).emit('ice-candidate', data.candidate);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
