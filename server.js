const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DB_FILE = "db.json";

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("VideoCall signaling server is running\n");
});

const wss = new WebSocket.Server({ server: httpServer });

let db = { users: {}, contacts: {} };
const onlineUsers = new Map();

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    }
  } catch (error) {
    console.log("DB load error:", error.message);
  }
  if (!db.users) db.users = {};
  if (!db.contacts) db.contacts = {};
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
  } catch (error) {
    console.log("DB save error:", error.message);
  }
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function send(socket, data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function isValidUsername(username) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

function getPublicUser(username) {
  const user = db.users[username];
  if (!user) return null;
  return {
    username: user.username,
    displayName: user.displayName || user.username,
    online: onlineUsers.has(username)
  };
}

function getContactsFor(username) {
  const list = db.contacts[username] || [];
  return list.map(contactUsername => getPublicUser(contactUsername)).filter(Boolean);
}

function requireLogin(socket) {
  if (!socket.username) {
    send(socket, { type: "error", message: "You are not logged in" });
    return false;
  }
  return true;
}

function sendToUser(username, data) {
  const socket = onlineUsers.get(username);
  if (socket && socket.readyState === WebSocket.OPEN) {
    send(socket, data);
    return true;
  }
  return false;
}

function register(socket, data) {
  const username = normalizeUsername(data.username);
  const password = String(data.password || "");
  const displayName = String(data.displayName || username).trim();

  if (!isValidUsername(username)) {
    send(socket, { type: "register-error", message: "Логин должен быть 3-20 символов: латиница, цифры или _" });
    return;
  }

  if (password.length < 4) {
    send(socket, { type: "register-error", message: "Пароль должен быть минимум 4 символа" });
    return;
  }

  if (db.users[username]) {
    send(socket, { type: "register-error", message: "Такой пользователь уже существует" });
    return;
  }

  db.users[username] = {
    username,
    displayName,
    passwordHash: hashPassword(password),
    createdAt: Date.now()
  };

  db.contacts[username] = [];
  saveDb();

  send(socket, { type: "register-success", user: getPublicUser(username) });
}

function login(socket, data) {
  const username = normalizeUsername(data.username);
  const password = String(data.password || "");
  const user = db.users[username];

  if (!user || user.passwordHash !== hashPassword(password)) {
    send(socket, { type: "login-error", message: "Неверный логин или пароль" });
    return;
  }

  if (onlineUsers.has(username)) {
    const oldSocket = onlineUsers.get(username);
    send(oldSocket, { type: "force-logout", message: "Выполнен вход с другого устройства" });
    try { oldSocket.close(); } catch (error) {}
  }

  socket.username = username;
  onlineUsers.set(username, socket);

  send(socket, {
    type: "login-success",
    user: getPublicUser(username),
    contacts: getContactsFor(username)
  });

  broadcastContactStatus(username);
}

function logout(socket) {
  if (!socket.username) return;
  const username = socket.username;
  onlineUsers.delete(username);
  socket.username = null;
  broadcastContactStatus(username);
}

function broadcastContactStatus(username) {
  Object.keys(db.contacts).forEach(owner => {
    const contacts = db.contacts[owner] || [];
    if (contacts.includes(username)) {
      sendToUser(owner, { type: "contact-status", user: getPublicUser(username) });
    }
  });
}

function searchUser(socket, data) {
  if (!requireLogin(socket)) return;
  const query = normalizeUsername(data.query);

  if (!query) {
    send(socket, { type: "search-result", users: [] });
    return;
  }

  const users = Object.keys(db.users)
    .filter(username => username.includes(query))
    .filter(username => username !== socket.username)
    .slice(0, 20)
    .map(username => getPublicUser(username));

  send(socket, { type: "search-result", users });
}

function addContact(socket, data) {
  if (!requireLogin(socket)) return;
  const owner = socket.username;
  const contact = normalizeUsername(data.username);

  if (!db.users[contact]) {
    send(socket, { type: "add-contact-error", message: "Пользователь не найден" });
    return;
  }

  if (contact === owner) {
    send(socket, { type: "add-contact-error", message: "Нельзя добавить самого себя" });
    return;
  }

  if (!db.contacts[owner]) db.contacts[owner] = [];
  if (!db.contacts[owner].includes(contact)) db.contacts[owner].push(contact);

  saveDb();
  send(socket, { type: "contacts", contacts: getContactsFor(owner) });
}

function getContacts(socket) {
  if (!requireLogin(socket)) return;
  send(socket, { type: "contacts", contacts: getContactsFor(socket.username) });
}

function callUser(socket, data) {
  if (!requireLogin(socket)) return;

  const from = socket.username;
  const to = normalizeUsername(data.to);

  if (!db.users[to]) {
    send(socket, { type: "call-error", message: "Пользователь не найден" });
    return;
  }

  if (!onlineUsers.has(to)) {
    send(socket, { type: "call-error", message: "Пользователь сейчас не в сети" });
    return;
  }

  const callId = "call_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
  socket.currentCallId = callId;
  socket.currentPeer = to;

  const targetSocket = onlineUsers.get(to);
  targetSocket.currentCallId = callId;
  targetSocket.currentPeer = from;

  sendToUser(to, { type: "incoming-call", callId, from: getPublicUser(from) });
  send(socket, { type: "calling", callId, to: getPublicUser(to) });
}

function acceptCall(socket, data) {
  if (!requireLogin(socket)) return;

  const callId = String(data.callId || "");
  const from = socket.username;
  const to = socket.currentPeer;

  if (!to || socket.currentCallId !== callId) {
    send(socket, { type: "call-error", message: "Вызов не найден" });
    return;
  }

  sendToUser(to, { type: "call-accepted", callId, by: getPublicUser(from) });
  send(socket, { type: "call-started", callId, peer: getPublicUser(to) });
}

function rejectCall(socket, data) {
  if (!requireLogin(socket)) return;

  const callId = String(data.callId || "");
  const from = socket.username;
  const to = socket.currentPeer;

  if (to) {
    sendToUser(to, { type: "call-rejected", callId, by: getPublicUser(from) });
  }

  socket.currentCallId = null;
  socket.currentPeer = null;
  send(socket, { type: "call-ended", callId });
}

function endCall(socket, data) {
  if (!requireLogin(socket)) return;

  const callId = String(data.callId || socket.currentCallId || "");
  const peer = socket.currentPeer;

  if (peer) {
    sendToUser(peer, { type: "call-ended", callId, by: getPublicUser(socket.username) });
    const peerSocket = onlineUsers.get(peer);
    if (peerSocket) {
      peerSocket.currentCallId = null;
      peerSocket.currentPeer = null;
    }
  }

  socket.currentCallId = null;
  socket.currentPeer = null;
  send(socket, { type: "call-ended", callId });
}

function relayWebRtc(socket, data) {
  if (!requireLogin(socket)) return;

  const peer = socket.currentPeer;
  if (!peer) {
    send(socket, { type: "error", message: "No active call peer" });
    return;
  }

  sendToUser(peer, data);
}

wss.on("connection", socket => {
  console.log("Client connected");

  send(socket, { type: "connected", message: "Connected to VideoCall signaling server" });

  socket.on("message", message => {
    let data;

    try {
      data = JSON.parse(message.toString());
    } catch (error) {
      send(socket, { type: "error", message: "Invalid JSON" });
      return;
    }

    const type = data.type;

    if (type === "register") return register(socket, data);
    if (type === "login") return login(socket, data);

    if (type === "logout") {
      logout(socket);
      send(socket, { type: "logout-success" });
      return;
    }

    if (type === "search-user") return searchUser(socket, data);
    if (type === "add-contact") return addContact(socket, data);
    if (type === "get-contacts") return getContacts(socket);
    if (type === "call-user") return callUser(socket, data);
    if (type === "accept-call") return acceptCall(socket, data);
    if (type === "reject-call") return rejectCall(socket, data);
    if (type === "end-call") return endCall(socket, data);

    if (type === "offer" || type === "answer" || type === "candidate") {
      return relayWebRtc(socket, data);
    }

    send(socket, { type: "error", message: "Unknown message type: " + type });
  });

  socket.on("close", () => {
    console.log("Client disconnected");

    const peer = socket.currentPeer;
    const callId = socket.currentCallId;

    if (peer) {
      sendToUser(peer, {
        type: "call-ended",
        callId,
        message: "Собеседник отключился"
      });

      const peerSocket = onlineUsers.get(peer);
      if (peerSocket) {
        peerSocket.currentCallId = null;
        peerSocket.currentPeer = null;
      }
    }

    logout(socket);
  });

  socket.on("error", error => {
    console.log("Socket error:", error.message);
    logout(socket);
  });
});

loadDb();

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`VideoCall signaling server started on port ${PORT}`);
});
