const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

// Add a health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Sanitize input to prevent XSS
const sanitizeInput = (str) => {
    return str.replace(/[<>]/g, '').slice(0, 20);
};

const players = new Map();
const rooms = new Map();

const MAX_PLAYERS = 4;
const createRoom = (roomId) => {
    return {
        players: new Set(),
        currentTurn: null,
        gameStarted: false
    };
};

io.on('connection', (socket) => {
    console.log('A user connected');

    socket.on('joinGame', (data) => {
        const playerName = sanitizeInput(data.playerName);
        const roomId = data.roomId || 'default';

        // Create room if it doesn't exist
        if (!rooms.has(roomId)) {
            rooms.set(roomId, createRoom(roomId));
        }

        const room = rooms.get(roomId);

        // Check room capacity
        if (room.players.size >= MAX_PLAYERS) {
            socket.emit('error', { message: 'Room is full' });
            return;
        }

        // Join socket.io room
        socket.join(roomId);
        room.players.add(socket.id);
        
        players.set(socket.id, { 
            name: playerName, 
            room: roomId 
        });

        // Notify everyone in the room
        io.to(roomId).emit('playerJoined', {
            id: socket.id,
            name: playerName,
            playerCount: room.players.size
        });

        // Start game if room is full
        if (room.players.size === MAX_PLAYERS && !room.gameStarted) {
            room.gameStarted = true;
            room.currentTurn = Array.from(room.players)[0];
            io.to(roomId).emit('gameStart', {
                players: Array.from(room.players).map(id => ({
                    id,
                    name: players.get(id).name
                })),
                currentTurn: room.currentTurn
            });
        }
    });

    socket.on('makeCall', (data) => {
        const player = players.get(socket.id);
        if (!player) return;

        const room = rooms.get(player.room);
        if (!room || !room.gameStarted) return;

        // Validate input
        const quantity = parseInt(data.quantity);
        const value = parseInt(data.value);
        if (isNaN(quantity) || isNaN(value) || 
            quantity < 1 || value < 1 || value > 6) {
            return;
        }

        // Only allow current player to make a call
        if (socket.id !== room.currentTurn) {
            socket.emit('error', { message: 'Not your turn' });
            return;
        }

        io.to(player.room).emit('callMade', {
            player: player.name,
            quantity,
            value
        });

        // Move to next player
        const players = Array.from(room.players);
        const currentIndex = players.indexOf(socket.id);
        room.currentTurn = players[(currentIndex + 1) % players.length];
        io.to(player.room).emit('nextTurn', { playerId: room.currentTurn });
    });

    socket.on('callLiar', (data) => {
        const player = players.get(socket.id);
        if (!player) return;

        const room = rooms.get(player.room);
        if (!room || !room.gameStarted) return;

        io.to(player.room).emit('liarCalled', {
            player: player.name
        });

        // Reset turn after liar is called
        room.currentTurn = socket.id;
        io.to(player.room).emit('nextTurn', { playerId: room.currentTurn });
    });

    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        if (player) {
            const room = rooms.get(player.room);
            if (room) {
                room.players.delete(socket.id);
                
                // Notify remaining players
                io.to(player.room).emit('playerLeft', {
                    name: player.name,
                    playerCount: room.players.size
                });

                // Clean up empty rooms
                if (room.players.size === 0) {
                    rooms.delete(player.room);
                } else if (room.gameStarted) {
                    // If game was in progress, reset current turn if needed
                    if (room.currentTurn === socket.id) {
                        room.currentTurn = Array.from(room.players)[0];
                        io.to(player.room).emit('nextTurn', { playerId: room.currentTurn });
                    }
                }
            }
            players.delete(socket.id);
        }
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 