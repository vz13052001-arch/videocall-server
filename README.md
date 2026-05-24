# videocall-server

Сервер сигнализации для WebRTC-видеозвонков.

## Запуск локально в Termux

```bash
npm install
npm start
```

После запуска сервер будет доступен локально:

```text
ws://IP_ТЕЛЕФОНА:3000
```

## Запуск на хостинге

Команда запуска:

```bash
npm start
```

Build command:

```bash
npm install
```

Сервер слушает порт из переменной `PORT`, поэтому подходит для Render/Replit/VPS.
