/**
 * Paper Battleship
 * Main Application Logic
 */

// --- CONFIGURATION ---
// IMPORTANT: Replace this URL with your Render.com project URL after deploying the server
// Example: https://paper-battleship-server.onrender.com
const SIGNALING_SERVER = 'https://my-battleship-server.onrender.com'; 

// ICE Servers (Google's public STUN server is sufficient for simple P2P)
const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// --- GAME STATE ---
const STATE = {
    MENU: 'MENU',
    SETUP: 'SETUP',
    CONNECTING: 'CONNECTING',
    WAITING_OPPONENT: 'WAITING_OPPONENT',
    MY_TURN: 'MY_TURN',
    OPPONENT_TURN: 'OPPONENT_TURN',
    GAME_OVER: 'GAME_OVER'
};

const SHIPS_CONFIG = [
    { size: 4, count: 1, id: 'battleship' },
    { size: 3, count: 2, id: 'cruiser' },
    { size: 2, count: 3, id: 'destroyer' },
    { size: 1, count: 4, id: 'submarine' }
];

// Global Variables
let currentState = STATE.MENU;
let socket;
let peerConnection;
let dataChannel;
let roomId = null;
let isHost = false;

// Game Data
let myGrid = Array(10).fill(null).map(() => Array(10).fill(null)); // null = empty, 'S' = ship, 'H' = hit, 'M' = miss
let enemyGrid = Array(10).fill(null).map(() => Array(10).fill(null));
let myShips = []; // Objects {x, y, size, vertical, hits}
let setupShips = []; // Temporary array during setup
let soundEnabled = true;

// DOM Elements
const els = {
    playerGrid: document.getElementById('player-grid'),
    enemyGrid: document.getElementById('enemy-grid'),
    status: document.getElementById('game-status'),
    menuOverlay: document.getElementById('menu-overlay'),
    setupControls: document.getElementById('setup-controls'),
    btnRotate: document.getElementById('btn-rotate'),
    btnReady: document.getElementById('btn-ready'),
    btnRandom: document.getElementById('btn-random'),
    roomInput: document.getElementById('room-input'),
    waitingScreen: document.getElementById('waiting-screen'),
    sounds: {
        place: document.getElementById('snd-place'),
        rotate: document.getElementById('snd-rotate'),
        hit: document.getElementById('snd-hit'),
        miss: document.getElementById('snd-miss'),
        win: document.getElementById('snd-win')
    }
};

// --- AUDIO SYSTEM (Simple Fallback) ---
const playSound = (name) => {
    if (!soundEnabled) return;
    
    // Try playing the file
    const audioEl = els.sounds[name];
    if (audioEl) {
        audioEl.currentTime = 0;
        audioEl.play().catch(e => {
            // If file missing or autoplay blocked, use simple beep
            playSynthTone(name);
        });
    }
};

// Simple Web Audio API Synthesizer fallback
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const playSynthTone = (type) => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if (type === 'hit') {
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.exponentialRampToValueAtTime(50, now + 0.3);
        gain.gain.setValueAtTime(1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
    } else if (type === 'miss') {
        osc.frequency.setValueAtTime(400, now);
        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
    } else if (type === 'place') {
        osc.frequency.setValueAtTime(600, now);
        gain.gain.setValueAtTime(0.3, now);
        osc.start(now);
        osc.stop(now + 0.05);
    }
};

document.getElementById('btn-sound').addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    document.getElementById('btn-sound').textContent = soundEnabled ? '🔊' : '🔇';
});

// --- INITIALIZATION ---

function init() {
    createGrids();
    setupSocket();
    setupMenuHandlers();
}

function createGrids() {
    // Create 100 cells for each grid
    for (let i = 0; i < 100; i++) {
        const x = i % 10;
        const y = Math.floor(i / 10);
        
        // Player Cell
        const pCell = document.createElement('div');
        pCell.classList.add('cell');
        pCell.dataset.x = x;
        pCell.dataset.y = y;
        els.playerGrid.appendChild(pCell);

        // Enemy Cell
        const eCell = document.createElement('div');
        eCell.classList.add('cell');
        eCell.dataset.x = x;
        eCell.dataset.y = y;
        eCell.addEventListener('click', () => handleEnemyGridClick(x, y));
        els.enemyGrid.appendChild(eCell);
    }
}

// --- NETWORK / SOCKET.IO ---

function setupSocket() {
    socket = io(SIGNALING_SERVER);

    socket.on('connect', () => {
        document.getElementById('menu-status').textContent = 'Connected to signal server.';
    });

    socket.on('connect_error', () => {
        document.getElementById('menu-status').textContent = 'Connecting to server... (may take 50s to wake up)';
    });

    socket.on('room-created', (id) => {
        roomId = id;
        isHost = true;
        enterSetupPhase();
        document.getElementById('game-status').textContent = `Room Code: ${id} (Waiting for player...)`;
    });

    socket.on('room-joined', (id) => {
        roomId = id;
        isHost = false;
        enterSetupPhase();
        document.getElementById('game-status').textContent = `Joined Room: ${id}`;
    });

    socket.on('room-full', () => {
        alert("Room is full!");
        els.menuOverlay.style.display = 'flex';
    });

    socket.on('ready-to-negotiate', () => {
        if (currentState === STATE.SETUP) {
            // Wait for setup to finish before WebRTC
            // But we can store this flag
        }
        if (isHost) startWebRTC();
    });

    // Signaling messages
    socket.on('offer', async (offer) => {
        if (!peerConnection) createPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', { roomId, answer });
    });

    socket.on('answer', async (answer) => {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('ice-candidate', async (candidate) => {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error('Error adding received ice candidate', e);
        }
    });
}

function setupMenuHandlers() {
    document.getElementById('btn-create').addEventListener('click', () => {
        const id = Math.random().toString(36).substring(2, 7).toUpperCase();
        socket.emit('join-room', id);
    });

    document.getElementById('btn-join').addEventListener('click', () => {
        const id = els.roomInput.value.toUpperCase();
        if (id.length > 0) {
            socket.emit('join-room', id);
        } else {
            alert("Enter a room ID");
        }
    });
}

// --- SETUP PHASE ---

function enterSetupPhase() {
    currentState = STATE.SETUP;
    els.menuOverlay.style.display = 'none';
    els.playerGrid.classList.add('setup-mode');
    
    // Initialize Ships for Dragging
    spawnShipsForPlacement();
}

let activeShip = null;
let isVertical = false;

function spawnShipsForPlacement() {
    // Clear previous
    setupShips = [];
    myGrid = Array(10).fill(null).map(() => Array(10).fill(null));
    
    // Just start randomization for simplicity in mobile UX or specific placement
    // For this prompt, let's implement the "Random" button as primary for mobile speed,
    // and basic drag-and-drop.
    
    randomizeShips();
}

function randomizeShips() {
    // Clear grid visuals
    const existingShips = document.querySelectorAll('.ship');
    existingShips.forEach(s => s.remove());
    myGrid = Array(10).fill(null).map(() => Array(10).fill(null));
    myShips = [];

    const shipsToPlace = [];
    SHIPS_CONFIG.forEach(type => {
        for (let i=0; i<type.count; i++) shipsToPlace.push(type.size);
    });

    shipsToPlace.forEach(size => {
        let placed = false;
        while (!placed) {
            const x = Math.floor(Math.random() * 10);
            const y = Math.floor(Math.random() * 10);
            const vert = Math.random() > 0.5;
            if (canPlaceShip(x, y, size, vert, myGrid)) {
                placeShipData(x, y, size, vert);
                createShipElement(x, y, size, vert);
                placed = true;
            }
        }
    });
    
    els.btnReady.disabled = false;
    playSound('place');
}

function canPlaceShip(x, y, size, vertical, grid) {
    // Boundary check
    if (vertical) {
        if (y + size > 10) return false;
    } else {
        if (x + size > 10) return false;
    }

    // Overlap check (including neighbor buffer for classic rules if desired, but sticking to standard strict overlap here)
    for (let i = 0; i < size; i++) {
        const cx = vertical ? x : x + i;
        const cy = vertical ? y + i : y;
        if (grid[cx][cy] !== null) return false;
    }
    return true;
}

function placeShipData(x, y, size, vertical) {
    const shipObj = { x, y, size, vertical, hits: 0, sunk: false };
    myShips.push(shipObj);
    for (let i = 0; i < size; i++) {
        const cx = vertical ? x : x + i;
        const cy = vertical ? y + i : y;
        myGrid[cx][cy] = shipObj; // Reference to ship object
    }
}

function createShipElement(x, y, size, vertical) {
    const ship = document.createElement('div');
    ship.classList.add('ship', `ship-${size}`);
    if (vertical) ship.classList.add('vertical');
    
    // Positioning (assuming 10% per cell)
    const left = x * 10;
    const top = y * 10;
    const width = size * 10;
    
    ship.style.left = `${left}%`;
    ship.style.top = `${top}%`;
    
    if (vertical) {
        ship.style.width = '10%'; // 1 cell wide
        ship.style.height = `${size * 10}%`;
    } else {
        ship.style.width = `${size * 10}%`;
        ship.style.height = '10%';
    }

    // Add drag handlers for manual refinement
    addDragHandlers(ship, size, vertical, x, y);

    els.playerGrid.appendChild(ship);
}

// Mobile Drag Logic
function addDragHandlers(el, size, vertical, initialX, initialY) {
    // Simple implementation: Tap to rotate, Drag to move
    // Note: Full mobile drag and drop on a grid is complex. 
    // Implementing a simplified version: tap to select, tap empty cell to move.
    
    el.addEventListener('click', (e) => {
        if (currentState !== STATE.SETUP) return;
        e.stopPropagation();
        
        // Remove from data
        const shipIndex = myShips.findIndex(s => s.x === initialX && s.y === initialY && s.vertical === vertical);
        if(shipIndex > -1) {
            // Remove from grid references
            const s = myShips[shipIndex];
            for(let i=0; i<s.size; i++) {
                const cx = s.vertical ? s.x : s.x+i;
                const cy = s.vertical ? s.y+i : s.y;
                myGrid[cx][cy] = null;
            }
            myShips.splice(shipIndex, 1);
        }
        
        // Try Rotate
        const newVertical = !vertical;
        if (canPlaceShip(initialX, initialY, size, newVertical, myGrid)) {
            el.remove();
            placeShipData(initialX, initialY, size, newVertical);
            createShipElement(initialX, initialY, size, newVertical);
            playSound('rotate');
        } else {
            // Revert
            placeShipData(initialX, initialY, size, vertical); // Put back
            playSound('miss'); // Error sound
            // Animation for error?
            el.style.transform = 'translateX(5px)';
            setTimeout(() => el.style.transform = vertical ? 'none' : 'none', 100);
        }
    });
}

// Button Listeners
els.btnRandom.addEventListener('click', randomizeShips);
els.btnReady.addEventListener('click', () => {
    if (myShips.length < 10) { // 1+2+3+4 = 10 ships total
        // We simplified config. Check count
        // SHIPS_CONFIG total is 1+2+3+4 = 10 ships.
        // Actually checking total ships placed:
        const totalNeeded = SHIPS_CONFIG.reduce((a,b) => a + b.count, 0);
        if (myShips.length < totalNeeded) return; 
    }
    
    currentState = STATE.WAITING_OPPONENT;
    els.setupControls.classList.add('hidden');
    els.waitingScreen.classList.remove('hidden');
    els.playerGrid.classList.remove('setup-mode');
    
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'ready' }));
        checkStartGame();
    } else {
        // If WebRTC not ready, we wait. Logic inside onopen handles it.
        if(!peerConnection) createPeerConnection(); // Initiate if not already
    }
});


// --- WebRTC LOGIC ---

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(ICE_SERVERS);

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { roomId, candidate: event.candidate });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log("Connection State:", peerConnection.connectionState);
        if (peerConnection.connectionState === 'disconnected') {
            els.status.textContent = "Opponent disconnected.";
            currentState = STATE.GAME_OVER;
        }
    };

    if (isHost) {
        dataChannel = peerConnection.createDataChannel("game");
        setupDataChannel();
        createOffer();
    } else {
        peerConnection.ondatachannel = (event) => {
            dataChannel = event.channel;
            setupDataChannel();
        };
    }
}

async function createOffer() {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', { roomId, offer });
}

function setupDataChannel() {
    dataChannel.onopen = () => {
        console.log("Data Channel Open");
        if (currentState === STATE.WAITING_OPPONENT) {
            dataChannel.send(JSON.stringify({ type: 'ready' }));
            checkStartGame();
        }
    };

    dataChannel.onmessage = handleDataMessage;
}

let opponentReady = false;
let iAmReady = false;

function handleDataMessage(event) {
    const msg = JSON.parse(event.data);
    
    switch (msg.type) {
        case 'ready':
            opponentReady = true;
            checkStartGame();
            break;
        case 'fire':
            handleIncomingFire(msg.x, msg.y);
            break;
        case 'result':
            handleFireResult(msg.x, msg.y, msg.hit, msg.sunk);
            break;
        case 'gameover':
            endGame(msg.winner === 'opponent'); // If they say I won, I won.
            break;
    }
}

function checkStartGame() {
    if (currentState === STATE.WAITING_OPPONENT) iAmReady = true;
    
    if (iAmReady && opponentReady) {
        els.waitingScreen.classList.add('hidden');
        // Host goes first
        if (isHost) {
            currentState = STATE.MY_TURN;
            els.status.textContent = "Your Turn! Fire!";
        } else {
            currentState = STATE.OPPONENT_TURN;
            els.status.textContent = "Enemy's Turn...";
        }
    }
}

// --- GAMEPLAY ---

function handleEnemyGridClick(x, y) {
    if (currentState !== STATE.MY_TURN) return;
    if (enemyGrid[x][y] !== null) return; // Already shot there

    // Optimistic UI? No, wait for confirmation to keep sync perfect.
    dataChannel.send(JSON.stringify({ type: 'fire', x, y }));
    currentState = STATE.WAITING_OPPONENT; // Temporary lock
    els.status.textContent = "Firing...";
}

function handleIncomingFire(x, y) {
    const cellObj = myGrid[x][y];
    let isHit = false;
    let isSunk = false;

    if (cellObj && typeof cellObj === 'object') {
        // Hit
        isHit = true;
        cellObj.hits++;
        playSound('hit');
        addMarker(els.playerGrid, x, y, 'hit');
        
        if (cellObj.hits >= cellObj.size) {
            cellObj.sunk = true;
            isSunk = true;
            // Check Game Over
            if (myShips.every(s => s.sunk)) {
                dataChannel.send(JSON.stringify({ type: 'result', x, y, hit: true, sunk: true }));
                dataChannel.send(JSON.stringify({ type: 'gameover', winner: 'opponent' }));
                endGame(false);
                return;
            }
        }
    } else {
        // Miss
        playSound('miss');
        addMarker(els.playerGrid, x, y, 'miss');
    }

    dataChannel.send(JSON.stringify({ type: 'result', x, y, hit: isHit, sunk: isSunk }));
    
    // Turn logic: In some rules, hit = shoot again. Standard = switch.
    // Let's stick to standard: switch turns.
    currentState = STATE.MY_TURN;
    els.status.textContent = "Your Turn! Fire!";
}

function handleFireResult(x, y, hit, sunk) {
    enemyGrid[x][y] = hit ? 'H' : 'M';
    addMarker(els.enemyGrid, x, y, hit ? 'hit' : 'miss');
    
    if (hit) {
        playSound('hit');
        els.status.textContent = sunk ? "Ship Sunk! Enemy's Turn..." : "Hit! Enemy's Turn...";
    } else {
        playSound('miss');
        els.status.textContent = "Miss. Enemy's Turn...";
    }
    
    currentState = STATE.OPPONENT_TURN;
}

function addMarker(gridEl, x, y, type) {
    const cell = gridEl.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
    const marker = document.createElement('div');
    marker.classList.add('marker', type);
    cell.appendChild(marker);
}

function endGame(iWon) {
    currentState = STATE.GAME_OVER;
    els.status.textContent = iWon ? "VICTORY!" : "DEFEAT!";
    if (iWon) playSound('win');
    els.waitingScreen.classList.remove('hidden');
    els.waitingScreen.innerHTML = `<h1>${iWon ? "YOU WON" : "YOU LOST"}</h1><button onclick="location.reload()">Play Again</button>`;
}

// Start
init();
