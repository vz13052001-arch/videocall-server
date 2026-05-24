const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("WebRTC signaling server is running\n");
});

const wss = new WebSocket.Server({ server: httpServer });
const rooms = new Map();

function send(socket, data) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function getRoomUsers(roomId) {
  if (!rooms.has(roomId)) return [];
  return Array.from(rooms.get(roomId));
}

function sendToOtherUsers(roomId, senderSocket, data) {
  const users = getRoomUsers(roomId);
  users.forEach(user => {
    if (user !== senderSocket && user.readyState === WebSocket.OPEN) {
      send(user, data);
    }
  });
}

function removeUserFromRoom(socket) {
  const roomId = socket.roomId;
  if (!roomId || !rooms.has(roomId)) return;

  const users = rooms.get(roomId);
  users.delete(socket);

  sendToOtherUsers(roomId, socket, {
    type: "user-left",
    room: roomId
  });

  if (users.size === 0) {
    rooms.delete(roomId);
    console.log(`Room deleted: ${roomId}`);
  } else {
    console.log(`User left room: ${roomId}. Users left: ${users.size}`);
  }

  socket.roomId = null;
  socket.role = null;
}

wss.on("connection", socket => {
  console.log("New client connected");

  send(socket, {
    type: "connected",
    message: "Connected to signaling server"
  });

  socket.on("message", message => {
    let data;

    try {
      data = JSON.parse(message.toString());
    } catch (error) {
      send(socket, {
        type: "error",
        message: "Invalid JSON"
      });
      return;
    }

    const type = data.type;
    const roomId = data.room;

    if (!type) {
      send(socket, {
        type: "error",
        message: "Message type is required"
      });
      return;
    }

    if (type === "join") {
      if (!roomId) {
        send(socket, {
          type: "error",
          message: "Room ID is required"
        });
        return;
      }

      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }

      const users = rooms.get(roomId);

      if (users.size >= 2) {
        send(socket, {
          type: "room-full",
          room: roomId,
          message: "Room already has 2 users"
        });
        return;
      }

      users.add(socket);
      socket.roomId = roomId;
      socket.role = users.size === 1 ? "caller" : "callee";

      send(socket, {
        type: "joined",
        room: roomId,
        role: socket.role,
        users: users.size
      });

      console.log(`User joined room: ${roomId}. Role: ${socket.role}. Users: ${users.size}`);

      if (users.size === 2) {
        users.forEach(user => {
          send(user, {
            type: "ready",
            room: roomId,
            message: "Both users are connected"
          });
        });
      }

      return;
    }

    if (!roomId) {
      send(socket, {
        type: "error",
        message: "Room ID is required"
      });
      return;
    }

    if (!rooms.has(roomId)) {
      send(socket, {
        type: "error",
        message: "Room not found"
      });
      return;
    }

    if (type === "offer") {
      sendToOtherUsers(roomId, socket, {
        type: "offer",
        room: roomId,
        sdp: data.sdp
      });
      return;
    }

    if (type === "answer") {
      sendToOtherUsers(roomId, socket, {
        type: "answer",
        room: roomId,
        sdp: data.sdp
      });
      return;
    }

    if (type === "candidate") {
      sendToOtherUsers(roomId, socket, {
        type: "candidate",
        room: roomId,
        candidate: data.candidate,
        sdpMid: data.sdpMid,
        sdpMLineIndex: data.sdpMLineIndex
      });
      return;
    }

    if (type === "leave") {
      removeUserFromRoom(socket);
      send(socket, {
        type: "left",
        room: roomId
      });
      return;
    }

    send(socket, {
      type: "error",
      message: "Unknown message type"
    });
  });

  socket.on("close", () => {
    console.log("Client disconnected");
    removeUserFromRoom(socket);
  });

  socket.on("error", error => {
    console.log("Socket error:", error.message);
    removeUserFromRoom(socket);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Signaling server started on port ${PORT}`);
});
