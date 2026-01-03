/**
 * Paper Battleship
 * Main Application Logic
 */

// --- CONFIGURATION ---
const SIGNALING_SERVER = 'https://battleship-server-test.onrender.com'; 

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
    roomDisplay: document.getElementById('room-display'), // New
    btnCopyLink: document.getElementById('btn-copy-link'), // New
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
    } else if (type === 'sunk') {
        // Deeper boom for sunk
        osc.frequency.setValueAtTime(100, now);
        osc.frequency.exponentialRampToValueAtTime(10, now + 0.5);
        gain.gain.setValueAtTime(1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
        osc.start(now); osc.stop(now + 0.5);
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
    checkUrlParams();
}

function checkUrlParams() {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
        els.roomInput.value = roomParam;
        // Optional: Auto-join could be added here, but manual click is safer for now
    }
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
        updateRoomUI(id);
    });

    socket.on('room-joined', (id) => {
        roomId = id;
        isHost = false;
        enterSetupPhase();
        updateRoomUI(id);
    });

    socket.on('room-full', () => {
        alert("Room is full!");
        els.menuOverlay.style.display = 'flex';
    });

    socket.on('ready-to-negotiate', () => {
        console.log("Opponent joined, starting WebRTC...");
        document.getElementById('game-status').textContent = "Opponent found! Connecting...";
        if (isHost) startWebRTC();
    });

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
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    });
}

function updateRoomUI(id) {
    els.roomDisplay.classList.remove('hidden');
    els.roomDisplay.querySelector('span').textContent = id;
    
    // Update URL without reloading to make sharing easier
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?room=' + id;
    window.history.pushState({path:newUrl},'',newUrl);
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
        } else alert("Enter a room ID");
    });
    
    els.btnCopyLink.addEventListener('click', () => {
        const url = window.location.href;
        navigator.clipboard.writeText(url).then(() => {
            alert("Link copied! Send it to your friend.");
        });
    });
}

// --- SETUP PHASE ---

function enterSetupPhase() {
    currentState = STATE.SETUP;
    els.body.classList.add('state-setup');
    els.menuOverlay.style.display = 'none';
    els.playerGrid.classList.add('setup-mode');
    randomizeShips();
}

function randomizeShips() {
    // Clear DOM and Data
    document.querySelectorAll('.ship').forEach(s => s.remove());
    myGrid = Array(10).fill(null).map(() => Array(10).fill(null));
    myShips = [];

    const shipsToPlace = [];
    SHIPS_CONFIG.forEach(type => {
        for (let i=0; i<type.count; i++) shipsToPlace.push(type.size);
    });

    // Try to place all ships. If fails, retry the whole board up to X times
    let attempts = 0;
    let success = false;
    
    while (!success && attempts < 500) {
        attempts++;
        // Temp grid for this attempt
        let tempGrid = Array(10).fill(null).map(() => Array(10).fill(null));
        let tempShips = [];
        let placementFailed = false;

        for (let size of shipsToPlace) {
            let placed = false;
            let shipAttempts = 0;
            while (!placed && shipAttempts < 100) {
                shipAttempts++;
                const x = Math.floor(Math.random() * 10);
                const y = Math.floor(Math.random() * 10);
                const vert = Math.random() > 0.5;
                
                if (canPlaceShip(x, y, size, vert, tempGrid)) {
                    // Place in temp data
                    const shipObj = { x, y, size, vertical: vert, hits: 0, sunk: false };
                    tempShips.push(shipObj);
                    for (let i = 0; i < size; i++) {
                        const cx = vert ? x : x + i;
                        const cy = vert ? y + i : y;
                        tempGrid[cx][cy] = shipObj;
                    }
                    placed = true;
                }
            }
            if (!placed) {
                placementFailed = true;
                break;
            }
        }

        if (!placementFailed) {
            success = true;
            // Apply to real game
            myGrid = tempGrid;
            myShips = tempShips;
            // Render
            myShips.forEach(s => createShipElement(s.x, s.y, s.size, s.vertical));
        }
    }
    
    if(!success) {
        console.warn("Could not randomize ships. Try again.");
        // Fallback or just let user click again
    } else {
        els.btnReady.disabled = false;
        playSound('place');
    }
}

// UPDATED: Strict spacing rules (1 cell gap)
function canPlaceShip(x, y, size, vertical, grid) {
    // 1. Boundary check
    if (vertical) { if (y + size > 10) return false; } 
    else { if (x + size > 10) return false; }

    // 2. Overlap and Gap check
    for (let i = 0; i < size; i++) {
        const cx = vertical ? x : x + i;
        const cy = vertical ? y + i : y;

        // Check the cell itself and all 8 neighbors
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const nx = cx + dx;
                const ny = cy + dy;

                // Check board bounds
                if (nx >= 0 && nx < 10 && ny >= 0 && ny < 10) {
                    if (grid[nx][ny] !== null) return false;
                }
            }
        }
    }
    return true;
}

function placeShipData(x, y, size, vertical) {
    // Note: randomizeShips handles the full grid generation now to prevent bugs.
    // This is kept for manual drag/drop future implementation
}

function createShipElement(x, y, size, vertical) {
    const ship = document.createElement('div');
    ship.classList.add('ship', `ship-${size}`);
    if (vertical) ship.classList.add('vertical');
    
    ship.style.left = `${x * 10}%`;
    ship.style.top = `${y * 10}%`;
    
    if (vertical) {
        ship.style.width = '10%'; 
        ship.style.height = `${size * 10}%`;
    } else {
        ship.style.width = `${size * 10}%`;
        ship.style.height = '10%';
    }

    // Tap to rotate logic
    ship.addEventListener('click', (e) => {
        if (currentState !== STATE.SETUP) return;
        e.stopPropagation();
        
        // Remove current ship from data
        const shipIndex = myShips.findIndex(s => s.x === x && s.y === y && s.vertical === vertical);
        if (shipIndex === -1) return;
        
        // Temporarily clear grid spots for this ship so we can check if rotation fits
        const currentShip = myShips[shipIndex];
        const tempGrid = myGrid.map(row => [...row]); // Deep copy rows
        
        // Remove ship from temp grid
        for(let i=0; i<currentShip.size; i++) {
            const cx = currentShip.vertical ? currentShip.x : currentShip.x+i;
            const cy = currentShip.vertical ? currentShip.y+i : currentShip.y;
            tempGrid[cx][cy] = null;
        }

        const newVertical = !vertical;
        
        // Check if rotated ship fits in the temp grid (which has the current ship removed)
        if (canPlaceShip(x, y, size, newVertical, tempGrid)) {
            // It fits! Remove old DOM
            ship.remove();
            // Remove from real data
            myShips.splice(shipIndex, 1);
            // Clear real grid
            for(let i=0; i<currentShip.size; i++) {
                const cx = currentShip.vertical ? currentShip.x : currentShip.x+i;
                const cy = currentShip.vertical ? currentShip.y+i : currentShip.y;
                myGrid[cx][cy] = null;
            }

            // Place new
            const newShipObj = { x, y, size, vertical: newVertical, hits: 0, sunk: false };
            myShips.push(newShipObj);
            for (let i = 0; i < size; i++) {
                const cx = newVertical ? x : x + i;
                const cy = newVertical ? y + i : y;
                myGrid[cx][cy] = newShipObj;
            }
            createShipElement(x, y, size, newVertical);
            playSound('rotate');
        } else {
            // Shake effect or feedback?
            ship.style.transform = "translateX(5px)";
            setTimeout(() => ship.style.transform = "none", 100);
        }
    });

    els.playerGrid.appendChild(ship);
}

els.btnRandom.addEventListener('click', randomizeShips);
els.btnReady.addEventListener('click', () => {
    els.setupControls.classList.add('hidden');
    els.playerGrid.classList.remove('setup-mode');
    
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'ready' }));
        iAmReady = true;
        currentState = STATE.WAITING_OPPONENT;
        els.status.textContent = "Waiting for opponent...";
        checkStartGame();
    } else {
        iAmReady = true;
        currentState = STATE.WAITING_OPPONENT;
        els.status.textContent = "Waiting for connection...";
    }
});


// --- WebRTC ---
function startWebRTC() {
    createPeerConnection();
    createOffer();
}

function createPeerConnection() {
    if (peerConnection) return;
    peerConnection = new RTCPeerConnection(ICE_SERVERS);
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) socket.emit('ice-candidate', { roomId, candidate: event.candidate });
    };
    peerConnection.onconnectionstatechange = () => {
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
    switch (msg.type) {
        case 'ready':
            opponentReady = true;
            checkStartGame();
            break;
        case 'fire':
            handleIncomingFire(msg.x, msg.y);
            break;
        case 'result':
            handleFireResult(msg.x, msg.y, msg.hit, msg.sunk, msg.ship);
            break;
        case 'gameover':
            endGame(msg.winner === 'opponent'); 
            break;
    }
}

function checkStartGame() {
    if (iAmReady && opponentReady) {
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
    let sunkShipData = null;

    if (cellObj && typeof cellObj === 'object') {
        isHit = true;
        cellObj.hits++;
        addMarker(els.playerGrid, x, y, 'hit');
        
        if (cellObj.hits >= cellObj.size) {
            cellObj.sunk = true;
            isSunk = true;
            playSound('sunk');
            // Prepare data to send to opponent so they can draw the sunk ship
            sunkShipData = { x: cellObj.x, y: cellObj.y, size: cellObj.size, vertical: cellObj.vertical };
            
            if (myShips.every(s => s.sunk)) {
                dataChannel.send(JSON.stringify({ 
                    type: 'result', x, y, hit: true, sunk: true, ship: sunkShipData 
                }));
                dataChannel.send(JSON.stringify({ type: 'gameover', winner: 'opponent' }));
                endGame(false);
                return;
            }
        } else {
            playSound('hit');
        }
    } else {
        playSound('miss');
        addMarker(els.playerGrid, x, y, 'miss');
    }

    dataChannel.send(JSON.stringify({ 
        type: 'result', x, y, hit: isHit, sunk: isSunk, ship: sunkShipData 
    }));
    currentState = STATE.MY_TURN;
    els.status.textContent = "Your Turn! Fire!";
}

function handleFireResult(x, y, hit, sunk, shipData) {
    enemyGrid[x][y] = hit ? 'H' : 'M';
    
    if (sunk && shipData) {
        // Mark the specific hit that caused the sink
        addMarker(els.enemyGrid, x, y, 'hit'); // Add hit first
        
        // Now visually reveal the sunk ship on the enemy board
        // We can either draw a ship element OR change markers to 'sunk' style
        drawEnemySunkShip(shipData);
        playSound('sunk');
        els.status.textContent = "SHIP SUNK! Enemy's Turn...";
    } else if (hit) {
        playSound('hit');
        addMarker(els.enemyGrid, x, y, 'hit');
        els.status.textContent = "HIT! Enemy's Turn...";
    } else {
        playSound('miss');
        addMarker(els.enemyGrid, x, y, 'miss');
        els.status.textContent = "MISS. Enemy's Turn...";
    }
    currentState = STATE.OPPONENT_TURN;
}

function drawEnemySunkShip(ship) {
    // 1. Visually add the ship (like in setup) but on enemy grid
    const shipEl = document.createElement('div');
    shipEl.classList.add('ship', `ship-${ship.size}`, 'sunk-ship');
    if (ship.vertical) shipEl.classList.add('vertical');
    
    shipEl.style.left = `${ship.x * 10}%`;
    shipEl.style.top = `${ship.y * 10}%`;
    
    if (ship.vertical) {
        shipEl.style.width = '10%'; 
        shipEl.style.height = `${ship.size * 10}%`;
    } else {
        shipEl.style.width = `${ship.size * 10}%`;
        shipEl.style.height = '10%';
    }
    els.enemyGrid.appendChild(shipEl);

    // 2. Update markers covered by this ship to be darker/invisible?
    // Actually, keeping the red Hit markers ON TOP of the ship looks good (classic style)
}

function addMarker(gridEl, x, y, type) {
    const cell = gridEl.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
    // Remove existing if any
    const existing = cell.querySelector('.marker');
    if (existing) existing.remove();
    
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
