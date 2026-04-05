const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const Pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Store active sessions
const activeSessions = new Map();
const sessionsDir = path.join(__dirname, 'sessions');
const pairingCodesStore = new Map();

// Create sessions directory
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir);
}

// Logger
const logger = Pino({ level: 'silent' });

// Function to create WhatsApp socket
async function createWhatsAppSocket(sessionName) {
    const sessionPath = path.join(sessionsDir, sessionName);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger,
        browser: ['WhatsApp Reacts', 'Chrome', '9.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
    });

    // Handle connection updates
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
            console.log(`Session ${sessionName}: Connecting...`);
        } else if (connection === 'open') {
            console.log(`Session ${sessionName}: Connected`);
            const sessionData = activeSessions.get(sessionName);
            if (sessionData) {
                sessionData.status = 'connected';
            }
        } else if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => {
                    createWhatsAppSocket(sessionName);
                }, 3000);
            } else {
                console.log(`Session ${sessionName}: Logged out`);
                cleanupSession(sessionName);
            }
        }
    });

    // Handle credentials update
    socket.ev.on('creds.update', saveCreds);

    return socket;
}

// Cleanup session
function cleanupSession(sessionName) {
    activeSessions.delete(sessionName);
    pairingCodesStore.delete(sessionName);
    const sessionPath = path.join(sessionsDir, sessionName);
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }
}

// Generate random pairing code
function generatePairingCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// API: Request Pairing Code
app.post('/api/request-pairing-code', async (req, res) => {
    try {
        const { sessionName, phoneNumber } = req.body;

        if (!sessionName || !phoneNumber) {
            return res.status(400).json({ 
                message: 'Session name and phone number are required' 
            });
        }

        // Generate pairing code
        const pairingCode = generatePairingCode();
        const expiresIn = 60; // 60 seconds

        // Store pairing code
        pairingCodesStore.set(sessionName, {
            code: pairingCode,
            phoneNumber,
            expiresAt: Date.now() + (expiresIn * 1000),
            attempts: 0
        });

        // Create socket if doesn't exist
        if (!activeSessions.has(sessionName)) {
            const socket = await createWhatsAppSocket(sessionName);
            activeSessions.set(sessionName, {
                socket,
                status: 'pairing',
                phoneNumber,
                createdAt: new Date(),
                messagesSent: 0,
                reactionsSent: 0
            });
        }

        // Auto-expire code after timeout
        setTimeout(() => {
            const stored = pairingCodesStore.get(sessionName);
            if (stored && stored.code === pairingCode) {
                pairingCodesStore.delete(sessionName);
                console.log(`Pairing code expired for session ${sessionName}`);
            }
        }, expiresIn * 1000 + 1000);

        res.json({
            message: 'Pairing code generated',
            code: pairingCode,
            expiresIn,
            sessionName,
            phoneNumber
        });

    } catch (error) {
        console.error('Pairing code error:', error);
        res.status(500).json({ message: error.message });
    }
});

// API: Check Pairing Status
app.get('/api/pairing-status/:sessionName', (req, res) => {
    try {
        const { sessionName } = req.params;

        const sessionData = activeSessions.get(sessionName);
        if (!sessionData) {
            return res.status(404).json({ 
                message: 'Session not found',
                connected: false
            });
        }

        res.json({
            sessionName,
            connected: sessionData.status === 'connected',
            status: sessionData.status,
            phoneNumber: sessionData.phoneNumber
        });

    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ message: error.message });
    }
});

// API: Disconnect from WhatsApp
app.post('/api/disconnect', async (req, res) => {
    try {
        const { sessionName } = req.body;

        if (!sessionName) {
            return res.status(400).json({ message: 'Session name is required' });
        }

        const sessionData = activeSessions.get(sessionName);
        if (!sessionData) {
            return res.status(404).json({ message: 'Session not found' });
        }

        await sessionData.socket.logout();
        cleanupSession(sessionName);

        res.json({ message: 'Disconnected successfully' });
    } catch (error) {
        console.error('Disconnection error:', error);
        res.status(500).json({ message: error.message });
    }
});

// API: Send Reaction
app.post('/api/send-reaction', async (req, res) => {
    try {
        const { sessionName, chatId, emoji, messageId, customText } = req.body;

        if (!sessionName || !chatId || !emoji) {
            return res.status(400).json({ 
                message: 'Session name, chat ID, and emoji are required' 
            });
        }

        const sessionData = activeSessions.get(sessionName);
        if (!sessionData) {
            return res.status(404).json({ message: 'Session not found' });
        }

        if (sessionData.status !== 'connected') {
            return res.status(400).json({ message: 'Session is not connected' });
        }

        const socket = sessionData.socket;
        const key = {
            remoteJid: chatId,
            fromMe: false,
            id: messageId || (await getLatestMessageId(socket, chatId))
        };

        // Send reaction
        await socket.sendMessage(chatId, {
            react: {
                text: emoji,
                key
            }
        });

        // Send custom text if provided
        if (customText) {
            await socket.sendMessage(chatId, { text: customText });
        }

        sessionData.reactionsSent++;
        sessionData.messagesSent++;

        res.json({
            message: 'Reaction sent successfully',
            emoji,
            chatId,
            messageId: key.id,
            timestamp: new Date()
        });

    } catch (error) {
        console.error('Send reaction error:', error);
        res.status(500).json({ message: error.message });
    }
});

// API: Send Text Message
app.post('/api/send-message', async (req, res) => {
    try {
        const { sessionName, chatId, text } = req.body;

        if (!sessionName || !chatId || !text) {
            return res.status(400).json({ 
                message: 'Session name, chat ID, and text are required' 
            });
        }

        const sessionData = activeSessions.get(sessionName);
        if (!sessionData) {
            return res.status(404).json({ message: 'Session not found' });
        }

        if (sessionData.status !== 'connected') {
            return res.status(400).json({ message: 'Session is not connected' });
        }

        const result = await sessionData.socket.sendMessage(chatId, { text });
        sessionData.messagesSent++;

        res.json({
            message: 'Message sent successfully',
            messageId: result.key.id,
            timestamp: new Date()
        });

    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ message: error.message });
    }
});

// API: Get Session Status
app.get('/api/status/:sessionName', (req, res) => {
    try {
        const { sessionName } = req.params;

        const sessionData = activeSessions.get(sessionName);
        if (!sessionData) {
            return res.status(404).json({ message: 'Session not found' });
        }

        res.json({
            sessionName,
            status: sessionData.status,
            phoneNumber: sessionData.phoneNumber,
            messagesSent: sessionData.messagesSent,
            reactionsSent: sessionData.reactionsSent,
            createdAt: sessionData.createdAt,
            uptime: Date.now() - sessionData.createdAt.getTime()
        });

    } catch (error) {
        console.error('Status error:', error);
        res.status(500).json({ message: error.message });
    }
});

// API: List All Sessions
app.get('/api/sessions', (req, res) => {
    try {
        const sessions = Array.from(activeSessions.entries()).map(([name, data]) => ({
            name,
            status: data.status,
            phoneNumber: data.phoneNumber,
            messagesSent: data.messagesSent,
            reactionsSent: data.reactionsSent,
            createdAt: data.createdAt
        }));

        res.json({ sessions });
    } catch (error) {
        console.error('List sessions error:', error);
        res.status(500).json({ message: error.message });
    }
});

// Helper: Get latest message ID
async function getLatestMessageId(socket, chatId) {
    try {
        const messages = await socket.loadConversation(chatId, 1);
        return messages[0]?.key?.id || null;
    } catch (error) {
        console.error('Error getting latest message:', error);
        return null;
    }
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        message: 'Internal server error',
        error: err.message 
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ message: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`
    ╔═══════════════════════════════════════╗
    ║   WhatsApp Reacts Web - Baileys       ║
    ║   Phone Number Pairing Method         ║
    ║   Server running on port ${PORT}       ║
    ║   Open: http://localhost:${PORT}       ║
    ╚═══════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    
    for (const [sessionName, sessionData] of activeSessions) {
        try {
            await sessionData.socket.logout();
            cleanupSession(sessionName);
        } catch (error) {
            console.error(`Error closing session ${sessionName}:`, error);
        }
    }

    process.exit(0);
});