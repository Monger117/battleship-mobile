/**
 * Paper Battleship - Admiral Edition 2.0
 */

const CONFIG = {
    SERVER_URL: 'https://my-battleship-server.onrender.com', // Replace if you have your own
    ICE_SERVERS: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
    XP_LEVEL_FACTOR: 200, 
    RANKS: ["Юнга", "Матрос", "Старшина", "Мичман", "Лейтенант", "Капитан", "Командор", "Адмирал"]
};

// --- STATE ---
const STATE = {
    user: { id: null, username: null, xp: 0, level: 1 },
    socket: null,
    peer: null,
    dc: null, 
    gameMode: null, // 'BOT' or 'ONLINE'
    gameState: 'MENU',
    isMyTurn: false,
    sound: false,
    roomId: null,
    bot: null,
    pendingInvite: null
};

// --- DATA ---
let myGrid = [], enemyGrid = [], myShips = [], enemyShipsSunk = 0;
// Ships: 4x1, 3x2, 2x3, 1x4
const SHIPS_STRUCT = [ {s:4,c:1}, {s:3,c:2}, {s:2,c:3}, {s:1,c:4} ];

// --- DOM HELPERS ---
const $ = (id) => document.getElementById(id);
const screens = {
    login: $('screen-login'),
    menu: $('screen-menu'),
    friends: $('screen-friends'),
    game: $('screen-game')
};

// --- INITIALIZATION ---
window.addEventListener('load', () => {
    loadUserData();
    setupAudio();
    initUI();
    // Connect socket if we have internet, but don't block
    if(navigator.onLine) connectSocket();
});

// --- AUTH & PROGRESSION ---
function loadUserData() {
    const stored = localStorage.getItem('battleship_user');
    if (stored) {
        try {
            STATE.user = JSON.parse(stored);
            if(!STATE.user.id) throw new Error("No ID");
            showScreen('menu');
            updateProfileUI();
        } catch(e) { showScreen('login'); }
    } else {
        showScreen('login');
    }
}

function saveUserData() {
    localStorage.setItem('battleship_user', JSON.stringify(STATE.user));
    updateProfileUI();
}

function addXP(amount) {
    STATE.user.xp += amount;
    const newLevel = Math.floor(1 + Math.sqrt(STATE.user.xp / CONFIG.XP_LEVEL_FACTOR));
    if (newLevel > STATE.user.level) {
        alert(`⭐ ПОВЫШЕНИЕ! Теперь вы уровень ${newLevel}: ${CONFIG.RANKS[Math.min(newLevel-1, CONFIG.RANKS.length-1)]}`);
    }
    STATE.user.level = newLevel;
    saveUserData();
}

function updateProfileUI() {
    $('display-username').textContent = STATE.user.username;
    $('display-level').textContent = STATE.user.level;
    
    let rankIndex = Math.min(STATE.user.level - 1, CONFIG.RANKS.length - 1);
    $('display-rank').textContent = CONFIG.RANKS[rankIndex];
    
    // XP Bar Math
    const currentLvlXP = Math.pow(STATE.user.level - 1, 2) * CONFIG.XP_LEVEL_FACTOR;
    const nextLvlXP = Math.pow(STATE.user.level, 2) * CONFIG.XP_LEVEL_FACTOR;
    const range = nextLvlXP - currentLvlXP;
    const progress = (STATE.user.xp - currentLvlXP) / range;
    $('xp-bar-fill').style.width = `${Math.min(100, Math.max(0, progress * 100))}%`;
}

// --- UI NAVIGATION ---
function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
    
    if (name === 'menu') {
        if(STATE.socket && STATE.roomId) STATE.socket.emit('leave-room', STATE.roomId);
        if(!STATE.sound) toggleSound(false); // Try auto-start music
    }
    if (name === 'friends') {
        if(STATE.socket) STATE.socket.emit('get-online-users');
    }
}

function initUI() {
    // Login
    $('btn-login').onclick = () => {
        const name = $('inp-username').value.trim();
        if (!name) return alert('Введите имя!');
        STATE.user.username = name;
        if (!STATE.user.id) STATE.user.id = crypto.randomUUID();
        saveUserData();
        if (STATE.socket) STATE.socket.emit('login', STATE.user);
        showScreen('menu');
    };

    // Menu
    $('btn-play-bot').onclick = startBotGame;
    $('btn-play-online').onclick = () => {
        if(!STATE.socket || !STATE.socket.connected) {
            alert("Нет подключения к серверу :(");
            connectSocket(); 
        } else {
            showScreen('friends');
        }
    };
    $('btn-friends').onclick = $('btn-play-online').onclick;
    $('btn-settings').onclick = () => {
        if(confirm("Сбросить весь прогресс?")) {
            localStorage.removeItem('battleship_user');
            location.reload();
        }
    };

    // Friends / Online
    $('.btn-back').forEach(b => b.onclick = () => showScreen(b.dataset.target));
    $('btn-create-room').onclick = () => STATE.socket.emit('join-room', Math.random().toString(36).substr(2, 5).toUpperCase());
    $('btn-join-room').onclick = () => {
        const val = $('room-input').value.toUpperCase();
        if(val) STATE.socket.emit('join-room', val);
    };

    // Game
    $('btn-rotate').onclick = () => rotateShipInSetup(); // Note: kept implementation simple, assuming randomization mostly used
    $('btn-random').onclick = randomizeShips;
    $('btn-ready').onclick = playerReady;
    $('btn-surrender').onclick = () => { if(confirm("Сдаться?")) endGame(false); };
    
    // Modals
    $('btn-to-menu').onclick = () => {
        $('modal-endgame').classList.add('hidden');
        showScreen('menu');
    };
    $('btn-accept-invite').onclick = acceptChallenge;
    $('btn-decline-invite').onclick = () => $('modal-invite').classList.add('hidden');
    $('btn-sound-toggle').onclick = () => toggleSound();
}

// --- AUDIO ---
function setupAudio() {
    const bg = $('bg-music');
    bg.volume = 0.2;
}
function toggleSound(force) {
    const bg = $('bg-music');
    STATE.sound = force !== undefined ? force : !STATE.sound;
    $('btn-sound-toggle').textContent = STATE.sound ? '🔊' : '🔇';
    if (STATE.sound) bg.play().catch(()=>{});
    else bg.pause();
}
function playSfx(id) {
    if (STATE.sound) {
        const el = $(`snd-${id}`);
        if(el) { el.currentTime = 0; el.play().catch(()=>{}); }
    }
}

// --- GAME LOGIC ---
function resetGame() {
    $('player-grid').innerHTML = '';
    $('enemy-grid').innerHTML = '';
    createGrids();
    $('btn-ready').disabled = true;
    $('btn-ready').textContent = "В БОЙ!";
    $('setup-controls').classList.remove('hidden');
    STATE.gameState = 'SETUP';
    enemyShipsSunk = 0;
    STATE.isMyTurn = false;
}

function createGrids() {
    for (let i = 0; i < 100; i++) {
        const x = i % 10, y = Math.floor(i / 10);
        // Player Cell
        const pCell = document.createElement('div');
        pCell.className = 'cell'; pCell.dataset.x = x; pCell.dataset.y = y;
        $('player-grid').appendChild(pCell);
        // Enemy Cell
        const eCell = document.createElement('div');
        eCell.className = 'cell'; eCell.dataset.x = x; eCell.dataset.y = y;
        eCell.onclick = () => handleAttack(x, y);
        $('enemy-grid').appendChild(eCell);
    }
    myGrid = Array(10).fill(0).map(()=>Array(10).fill(null));
    enemyGrid = Array(10).fill(0).map(()=>Array(10).fill(null));
}

function randomizeShips() {
    document.querySelectorAll('.ship').forEach(s => s.remove());
    myGrid = Array(10).fill(null).map(() => Array(10).fill(null));
    myShips = [];
    
    const ships = [];
    SHIPS_STRUCT.forEach(t => { for(let i=0; i<t.c; i++) ships.push(t.s); });

    ships.forEach(size => {
        let placed = false;
        while(!placed) {
            const x = Math.floor(Math.random()*10);
            const y = Math.floor(Math.random()*10);
            const v = Math.random() > 0.5;
            if(canPlace(x,y,size,v,myGrid)) {
                placeShip(x,y,size,v);
                placed = true;
            }
        }
    });
    $('btn-ready').disabled = false;
    playSfx('place');
}

function canPlace(x, y, size, v, grid) {
    if (v) { if (y + size > 10) return false; } 
    else { if (x + size > 10) return false; }
    for (let i = 0; i < size; i++) {
        const cx = v ? x : x + i;
        const cy = v ? y + i : y;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const nx = cx + dx, ny = cy + dy;
                if (nx >= 0 && nx < 10 && ny >= 0 && ny < 10) {
                    if (grid[nx][ny]) return false;
                }
            }
        }
    }
    return true;
}

function placeShip(x, y, size, v) {
    const ship = { x, y, size, v, hits: 0, sunk: false };
    myShips.push(ship);
    const el = document.createElement('div');
    el.className = `ship ship-${size} ${v?'vertical':''}`;
    el.style.left = x*10 + '%'; el.style.top = y*10 + '%';
    el.style.width = v ? '10%' : size*10 + '%';
    el.style.height = v ? size*10 + '%' : '10%';
    $('player-grid').appendChild(el);
    for(let i=0; i<size; i++) {
        const cx = v ? x : x + i;
        const cy = v ? y + i : y;
        myGrid[cx][cy] = ship;
    }
}

function playerReady() {
    $('setup-controls').classList.add('hidden');
    $('game-status').textContent = "Ожидание...";
    STATE.gameState = 'READY';
    
    if (STATE.gameMode === 'BOT') {
        STATE.gameState = 'PLAYING';
        STATE.isMyTurn = true;
        $('game-status').textContent = "Твой ход!";
    } else {
        sendData({ type: 'ready' });
    }
}

// --- ATTACK SYSTEM ---
function handleAttack(x, y) {
    if (STATE.gameState !== 'PLAYING' || !STATE.isMyTurn) return;
    if (enemyGrid[x][y]) return; // Already shot there

    if (STATE.gameMode === 'BOT') {
        processAttackAgainstBot(x, y);
    } else {
        playSfx('miss'); // Optimistic
        sendData({ type: 'fire', x, y });
    }
}

function receiveAttack(x, y) {
    const target = myGrid[x][y];
    let result = { x, y, hit: false, sunk: false, ship: null };

    if (target) {
        // HIT
        result.hit = true;
        target.hits++;
        addMarker($('player-grid'), x, y, 'hit');
        playSfx('hit');
        
        if (target.hits >= target.size) {
            target.sunk = true;
            result.sunk = true;
            result.ship = { x:target.x, y:target.y, size:target.size, v:target.v };
            markSurroundingMissVisual($('player-grid'), result.ship, myGrid); // Visually mark my own board
            playSfx('sunk');
        }
        
        // Check Defeat
        if (myShips.every(s => s.sunk)) {
            endGame(false);
            if(STATE.gameMode !== 'BOT') sendData({ type: 'gameover', winner: 'opponent' });
        }
    } else {
        // MISS
        addMarker($('player-grid'), x, y, 'miss');
        playSfx('miss');
        STATE.isMyTurn = true;
        $('game-status').textContent = "Твой ход!";
    }

    if (STATE.gameMode !== 'BOT') {
        sendData({ type: 'result', ...result });
        if(result.hit) {
            STATE.isMyTurn = false;
            $('game-status').textContent = "Враг бьет снова!";
        }
    }
    return result;
}

function processAttackResult(data) {
    // Mark the enemy grid based on what happened
    enemyGrid[data.x][data.y] = data.hit ? 'H' : 'M';
    addMarker($('enemy-grid'), data.x, data.y, data.hit ? 'hit' : 'miss');

    if (data.sunk) {
        drawEnemySunkShip(data.ship);
        markSurroundingMissVisual($('enemy-grid'), data.ship, enemyGrid); // Auto-surround
        playSfx('sunk');
        enemyShipsSunk++;
        if(enemyShipsSunk >= 10) endGame(true);
        $('game-status').textContent = "Убит! Стреляй!";
        STATE.isMyTurn = true;
    } else if (data.hit) {
        playSfx('hit');
        $('game-status').textContent = "Ранен! Стреляй!";
        STATE.isMyTurn = true;
    } else {
        playSfx('miss');
        $('game-status').textContent = "Мимо. Ход врага.";
        STATE.isMyTurn = false;
        if(STATE.gameMode === 'BOT') {
            setTimeout(() => STATE.bot.makeMove(), 1000);
        }
    }
}

// --- AUTO SURROUND LOGIC ---
function markSurroundingMissVisual(gridEl, ship, dataGrid) {
    for(let i=0; i<ship.size; i++) {
         const cx = ship.v ? ship.x : ship.x + i;
         const cy = ship.v ? ship.y + i : ship.y;
         
         for(let nx=cx-1; nx<=cx+1; nx++) {
             for(let ny=cy-1; ny<=cy+1; ny++) {
                 if(nx>=0 && nx<10 && ny>=0 && ny<10) {
                     // Only mark if empty (null) or not already hit/miss
                     // We check the DOM or the dataGrid
                     const cell = gridEl.querySelector(`.cell[data-x="${nx}"][data-y="${ny}"]`);
                     if(!cell.querySelector('.ship') && !cell.querySelector('.marker')) {
                         if(dataGrid) dataGrid[nx][ny] = 'M'; // Mark logically if needed
                         addMarker(gridEl, nx, ny, 'surround-miss');
                     }
                 }
             }
         }
    }
}

function drawEnemySunkShip(ship) {
    const el = document.createElement('div');
    el.className = `ship ship-${ship.size} ${ship.v?'vertical':''} sunk-ship`;
    el.style.left = ship.x*10 + '%'; el.style.top = ship.y*10 + '%';
    el.style.width = ship.v ? '10%' : ship.size*10 + '%';
    el.style.height = ship.v ? ship.size*10 + '%' : '10%';
    $('enemy-grid').appendChild(el);
}

function addMarker(parent, x, y, type) {
    const cell = parent.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
    if(cell && !cell.querySelector('.marker')) {
        const m = document.createElement('div');
        m.className = `marker ${type}`;
        cell.appendChild(m);
    }
}

function endGame(win) {
    STATE.gameState = 'END';
    const xp = win ? 150 : 25;
    addXP(xp);
    $('end-title').textContent = win ? "ПОБЕДА!" : "ПОРАЖЕНИЕ";
    $('end-title').style.color = win ? 'var(--ink-blue)' : 'var(--ink-red)';
    $('xp-gain').textContent = `+${xp} XP`;
    $('modal-endgame').classList.remove('hidden');
    playSfx(win ? 'win' : 'lose');
}

// --- BOT LOGIC ---
function startBotGame() {
    STATE.gameMode = 'BOT';
    STATE.bot = new BotAI();
    resetGame();
    showScreen('game');
}

class BotAI {
    constructor() {
        this.grid = Array(10).fill(null).map(() => Array(10).fill(null));
        this.ships = [];
        this.placeShips();
        this.huntQueue = []; 
    }

    placeShips() {
        const tempShips = [];
        SHIPS_STRUCT.forEach(t => { for(let i=0; i<t.c; i++) tempShips.push(t.s); });
        tempShips.forEach(size => {
            let placed = false;
            while(!placed) {
                const x = Math.floor(Math.random()*10);
                const y = Math.floor(Math.random()*10);
                const v = Math.random() > 0.5;
                if(canPlace(x,y,size,v,this.grid)) {
                    const ship = { x, y, size, v, hits: 0, sunk: false };
                    this.ships.push(ship);
                    for(let i=0; i<size; i++) {
                        const cx = v ? x : x + i;
                        const cy = v ? y + i : y;
                        this.grid[cx][cy] = ship;
                    }
                    placed = true;
                }
            }
        });
    }

    makeMove() {
        if(STATE.gameState !== 'PLAYING') return;

        let x, y;
        // Hunt mode: if we have targets in queue, shoot them
        if (this.huntQueue.length > 0) {
            const t = this.huntQueue.shift();
            x = t.x; y = t.y;
        } else {
            // Random shot
            let attempts = 0;
            do {
                x = Math.floor(Math.random()*10);
                y = Math.floor(Math.random()*10);
                attempts++;
            } while(this.hasShotAt(x, y) && attempts < 200);
        }

        // Just in case
        if(this.hasShotAt(x,y)) return; 

        const result = receiveAttack(x, y);
        
        if (result.hit && !result.sunk) {
            // Add neighbors to hunt queue
            [[0,1],[0,-1],[1,0],[-1,0]].forEach(([dx, dy]) => {
                const nx = x+dx, ny = y+dy;
                if(nx>=0 && nx<10 && ny>=0 && ny<10 && !this.hasShotAt(nx, ny)) {
                    this.huntQueue.push({x:nx, y:ny});
                }
            });
        }
    }

    hasShotAt(x, y) {
        const cell = $('player-grid').querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
        return !!cell.querySelector('.marker');
    }
}

function processAttackAgainstBot(x, y) {
    const targetShip = STATE.bot.grid[x][y];
    let hit = false, sunk = false, shipData = null;

    if (targetShip) {
        hit = true;
        targetShip.hits++;
        if (targetShip.hits >= targetShip.size) {
            sunk = true;
            targetShip.sunk = true;
            shipData = {x:targetShip.x, y:targetShip.y, size:targetShip.size, v:targetShip.v};
        }
    }
    processAttackResult({ x, y, hit, sunk, ship: shipData });
}


// --- ONLINE LOGIC ---
function connectSocket() {
    STATE.socket = io(CONFIG.SERVER_URL);
    
    STATE.socket.on('connect', () => {
        if(STATE.user.username) STATE.socket.emit('login', STATE.user);
    });

    STATE.socket.on('online-users-update', (users) => {
        const list = $('online-list');
        list.innerHTML = '';
        users.forEach(u => {
            // Don't show self
            if(u.id === STATE.user.id) return;
            
            const div = document.createElement('div');
            div.className = 'user-row';
            div.innerHTML = `
                <div>
                    <span class="status-dot ${u.status}">●</span>
                    <b>${u.username}</b>
                </div>
                ${u.status === 'online' ? `<button class="btn-sm" onclick="inviteUser('${u.id}')">⚔️ Вызов</button>` : '<span>В бою</span>'}
            `;
            list.appendChild(div);
        });
        if(list.children.length === 0) list.innerHTML = '<p style="text-align:center;color:#999">Никого нет онлайн :(</p>';
    });

    STATE.socket.on('challenge-received', (data) => {
        $('inviter-name').textContent = data.fromName;
        $('modal-invite').classList.remove('hidden');
        STATE.pendingInvite = data.socketId;
        playSfx('place'); // Alert sound
    });

    STATE.socket.on('match-start', (roomId) => {
        STATE.roomId = roomId;
        STATE.gameMode = 'ONLINE';
        STATE.socket.emit('join-room', roomId);
        showScreen('game');
        resetGame();
    });

    // WebRTC standard stuff...
    STATE.socket.on('room-created', () => { STATE.isHost = true; });
    STATE.socket.on('room-joined', () => { STATE.isHost = false; });
    STATE.socket.on('ready-to-negotiate', () => { if(STATE.isHost) startWebRTC(); });
    
    STATE.socket.on('offer', async (o) => {
        if(!STATE.peer) createPeer();
        await STATE.peer.setRemoteDescription(o);
        const a = await STATE.peer.createAnswer();
        await STATE.peer.setLocalDescription(a);
        STATE.socket.emit('answer', {roomId: STATE.roomId, answer: a});
    });
    STATE.socket.on('answer', (a) => STATE.peer.setRemoteDescription(a));
    STATE.socket.on('ice-candidate', (c) => STATE.peer.addIceCandidate(c));
}

window.inviteUser = (id) => {
    STATE.socket.emit('send-challenge', id);
    alert('Вызов отправлен!');
};

function acceptChallenge() {
    $('modal-invite').classList.add('hidden');
    STATE.socket.emit('accept-challenge', STATE.pendingInvite);
}

function startWebRTC() {
    createPeer();
    STATE.dc = STATE.peer.createDataChannel("game");
    setupDC();
    STATE.peer.createOffer().then(o => STATE.peer.setLocalDescription(o))
        .then(() => STATE.socket.emit('offer', {roomId: STATE.roomId, offer: STATE.peer.localDescription}));
}

function createPeer() {
    STATE.peer = new RTCPeerConnection(CONFIG.ICE_SERVERS);
    STATE.peer.onicecandidate = e => {
        if(e.candidate) STATE.socket.emit('ice-candidate', {roomId: STATE.roomId, candidate: e.candidate});
    };
    STATE.peer.ondatachannel = e => { STATE.dc = e.channel; setupDC(); };
    STATE.peer.onconnectionstatechange = () => {
        if(STATE.peer.connectionState === 'disconnected') {
            alert('Соперник отключился');
            showScreen('menu');
        }
    };
}

function setupDC() {
    STATE.dc.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if(data.type === 'ready') checkOnlineStart();
        if(data.type === 'fire') receiveAttack(data.x, data.y);
        if(data.type === 'result') processAttackResult(data);
        if(data.type === 'gameover') endGame(true);
    };
    if(STATE.gameState === 'READY') { sendData({type: 'ready'}); checkOnlineStart(); }
}

function sendData(obj) {
    if(STATE.dc && STATE.dc.readyState === 'open') STATE.dc.send(JSON.stringify(obj));
}

let onlineOpponentReady = false;
function checkOnlineStart() {
    onlineOpponentReady = true; 
    if(STATE.gameState === 'READY') {
        STATE.gameState = 'PLAYING';
        $('game-status').textContent = STATE.isHost ? "Твой ход!" : "Ход соперника...";
        STATE.isMyTurn = STATE.isHost;
    }
}
