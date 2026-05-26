const express = require('express');
const app = express();
const http = require('http').createServer(app);
const path = require('path');
const io = require('socket.io')(http, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

function createDeck() {
    return [
        'Герцог', 'Герцог', 'Герцог',
        'Убийца', 'Убийца', 'Убийца',
        'Капитан', 'Капитан', 'Капитан',
        'Посол', 'Посол', 'Посол',
        'Графиня', 'Графиня', 'Графиня'
    ].sort(() => Math.random() - 0.5);
}

let gameState = {
    players: [],
    currentTurnIdx: 0,
    pendingAction: null,
    started: false,
    deck: createDeck()
};

function resetGame() {
    // Вычищаем всех, кто ливнул, чтобы они не ломали очередь ходов
    gameState.players = gameState.players.filter(p => !p.disconnected);
    
    gameState.deck = createDeck();
    gameState.currentTurnIdx = 0;
    gameState.pendingAction = null;
    gameState.players.forEach(p => {
        p.coins = 2;
        p.isDead = false;
        p.cards = [
            { role: gameState.deck.pop(), isDead: false },
            { role: gameState.deck.pop(), isDead: false }
        ];
    });
}

function getAlivePlayers() {
    return gameState.players.filter(p => !p.isDead);
}

function nextTurn() {
    if (checkWin()) return;
    let attempts = 0;
    do {
        gameState.currentTurnIdx = (gameState.currentTurnIdx + 1) % gameState.players.length;
        attempts++;
        if (attempts > 100) break;
    } while (gameState.players[gameState.currentTurnIdx].isDead);
}

function checkPlayerDeath(player) {
    const aliveCards = player.cards.filter(c => !c.isDead);
    if (aliveCards.length === 0 && !player.isDead) {
        player.isDead = true;
        log(`☠️ Игрок ${player.name} потерял все влияние и выбыл!`);
        checkWin();
    }
}

function checkWin() {
    if (!gameState.started) return false;
    const alive = getAlivePlayers();
    
    if (alive.length === 1 || alive.length === 0) {
        const winnerName = alive.length === 1 ? alive[0].name : 'Ничья';
        log(`🏆 Игра окончена! Результат: ${winnerName}`);
        io.emit('gameOver', winnerName);
        gameState.started = false;
        
        // Очищаем массив от призраков для лобби
        gameState.players = gameState.players.filter(p => !p.disconnected);
        io.emit('lobbyUpdate', gameState.players);
        return true;
    }
    return false;
}

function sendState() {
    io.emit('gameState', gameState);
}

function log(text) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    io.emit('gameLog', `[${time}] ${text}`);
}

const actionRoles = {
    'tax': 'Герцог',
    'steal': 'Капитан',
    'assassinate': 'Убийца',
    'exchange': 'Посол'
};

function executeAction(sourcePlayer, actionData) {
    const target = actionData.target ? gameState.players.find(p => p.id === actionData.target) : null;
    
    switch (actionData.action) {
        case 'income':
            sourcePlayer.coins += 1;
            log(`🪙 ${sourcePlayer.name} берет Доход (+1 монета)`);
            gameState.pendingAction = null;
            nextTurn();
            break;
        case 'foreign_aid':
            sourcePlayer.coins += 2;
            log(`🤝 ${sourcePlayer.name} получает Помощь (+2 монеты)`);
            gameState.pendingAction = null;
            nextTurn();
            break;
        case 'tax':
            sourcePlayer.coins += 3;
            log(`👑 ${sourcePlayer.name} собирает Налог (+3 монеты)`);
            gameState.pendingAction = null;
            nextTurn();
            break;
        case 'steal':
            if (!target || target.isDead) { gameState.pendingAction = null; nextTurn(); break; }
            const stolen = Math.min(2, target.coins);
            target.coins -= stolen;
            sourcePlayer.coins += stolen;
            log(`🥷 ${sourcePlayer.name} украл ${stolen} монеты у ${target.name}`);
            gameState.pendingAction = null;
            nextTurn();
            break;
        case 'assassinate':
            if (!target || target.isDead) { gameState.pendingAction = null; nextTurn(); break; }
            log(`🗡️ Покушение на ${target.name} успешно!`);
            gameState.pendingAction = {
                type: 'loseCard',
                targetId: target.id,
                message: `${sourcePlayer.name} совершил покушение на вас! Выберите карту для сброса:`,
                nextAction: { type: 'endTurn' }
            };
            break;
        case 'coup':
            if (!target || target.isDead) { gameState.pendingAction = null; nextTurn(); break; }
            log(`💥 ${sourcePlayer.name} совершает переворот против ${target.name}!`);
            gameState.pendingAction = {
                type: 'loseCard',
                targetId: target.id,
                message: `${sourcePlayer.name} совершил переворот против вас! Выберите карту для сброса:`,
                nextAction: { type: 'endTurn' }
            };
            break;
        case 'exchange':
            const card1 = gameState.deck.pop();
            const card2 = gameState.deck.pop();
            const currentAliveCards = sourcePlayer.cards.filter(c => !c.isDead).map(c => c.role);
            const options = [...currentAliveCards, card1, card2];
            
            gameState.pendingAction = {
                type: 'exchange',
                targetId: sourcePlayer.id,
                options: options,
                requiredToKeep: currentAliveCards.length,
                message: `Выберите ${currentAliveCards.length} карту(-ы), чтобы оставить себе:`
            };
            log(`🔄 ${sourcePlayer.name} выбирает карты для обмена`);
            break;
    }
    sendState();
}

function goToBlockOrExecute(sourceId, actionData) {
    const srcPlayer = gameState.players.find(p => p.id === sourceId);
    const targetPlayer = actionData.target ? gameState.players.find(p => p.id === actionData.target) : null;
    
    // ФИКС СОФТЛОКА: Если цель убили во время проверки "Не верю", просто скипаем фазу блока и отменяем действие
    if (targetPlayer && targetPlayer.isDead) {
        executeAction(srcPlayer, actionData);
        return;
    }

    if (actionData.action === 'foreign_aid') {
        gameState.pendingAction = {
            type: 'block_phase',
            sourceId: sourceId,
            actionData: actionData,
            validBlocks: ['Герцог'],
            message: `Игрок ${srcPlayer.name} берет Помощь (+2). Будет блок Герцогом?`,
            passedPlayers: [sourceId]
        };
    } else if (actionData.action === 'steal') {
        gameState.pendingAction = {
            type: 'block_phase',
            sourceId: sourceId,
            actionData: actionData,
            validBlocks: ['Капитан', 'Посол'],
            message: `Игрок ${srcPlayer.name} крадет ваши монеты. Будет блок Капитаном или Послом?`,
            passedPlayers: gameState.players.filter(p => p.id !== actionData.target).map(p => p.id)
        };
    } else if (actionData.action === 'assassinate') {
        gameState.pendingAction = {
            type: 'block_phase',
            sourceId: sourceId,
            actionData: actionData,
            validBlocks: ['Графиня'],
            message: `Игрок ${srcPlayer.name} совершает покушение на вас. Заблокировать Графиней?`,
            passedPlayers: gameState.players.filter(p => p.id !== actionData.target).map(p => p.id)
        };
    } else {
        executeAction(srcPlayer, actionData);
        return;
    }
    sendState();
}

io.on('connection', (socket) => {
    socket.emit('lobbyUpdate', gameState.players);
    if (gameState.started) socket.emit('gameState', gameState);

    socket.on('joinLobby', (name) => {
        if (gameState.started) return;
        if (gameState.players.find(p => p.id === socket.id)) return;

        gameState.players.push({
            id: socket.id,
            name: name || `Игрок ${gameState.players.length + 1}`,
            coins: 2,
            isDead: false,
            disconnected: false,
            cards: []
        });
        log(`👤 ${gameState.players[gameState.players.length - 1].name} зашел в лобби`);
        io.emit('lobbyUpdate', gameState.players);
    });

    socket.on('startGame', () => {
        if (gameState.players.length < 2 || gameState.started) return;
        gameState.started = true;
        resetGame();
        log('🎮 Игра началась! Всем раздано по 2 карты и 2 монеты.');
        sendState();
    });

    // ОРИГИНАЛЬНАЯ РАБОЧАЯ ЛОГИКА ДЕЙСТВИЙ ИГРОКОВ:
    socket.on('playerAction', (data) => {
        if (!gameState.started || gameState.pendingAction) return;
        const player = gameState.players[gameState.currentTurnIdx];
        if (!player || player.id !== socket.id || player.isDead) return;

        if (data.action === 'assassinate' && player.coins < 3) return;
        if (data.action === 'coup' && player.coins < 7) return;
        if (player.coins >= 10 && data.action !== 'coup') return;

        if (data.action === 'assassinate') player.coins -= 3;
        if (data.action === 'coup') player.coins -= 7;

        const targetPlayer = data.target ? gameState.players.find(p => p.id === data.target) : null;
        const targetName = targetPlayer ? targetPlayer.name : '';

        let actionText = '';
        if (data.action === 'income') actionText = 'берет Доход';
        if (data.action === 'foreign_aid') actionText = 'хочет взять Помощь (+2)';
        if (data.action === 'tax') actionText = 'заявляет Герцога и берет Налог (+3)';
        if (data.action === 'steal') actionText = `заявляет Капитана и хочет украсть у ${targetName}`;
        if (data.action === 'assassinate') actionText = `заявляет Убийцу и совершает покушение на ${targetName}`;
        if (data.action === 'coup') actionText = `совершает Переворот против ${targetName}`;
        if (data.action === 'exchange') actionText = 'заявляет Посла и делает обмен карт';

        log(`📣 ${player.name}: ${actionText}`);

        const claimedRole = actionRoles[data.action];
        if (claimedRole) {
            gameState.pendingAction = {
                type: 'challenge_action',
                sourceId: player.id,
                actionData: data,
                claimedRole: claimedRole,
                message: `Игрок ${player.name} объявляет роль [${claimedRole}] для действия: "${actionText}". Верим?`,
                passedPlayers: [player.id]
            };
        } else if (data.action === 'foreign_aid') {
            gameState.pendingAction = {
                type: 'block_phase',
                sourceId: player.id,
                actionData: data,
                validBlocks: ['Герцог'],
                message: `Игрок ${player.name} пытается получить Помощь (+2). Кто-то заблокирует Герцогом?`,
                passedPlayers: [player.id]
            };
        } else {
            executeAction(player, data);
            return;
        }
        sendState();
    });

    socket.on('restartGame', () => {
        gameState.players = gameState.players.filter(p => !p.disconnected);

        if (gameState.players.length < 2) {
            log('⚠️ Недостаточно игроков для перезапуска. Возврат в лобби.');
            io.emit('backToLobby');
            gameState.started = false;
            io.emit('lobbyUpdate', gameState.players);
            return;
        }

        if (!gameState.started) {
            resetGame();
            gameState.started = true;
            log('🎮 Новая игра началась!');
            sendState();
        }
    });

    socket.on('leaveToLobby', () => {
        socket.emit('backToLobby');
    });

    socket.on('reaction', (data) => {
        if (!gameState.pendingAction) return;
        const action = gameState.pendingAction;
        const player = gameState.players.find(p => p.id === socket.id);
        if (!player || player.isDead) return;

        if (action.type === 'challenge_action') {
            if (data.type === 'pass') {
                if (!action.passedPlayers.includes(socket.id)) action.passedPlayers.push(socket.id);
                if (action.passedPlayers.length >= getAlivePlayers().length) {
                    goToBlockOrExecute(action.sourceId, action.actionData);
                } else {
                    sendState();
                }
            } else if (data.type === 'challenge') {
                const accused = gameState.players.find(p => p.id === action.sourceId);
                log(`🕵️ ${player.name} говорит "Не верю!" игроку ${accused.name} на роль [${action.claimedRole}]`);
                
                const hasRole = accused.cards.some(c => !c.isDead && c.role === action.claimedRole);
                if (hasRole) {
                    log(`⚖️ Правда! У ${accused.name} есть [${action.claimedRole}].`);
                    const idx = accused.cards.findIndex(c => !c.isDead && c.role === action.claimedRole);
                    accused.cards[idx].role = gameState.deck.pop();
                    gameState.deck.push(action.claimedRole);
                    gameState.deck.sort(() => Math.random() - 0.5);

                    gameState.pendingAction = {
                        type: 'loseCard',
                        targetId: player.id,
                        message: `Вы ошиблись! Сбросьте одну карту в качестве штрафа:`,
                        nextAction: { type: 'continueAfterChallengeSuccess', sourceId: action.sourceId, actionData: action.actionData }
                    };
                } else {
                    log(`🚨 Вранье! У ${accused.name} нет роли [${action.claimedRole}].`);
                    if (action.actionData.action === 'assassinate') accused.coins += 3;
                    
                    gameState.pendingAction = {
                        type: 'loseCard',
                        targetId: accused.id,
                        message: `Вас поймали на лжи! Выберите карту для сброса:`,
                        nextAction: { type: 'endTurn' }
                    };
                }
                sendState();
            }
        }

        else if (action.type === 'block_phase') {
            if (data.type === 'pass') {
                if (!action.passedPlayers.includes(socket.id)) action.passedPlayers.push(socket.id);
                if (action.passedPlayers.length >= getAlivePlayers().length) {
                    const srcPlayer = gameState.players.find(p => p.id === action.sourceId);
                    executeAction(srcPlayer, action.actionData);
                } else {
                    sendState();
                }
            } else if (data.type === 'block') {
                if (!action.validBlocks.includes(data.claimedRole)) return;
                
                log(`🛡️ ${player.name} объявляет БЛОК, заявляя роль [${data.claimedRole}]`);
                gameState.pendingAction = {
                    type: 'challenge_block',
                    blockerId: player.id,
                    originalSourceId: action.sourceId,
                    actionData: action.actionData,
                    claimedRole: data.claimedRole,
                    message: `Игрок ${player.name} блокирует действие ролью [${data.claimedRole}]. Кто-то оспорит блок?`,
                    passedPlayers: [player.id]
                };
                sendState();
            }
        }

        else if (action.type === 'challenge_block') {
            if (data.type === 'pass') {
                if (!action.passedPlayers.includes(socket.id)) action.passedPlayers.push(socket.id);
                if (action.passedPlayers.length >= getAlivePlayers().length) {
                    log(`✅ Блок успешен. Действие отменено.`);
                    gameState.pendingAction = null;
                    nextTurn();
                    sendState();
                } else {
                    sendState();
                }
            } else if (data.type === 'challenge') {
                const blocker = gameState.players.find(p => p.id === action.blockerId);
                log(`🕵️ ${player.name} проверяет блок от ${blocker.name} на роль [${action.claimedRole}]`);

                const hasRole = blocker.cards.some(c => !c.isDead && c.role === action.claimedRole);
                if (hasRole) {
                    log(`⚖️ Честный блок! У ${blocker.name} есть [${action.claimedRole}]. Действие отменено.`);
                    const idx = blocker.cards.findIndex(c => !c.isDead && c.role === action.claimedRole);
                    blocker.cards[idx].role = gameState.deck.pop();
                    gameState.deck.push(action.claimedRole);
                    gameState.deck.sort(() => Math.random() - 0.5);

                    gameState.pendingAction = {
                        type: 'loseCard',
                        targetId: player.id,
                        message: `Блок был честным! Выберите карту для сброса:`,
                        nextAction: { type: 'endTurn' }
                    };
                } else {
                    log(`🚨 Ложный блок! У ${blocker.name} нет роли [${action.claimedRole}]. Действие выполняется!`);
                    
                    gameState.pendingAction = {
                        type: 'loseCard',
                        targetId: blocker.id,
                        message: `Вас поймали на лжи при блокировке! Сбросьте карту:`,
                        nextAction: { type: 'executeAfterChallengeBlockFailure', sourceId: action.originalSourceId, actionData: action.actionData }
                    };
                }
                sendState();
            }
        }

        else if (action.type === 'loseCard' && socket.id === action.targetId && data.type === 'loseCard') {
            if (player.cards[data.cardIndex].isDead) return;

            player.cards[data.cardIndex].isDead = true;
            log(`💀 ${player.name} теряет карту [${player.cards[data.cardIndex].role}]`);
            checkPlayerDeath(player);

            // Если после потери карты игра закончилась (кто-то победил), останавливаем цепочку действий
            if (!gameState.started) {
                gameState.pendingAction = null;
                sendState();
                return;
            }

            const next = action.nextAction;
            if (next && next.type === 'endTurn') {
                gameState.pendingAction = null;
                nextTurn();
            } else if (next && next.type === 'continueAfterChallengeSuccess') {
                goToBlockOrExecute(next.sourceId, next.actionData);
            } else if (next && next.type === 'executeAfterChallengeBlockFailure') {
                const srcPlayer = gameState.players.find(p => p.id === next.sourceId);
                executeAction(srcPlayer, next.actionData);
            } else {
                gameState.pendingAction = null;
                nextTurn();
            }
            sendState();
        }

        else if (action.type === 'exchange' && socket.id === action.targetId && data.type === 'exchange') {
            const selected = data.selectedIndices;
            if (!Array.isArray(selected) || selected.length !== action.requiredToKeep) return;

            const keptRoles = selected.map(i => action.options[i]);
            const discardedRoles = action.options.filter((_, i) => !selected.includes(i));

            gameState.deck.push(...discardedRoles);
            gameState.deck.sort(() => Math.random() - 0.5);

            let keptIdx = 0;
            player.cards.forEach(c => {
                if (!c.isDead) c.role = keptRoles[keptIdx++];
            });

            log(`🔄 ${player.name} завершил обмен карт`);
            gameState.pendingAction = null;
            nextTurn();
            sendState();
        }
    });

    socket.on('disconnect', () => {
        const pIdx = gameState.players.findIndex(p => p.id === socket.id);
        if (pIdx !== -1) {
            const player = gameState.players[pIdx];
            log(`🚪 ${player.name} вышел из игры`);
            
            if (gameState.started) {
                player.isDead = true;
                player.disconnected = true;
                player.cards.forEach(c => c.isDead = true);
                checkPlayerDeath(player);
                
                // Если после лива игра всё ещё идёт, а завис ход ливнувшего, двигаем дальше
                if (gameState.started && (gameState.players[gameState.currentTurnIdx].id === socket.id || gameState.pendingAction)) {
                    gameState.pendingAction = null;
                    nextTurn();
                }
            } else {
                gameState.players.splice(pIdx, 1);
            }
            
            io.emit('lobbyUpdate', gameState.players.filter(p => !p.disconnected));
            sendState();
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Сервер запущен на порту: ${PORT}`);
});