import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ host: '127.0.0.1', port: 38451 });
wss.on('listening', () => console.log('listening ws://127.0.0.1:38451'));
wss.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    console.log(isBinary ? `binary ${data.length} bytes` : `text ${data.toString()}`);
  });
});
