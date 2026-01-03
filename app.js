/**
 * Paper Battleship
 * Main Application Logic
 */

// --- CONFIGURATION ---
// IMPORTANT: Replace this URL with your Render.com project URL
const SIGNALING_SERVER = 'https://my-battleship-server.onrender.com'; 

// ICE Servers
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
let myGrid = Array(10).fill(null).map(() => Array(10).fill(null));
let enemyGrid = Array(10).fill(null).map(() => Array(10).fill(null));
let myShips = []; 
let soundEnabled = true;

// DOM Elements
const els = {
    body: document.body,
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

// --- AUDIO SYSTEM ---
const playSound = (name) => {
    if (!soundEnabled) return;
    const audioEl = els.sounds[name];
    if (audioEl) {
        audioEl.currentTime = 0;
        audioEl.play().catch(e => playSynthTone(name));
    }
};

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
        osc.start(now); osc.stop(now + 0.3);
    } else if (type === 'miss') {
        osc.frequency.setValueAtTime(400, now);
        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now); osc.stop(now + 0.1);
    } else if (type === 'place' || type === 'rotate') {
        osc.frequency.setValueAtTime(600, now);
        gain.gain.setValueAtTime(0.3, now);
        osc.start(now); osc.stop(now + 0.05);
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
    for (let i = 0; i < 100; i++) {
        const x = i % 10;
        const y = Math.floor(i / 10);
        
        const pCell = document.createElement('div');
        pCell.classList.add('cell');
        pCell.dataset.x = x;
        pCell.dataset.y = y;
        els.playerGrid.appendChild(pCell);

        const eCell = document.createElement('div');
        eCell.classList.add('cell');
        eCell.dataset.x = x;
        eCell.dataset.y = y;
        eCell.addEventListener('click', () => handleEnemyGridClick(x, y));
        els.enemyGrid.appendChild(eCell);
    }
}

// --- NETWORK ---

function setupSocket() {
    socket = io(SIGNALING_SERVER);

    socket.on('connect', () => {
        document.getElementById('menu-status').textContent = 'Server Online';
    });
    
    socket.on('connect_error', () => {
        document.getElementById('menu-status').textContent = 'Waking up server... (wait 1 min)';
    });

    socket.on('room-created', (id) => {
        roomId = id;
        isHost = true;
        enterSetupPhase();
        document.getElementById('game-status').innerHTML = `Room Code: <b>${id}</b> <br><small>Tell opponent to join!</small>`;
    });

    socket.on('room-joined', (id) => {
        roomId = id;
        isHost = false;
        enterSetupPhase();
        document.getElementById('game-status').innerHTML = `Room: <b>${id}</b> <br><small>Connected. Place ships.</small>`;
    });

    socket.on('room-full', () => {
        alert("Room is full!");
        els.menuOverlay.style.display = 'flex';
    });

    socket.on('ready-to-negotiate', () => {
        // Opponent has joined!
        console.log("Opponent joined, starting WebRTC...");
        document.getElementById('game-status').textContent = "Opponent here! Connecting...";
        if (isHost) startWebRTC();
    });

    socket.on('offer', async (offer) => {
        console.log("Received Offer");
        if (!peerConnection) createPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', { roomId, answer });
    });

    socket.on('answer', async (answer) => {
        console.log("Received Answer");
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('ice-candidate', async (candidate) => {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    });
}

function setupMenuHandlers() {
    document.getElementById('btn-create').addEventListener('click', () => {
        const id = Math.random().toString(36).substring(2, 7).toUpperCase();
        console.log("Creating room:", id);
        socket.emit('join-room', id);
    });

    document.getElementById('btn-join').addEventListener('click', () => {
        const id = els.roomInput.value.toUpperCase();
        if (id.length > 0) {
            console.log("Joining room:", id);
            socket.emit('join-room', id);
        } else alert("Enter a room ID");
    });
}

// --- SETUP PHASE ---

function enterSetupPhase() {
    currentState = STATE.SETUP;
    // Add CSS class to body to handle responsive layout (hide enemy board)
    els.body.classList.add('state-setup');
    
    els.menuOverlay.style.display = 'none';
    els.playerGrid.classList.add('setup-mode');
    randomizeShips();
}

function randomizeShips() {
    // Clear
    document.querySelectorAll('.ship').forEach(s => s.remove());
    myGrid = Array(10).fill(null).map(() => Array(10).fill(null));
    myShips = [];

    const shipsToPlace = [];
    SHIPS_CONFIG.forEach(type => {
        for (let i=0; i<type.count; i++) shipsToPlace.push(type.size);
    });

    shipsToPlace.forEach(size => {
        let placed = false;
        let attempts = 0;
        while (!placed && attempts < 100) {
            attempts++;
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
    if (vertical) { if (y + size > 10) return false; } 
    else { if (x + size > 10) return false; }

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
        myGrid[cx][cy] = shipObj;
    }
}

function createShipElement(x, y, size, vertical) {
    const ship = document.createElement('div');
    ship.classList.add('ship', `ship-${size}`);
    if (vertical) ship.classList.add('vertical');
    
    // Positioning using CSS Grid Logic (Percentages)
    // The grid is 10x10. Each cell is 10%.
    
    ship.style.left = `${x * 10}%`;
    ship.style.top = `${y * 10}%`;
    
    if (vertical) {
        ship.style.width = '10%'; 
        ship.style.height = `${size * 10}%`;
    } else {
        ship.style.width = `${size * 10}%`;
        ship.style.height = '10%';
    }

    // Touch/Click to Rotate/Delete/Move
    ship.addEventListener('click', (e) => {
        if (currentState !== STATE.SETUP) return;
        e.stopPropagation();
        
        // Find and Remove old
        const shipIndex = myShips.findIndex(s => s.x === x && s.y === y && s.vertical === vertical);
        if(shipIndex > -1) {
            const s = myShips[shipIndex];
            for(let i=0; i<s.size; i++) {
                const cx = s.vertical ? s.x : s.x+i;
                const cy = s.vertical ? s.y+i : s.y;
                myGrid[cx][cy] = null;
            }
            myShips.splice(shipIndex, 1);
        }
        ship.remove();

        // Try to Rotate
        const newVertical = !vertical;
        if (canPlaceShip(x, y, size, newVertical, myGrid)) {
            placeShipData(x, y, size, newVertical);
            createShipElement(x, y, size, newVertical);
            playSound('rotate');
        } else {
            // Can't rotate? Put it back original
            placeShipData(x, y, size, vertical);
            createShipElement(x, y, size, vertical);
            // Visual feedback failure?
        }
    });

    els.playerGrid.appendChild(ship);
}

// Button Listeners
els.btnRandom.addEventListener('click', randomizeShips);

els.btnReady.addEventListener('click', () => {
    els.setupControls.classList.add('hidden');
    els.playerGrid.classList.remove('setup-mode');
    
    // Check if channel is already open (maybe opponent was super fast)
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'ready' }));
        iAmReady = true;
        currentState = STATE.WAITING_OPPONENT;
        els.status.textContent = "Waiting for opponent to be ready...";
        checkStartGame();
    } else {
        // If not connected yet, we wait.
        iAmReady = true;
        currentState = STATE.WAITING_OPPONENT;
        els.status.textContent = "Waiting for connection & opponent...";
        // If peerConnection doesn't exist, we try to create it (should have happened via sockets though)
        if(!peerConnection) console.log("Waiting for WebRTC...");
    }
});


// --- WebRTC ---

// THIS WAS MISSING IN PREVIOUS VERSION
function startWebRTC() {
    createPeerConnection();
    createOffer();
}

function createPeerConnection() {
    if (peerConnection) return; // Don't create twice

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
        console.log("Data Channel OPEN");
        if (iAmReady) {
            dataChannel.send(JSON.stringify({ type: 'ready' }));
            els.status.textContent = "Connection established. Waiting for opponent...";
        }
    };
    dataChannel.onmessage = handleDataMessage;
}

let opponentReady = false;
let iAmReady = false;

function handleDataMessage(event) {
    const msg = JSON.parse(event.data);
    console.log("Received data:", msg);
    
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
            endGame(msg.winner === 'opponent'); 
            break;
    }
}

function checkStartGame() {
    console.log(`Check Start: Me=${iAmReady}, Opp=${opponentReady}`);
    
    if (iAmReady && opponentReady) {
        // Change Layout State for Gameplay
        els.body.classList.remove('state-setup');
        els.body.classList.add('state-playing');
        
        els.waitingScreen.classList.add('hidden');
        if (isHost) {
            currentState = STATE.MY_TURN;
            els.status.textContent = "Your Turn! Fire!";
        } else {
            currentState = STATE.OPPONENT_TURN;
            els.status.textContent = "Enemy's Turn...";
        }
    } else if (iAmReady && !opponentReady) {
        els.status.textContent = "You are ready. Waiting for opponent...";
        els.waitingScreen.classList.remove('hidden');
    }
}

// --- GAMEPLAY ---

function handleEnemyGridClick(x, y) {
    if (currentState !== STATE.MY_TURN) return;
    if (enemyGrid[x][y] !== null) return; 

    dataChannel.send(JSON.stringify({ type: 'fire', x, y }));
    currentState = STATE.WAITING_OPPONENT;
    els.status.textContent = "Firing...";
}

function handleIncomingFire(x, y) {
    const cellObj = myGrid[x][y];
    let isHit = false;
    let isSunk = false;

    if (cellObj && typeof cellObj === 'object') {
        isHit = true;
        cellObj.hits++;
        playSound('hit');
        addMarker(els.playerGrid, x, y, 'hit');
        
        if (cellObj.hits >= cellObj.size) {
            cellObj.sunk = true;
            isSunk = true;
            if (myShips.every(s => s.sunk)) {
                dataChannel.send(JSON.stringify({ type: 'result', x, y, hit: true, sunk: true }));
                dataChannel.send(JSON.stringify({ type: 'gameover', winner: 'opponent' }));
                endGame(false);
                return;
            }
        }
    } else {
        playSound('miss');
        addMarker(els.playerGrid, x, y, 'miss');
    }

    dataChannel.send(JSON.stringify({ type: 'result', x, y, hit: isHit, sunk: isSunk }));
    currentState = STATE.MY_TURN;
    els.status.textContent = "Your Turn! Fire!";
}

function handleFireResult(x, y, hit, sunk) {
    enemyGrid[x][y] = hit ? 'H' : 'M';
    addMarker(els.enemyGrid, x, y, hit ? 'hit' : 'miss');
    
    if (hit) {
        playSound('hit');
        els.status.textContent = sunk ? "SUNK! Enemy's Turn..." : "HIT! Enemy's Turn...";
    } else {
        playSound('miss');
        els.status.textContent = "MISS. Enemy's Turn...";
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

init();
