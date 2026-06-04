const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static assets from current directory
app.use(express.static(__dirname));

// Store active room states
const rooms = new Map();

// Generate a random 4-character room code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

// Cyrb128 + Mulberry32 seed random engine for server validation
function cyrb128(str) {
  let h1 = 1779033703, h2 = 302473254, h3 = 336245363, h4 = 502493819;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h4 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1^h2^h3^h4)>>>0];
}

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// Generate blocked boxes deterministically
function getBlockedBoxes(seedStr, size) {
  const total = size * size;
  if (size <= 5) return new Set(); // no obstacles for small grids
  
  const seedVal = cyrb128(seedStr)[0];
  const rand = mulberry32(seedVal);
  
  const count = Math.floor(total * 0.1); // 10% blocked
  const blocked = new Set();
  
  while (blocked.size < count) {
    const idx = Math.floor(rand() * total);
    blocked.add(idx);
  }
  return blocked;
}

// Generate double tap boxes deterministically
function getDoubleTapBoxes(seedStr, size, blockedSet) {
  const total = size * size;
  if (size <= 5) return new Set(); // no double tap for small grids
  
  const seedVal = cyrb128(seedStr + '-double')[0];
  const rand = mulberry32(seedVal);
  
  const count = Math.floor(total * 0.15); // 15% double tap
  const doubleTaps = new Set();
  
  while (doubleTaps.size < count) {
    const idx = Math.floor(rand() * total);
    if (!blockedSet.has(idx)) {
      doubleTaps.add(idx);
    }
  }
  return doubleTaps;
}

// Helper: get connected players count
function connectedCount(room) {
  return room.players.filter(p => p.connected).length;
}

// Helper: perform role swap
function swapRoles(room) {
  const prevCaller = room.currentCaller;
  room.currentCaller = room.currentSearcher;
  room.currentSearcher = prevCaller;
  room.players.forEach(p => {
    p.role = (p.id === room.currentCaller) ? 'caller' : 'searcher';
  });
}

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Cache room and player info on socket object
  socket.roomId = null;
  socket.playerName = '';
  socket.persistentId = null;

  // 1. Join / Create Room (also handles rejoin by persistentId)
  socket.on('join_room', ({ code, playerName, persistentId }) => {
    let cleanName = (playerName || 'Player').trim().substring(0, 20);
    if (!cleanName) cleanName = 'Player';

    let roomCode = code ? code.trim().toUpperCase() : null;
    let room;

    // --- REJOIN PATH ---
    if (roomCode && persistentId) {
      room = rooms.get(roomCode);
      if (room) {
        const disconnectedPlayer = room.players.find(
          p => p.persistentId === persistentId && !p.connected
        );
        if (disconnectedPlayer) {
          // Cancel the forfeit timeout
          if (disconnectedPlayer.reconnectTimeout) {
            clearTimeout(disconnectedPlayer.reconnectTimeout);
            disconnectedPlayer.reconnectTimeout = null;
          }

          // Reassign the socket to this player
          const oldId = disconnectedPlayer.id;
          disconnectedPlayer.id = socket.id;
          disconnectedPlayer.connected = true;

          // Update currentCaller/Searcher if this player held those roles
          if (room.currentCaller === oldId) room.currentCaller = socket.id;
          if (room.currentSearcher === oldId) room.currentSearcher = socket.id;

          socket.join(roomCode);
          socket.roomId = roomCode;
          socket.playerName = disconnectedPlayer.name;
          socket.persistentId = persistentId;

          // Build tapped state snapshot for the rejoining player
          const blocked = room.state === 'playing' || room.state === 'paused'
            ? getBlockedBoxes(room.seed, room.settings.tallySize) : new Set();
          const doubleTaps = room.state === 'playing' || room.state === 'paused'
            ? getDoubleTapBoxes(room.seed, room.settings.tallySize, blocked) : new Set();

          socket.emit('game_rejoined', {
            myId: socket.id,
            players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, role: p.role, connected: p.connected })),
            roomCode,
            state: room.state,
            seed: room.seed,
            settings: room.settings,
            currentCaller: room.currentCaller,
            currentNumber: room.currentNumber,
            tappingLocked: room.tappingLocked,
            paused: room.paused,
            pausedBy: room.pausedBy,
            myTappedBoxes: disconnectedPlayer.tappedBoxes,
            bonusTimeRemaining: room.bonusTimeRemaining || 0
          });

          // Notify the other player that their opponent is back
          socket.to(roomCode).emit('opponent_reconnected', {
            players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, role: p.role, connected: p.connected }))
          });

          // Auto-resume if game was paused only because of this disconnect
          if (room.paused && room.pausedByDisconnect) {
            room.paused = false;
            room.pausedByDisconnect = false;
            room.pausedBy = null;

            // Restore bonus timeout if needed
            if (room.bonusTimeRemaining > 0) {
              const remaining = room.bonusTimeRemaining;
              room.bonusTimeRemaining = 0;
              io.to(roomCode).emit('game_resumed', { bonusTimeRemaining: remaining });

              room.bonusTimeout = setTimeout(() => {
                room.bonusTimeout = null;
                room.tappingLocked = true;
                io.to(roomCode).emit('tapping_locked', { reason: 'Bonus time over!' });
                swapRoles(room);
                room.currentNumber = null;
                console.log(`Bonus period ended in room ${roomCode}. Roles switched.`);
              }, remaining);
            } else {
              io.to(roomCode).emit('game_resumed', { bonusTimeRemaining: 0 });
            }
          }

          console.log(`Player ${disconnectedPlayer.name} rejoined room ${roomCode}`);
          return;
        }
      }
    }

    // --- CREATE ROOM PATH ---
    if (!roomCode) {
      roomCode = generateRoomCode();
      room = {
        code: roomCode,
        players: [],
        settings: {
          tallySize: 3,
          numRange: '1-30'
        },
        state: 'lobby',
        seed: '',
        currentCaller: null,
        currentSearcher: null,
        currentNumber: null,
        numbersCalled: [],
        tappingLocked: true,
        paused: false,
        pausedBy: null,
        pausedByDisconnect: false,
        bonusTimeRemaining: 0,
        bonusTimeout: null
      };
      rooms.set(roomCode, room);
      console.log(`Room created: ${roomCode}`);
    } else {
      // --- JOIN EXISTING ROOM PATH ---
      room = rooms.get(roomCode);
      if (!room) {
        return socket.emit('error_message', 'Room not found.');
      }

      const connectedPlayers = room.players.filter(p => p.connected);
      if (connectedPlayers.length >= 2) {
        return socket.emit('error_message', 'Room is full.');
      }
      if (room.state !== 'lobby') {
        return socket.emit('error_message', 'Game is already in progress.');
      }
    }

    // Join room channel
    socket.join(roomCode);
    socket.roomId = roomCode;
    socket.playerName = cleanName;
    socket.persistentId = persistentId || null;

    const player = {
      id: socket.id,
      persistentId: persistentId || null,
      name: cleanName,
      ready: room.players.length === 0, // host is auto-ready
      score: 0,
      role: null,
      tappedBoxes: [],
      connected: true,
      reconnectTimeout: null
    };

    room.players.push(player);

    // Send join confirmation to the client
    socket.emit('room_joined', {
      code: roomCode,
      settings: room.settings,
      players: room.players,
      myId: socket.id
    });

    // Notify all players in the room
    io.to(roomCode).emit('player_joined', { players: room.players });
    console.log(`Player ${cleanName} (${socket.id}) joined room ${roomCode}`);
  });

  // 2. Update Settings
  socket.on('settings_update', ({ tallySize, numRange }) => {
    const roomCode = socket.roomId;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    // Only host can update settings
    if (room.players[0] && room.players[0].id !== socket.id) return;

    // Validate settings values
    const cleanTallySize = [3, 4, 5, 8, 10, 14].includes(Number(tallySize)) ? Number(tallySize) : 3;
    const cleanNumRange = ['1-30', '1-50', '1-99', '1-150', '1-200'].includes(numRange) ? numRange : '1-30';

    room.settings.tallySize = cleanTallySize;
    room.settings.numRange = cleanNumRange;

    io.to(roomCode).emit('settings_update', {
      tallySize: cleanTallySize,
      numRange: cleanNumRange
    });
  });

  // 3. Start Game
  socket.on('game_start', () => {
    const roomCode = socket.roomId;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    // Only host can start game
    if (room.players[0] && room.players[0].id !== socket.id) return;

    if (room.players.filter(p => p.connected).length < 2) {
      return socket.emit('error_message', 'Need 2 players to start game.');
    }

    // Reset scores, tapped lists, & status
    room.players.forEach(p => {
      p.score = 0;
      p.ready = true;
      p.tappedBoxes = [];
    });

    room.state = 'playing';
    room.seed = room.code + '-' + Math.floor(Math.random() * 100000);
    room.numbersCalled = [];
    room.currentNumber = null;
    room.tappingLocked = true;
    room.paused = false;
    room.pausedBy = null;
    room.pausedByDisconnect = false;
    room.bonusTimeRemaining = 0;

    // Select first caller randomly
    const connectedPlayers = room.players.filter(p => p.connected);
    const firstCallerIndex = Math.floor(Math.random() * 2);
    room.currentCaller = connectedPlayers[firstCallerIndex].id;
    room.currentSearcher = connectedPlayers[1 - firstCallerIndex].id;

    room.players.forEach(p => {
      p.role = (p.id === room.currentCaller) ? 'caller' : 'searcher';
    });

    io.to(roomCode).emit('game_start', {
      seed: room.seed,
      settings: room.settings,
      firstCaller: room.currentCaller
    });
    console.log(`Game started in room ${roomCode}. Seed: ${room.seed}. First Caller: ${room.currentCaller}`);
  });

  // 4. Number Called
  socket.on('number_called', ({ number }) => {
    const roomCode = socket.roomId;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room || room.state !== 'playing') return;
    if (room.paused) return;

    // Verify it is the current caller calling
    if (socket.id !== room.currentCaller) return;

    const num = parseInt(number, 10);
    if (isNaN(num)) return;

    // Parse range min/max
    const rangeParts = room.settings.numRange.split('-');
    const min = parseInt(rangeParts[0], 10);
    const max = parseInt(rangeParts[1], 10);

    if (num < min || num > max) {
      return socket.emit('error_message', `Number must be between ${min} and ${max}.`);
    }

    if (room.numbersCalled.includes(num)) {
      return socket.emit('error_message', 'This number has already been called.');
    }

    // Set active number
    room.currentNumber = num;
    room.numbersCalled.push(num);
    room.tappingLocked = false;

    // Broadcast number announcement
    io.to(roomCode).emit('number_announced', { number: num });
    console.log(`Number ${num} called in room ${roomCode}`);
  });

  // 5. Tally Tap
  socket.on('tally_tap', ({ index }) => {
    const roomCode = socket.roomId;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room || room.state !== 'playing') return;
    if (room.paused) return;

    // Verify caller is tapping and tapping is unlocked
    if (socket.id !== room.currentCaller) return;
    if (room.tappingLocked) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const idx = parseInt(index, 10);
    if (isNaN(idx) || idx < 0 || idx >= room.settings.tallySize * room.settings.tallySize) return;

    // Compute obstacles & double tap count using seed to determine target score to win
    const blocked = getBlockedBoxes(room.seed, room.settings.tallySize);
    if (blocked.has(idx)) return; // blocked box tapped

    const doubleTaps = getDoubleTapBoxes(room.seed, room.settings.tallySize, blocked);
    const isDouble = doubleTaps.has(idx);

    // Count existing taps on this box
    const currentTaps = player.tappedBoxes.filter(x => x === idx).length;

    if (isDouble) {
      if (currentTaps >= 2) return; // already fully tapped
      player.tappedBoxes.push(idx);
      player.score++;
      
      const newTaps = currentTaps + 1;
      io.to(roomCode).emit('tally_update', {
        playerId: socket.id,
        index: idx,
        taps: newTaps,
        filled: player.score
      });
    } else {
      if (currentTaps >= 1) return; // already tapped
      player.tappedBoxes.push(idx);
      player.score++;

      io.to(roomCode).emit('tally_update', {
        playerId: socket.id,
        index: idx,
        taps: 1,
        filled: player.score
      });
    }

    // Check win condition
    const maxScore = (room.settings.tallySize * room.settings.tallySize - blocked.size) + doubleTaps.size;
    if (player.score === maxScore) {
      if (room.bonusTimeout) {
        clearTimeout(room.bonusTimeout);
        room.bonusTimeout = null;
      }
      room.state = 'game_over';
      io.to(roomCode).emit('game_over', {
        winnerId: player.id,
        winnerName: player.name
      });
      console.log(`Game over in room ${roomCode}. Winner: ${player.name}`);
    }
  });

  // 6. Number Found
  socket.on('number_found', () => {
    const roomCode = socket.roomId;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room || room.state !== 'playing') return;
    if (room.bonusTimeout) return; // ignore during give up bonus phase
    if (room.paused) return;

    // Verify it is the Searcher who found the number
    if (socket.id !== room.currentSearcher) return;
    if (room.currentNumber === null) return;

    // Lock tapping immediately
    room.tappingLocked = true;
    io.to(roomCode).emit('tapping_locked', { reason: 'Number found!' });

    // Switch roles
    swapRoles(room);
    room.currentNumber = null;
    console.log(`Number found in room ${roomCode}. Roles switched. New Caller: ${room.currentCaller}`);
  });

  // 6.5. Searcher Give Up
  socket.on('searcher_give_up', () => {
    const roomCode = socket.roomId;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room || room.state !== 'playing') return;
    if (room.paused) return;

    // Verify it is the Searcher giving up
    if (socket.id !== room.currentSearcher) return;
    if (room.currentNumber === null) return;
    if (room.bonusTimeout) return; // already in bonus period

    console.log(`Searcher ${socket.playerName} in room ${roomCode} initiated Give Up. Starting 5s caller bonus tapping.`);

    // Broadcast that searcher gave up and bonus period starts (5 seconds)
    io.to(roomCode).emit('give_up_bonus_start', { durationMs: 5000 });

    room.bonusTimeout = setTimeout(() => {
      room.bonusTimeout = null;

      // Lock tapping immediately
      room.tappingLocked = true;
      io.to(roomCode).emit('tapping_locked', { reason: 'Bonus time over!' });

      // Switch roles
      swapRoles(room);
      room.currentNumber = null;
      console.log(`Bonus period ended in room ${roomCode}. Roles switched. New Caller: ${room.currentCaller}`);
    }, 5000);
  });

  // 7. Pause Game
  socket.on('pause_game', () => {
    const roomCode = socket.roomId;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room || room.state !== 'playing') return;
    if (room.paused) return;

    room.paused = true;
    room.pausedBy = socket.id;
    room.pausedByDisconnect = false;

    // Freeze bonus timeout if active
    if (room.bonusTimeout) {
      clearTimeout(room.bonusTimeout);
      room.bonusTimeout = null;
      // Store remaining time (approximate — 5s bonus, calculate how much is left)
      room.bonusTimeRemaining = room.bonusTimeRemaining || 5000;
    }

    const pausingPlayer = room.players.find(p => p.id === socket.id);
    io.to(roomCode).emit('game_paused', {
      pausedBy: socket.id,
      pausedByName: pausingPlayer ? pausingPlayer.name : 'Unknown'
    });
    console.log(`Game paused in room ${roomCode} by ${socket.id}`);
  });

  // 8. Resume Game
  socket.on('resume_game', () => {
    const roomCode = socket.roomId;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room || !room.paused) return;

    // Only the pauser or host can resume
    const isHost = room.players[0] && room.players[0].id === socket.id;
    if (socket.id !== room.pausedBy && !isHost) return;

    room.paused = false;
    room.pausedByDisconnect = false;
    room.pausedBy = null;

    // Restore bonus timeout if it was frozen mid-bonus
    if (room.bonusTimeRemaining > 0) {
      const remaining = room.bonusTimeRemaining;
      room.bonusTimeRemaining = 0;
      io.to(roomCode).emit('game_resumed', { bonusTimeRemaining: remaining });

      room.bonusTimeout = setTimeout(() => {
        room.bonusTimeout = null;
        room.tappingLocked = true;
        io.to(roomCode).emit('tapping_locked', { reason: 'Bonus time over!' });
        swapRoles(room);
        room.currentNumber = null;
        console.log(`Bonus period ended in room ${roomCode}. Roles switched.`);
      }, remaining);
    } else {
      io.to(roomCode).emit('game_resumed', { bonusTimeRemaining: 0 });
    }

    console.log(`Game resumed in room ${roomCode}`);
  });

  // 9. Play Again
  socket.on('play_again', () => {
    const roomCode = socket.roomId;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    // Only host can trigger restart
    if (room.players[0] && room.players[0].id !== socket.id) return;
    if (room.players.filter(p => p.connected).length < 2) return;

    if (room.bonusTimeout) {
      clearTimeout(room.bonusTimeout);
      room.bonusTimeout = null;
    }

    // Reset game state
    room.players.forEach(p => {
      p.score = 0;
      p.tappedBoxes = [];
    });

    room.state = 'playing';
    room.seed = room.code + '-' + Math.floor(Math.random() * 100000);
    room.numbersCalled = [];
    room.currentNumber = null;
    room.tappingLocked = true;
    room.paused = false;
    room.pausedBy = null;
    room.pausedByDisconnect = false;
    room.bonusTimeRemaining = 0;

    // Randomize caller again
    const connectedPlayers = room.players.filter(p => p.connected);
    const firstCallerIndex = Math.floor(Math.random() * 2);
    room.currentCaller = connectedPlayers[firstCallerIndex].id;
    room.currentSearcher = connectedPlayers[1 - firstCallerIndex].id;

    room.players.forEach(p => {
      p.role = (p.id === room.currentCaller) ? 'caller' : 'searcher';
    });

    io.to(roomCode).emit('reset_game', {
      seed: room.seed,
      settings: room.settings,
      firstCaller: room.currentCaller
    });
    console.log(`Game reset in room ${roomCode}. Seed: ${room.seed}`);
  });

  // 10. Disconnect
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    const roomCode = socket.roomId;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // Mark as disconnected
    player.connected = false;

    const stillConnected = room.players.filter(p => p.connected);

    if (stillConnected.length === 0) {
      // Both disconnected — clean up bonus timeout and delete room after a delay
      if (room.bonusTimeout) {
        clearTimeout(room.bonusTimeout);
        room.bonusTimeout = null;
      }
      // Give 60s for anyone to come back, then delete
      setTimeout(() => {
        if (rooms.has(roomCode) && connectedCount(rooms.get(roomCode)) === 0) {
          rooms.delete(roomCode);
          console.log(`Room ${roomCode} deleted (all players gone)`);
        }
      }, 60000);
      return;
    }

    // One player still connected
    if (room.state === 'playing' || room.state === 'paused') {
      // Freeze bonus timeout if active
      if (room.bonusTimeout) {
        clearTimeout(room.bonusTimeout);
        room.bonusTimeout = null;
        room.bonusTimeRemaining = room.bonusTimeRemaining || 5000;
      }

      // Auto-pause due to disconnect
      room.paused = true;
      room.pausedByDisconnect = true;
      room.pausedBy = null;

      // Notify the remaining player
      io.to(roomCode).emit('opponent_disconnected', {
        name: player.name,
        reconnectWindowMs: 60000
      });

      // Start 60-second forfeit countdown
      player.reconnectTimeout = setTimeout(() => {
        player.reconnectTimeout = null;
        // Player never came back — forfeit
        const winner = room.players.find(p => p.connected);
        if (winner) {
          room.state = 'game_over';
          if (room.bonusTimeout) {
            clearTimeout(room.bonusTimeout);
            room.bonusTimeout = null;
          }
          io.to(roomCode).emit('opponent_forfeited', {
            winnerId: winner.id,
            winnerName: winner.name,
            forfeiterName: player.name
          });
          console.log(`${player.name} forfeited in room ${roomCode}. Winner: ${winner.name}`);
        }
        // Remove disconnected player from room
        room.players = room.players.filter(p => p.id !== player.id);
        if (room.players.length === 0) {
          rooms.delete(roomCode);
        }
      }, 60000);

    } else {
      // In lobby or game_over — just remove immediately
      room.players = room.players.filter(p => p.id !== socket.id);

      if (room.bonusTimeout) {
        clearTimeout(room.bonusTimeout);
        room.bonusTimeout = null;
      }

      if (room.players.length === 0) {
        rooms.delete(roomCode);
        console.log(`Room ${roomCode} deleted (empty)`);
      } else {
        room.state = 'lobby';
        room.players[0].ready = true;
        io.to(roomCode).emit('opponent_left');
        io.to(roomCode).emit('player_joined', { players: room.players });
        console.log(`Player left room ${roomCode}. Remaining player: ${room.players[0].name}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Number Hunt server running on port ${PORT}`);
});
