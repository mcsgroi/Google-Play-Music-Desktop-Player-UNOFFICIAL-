import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket, { Server as WebSocketServer } from 'ws';

let server;
let oldTime = {};

let mdns;
try {
  mdns = require('mdns');
} catch (e) {
  Logger.error('Failed to load bonjour with error: %j', e);
  if (process.platform === 'win32') {
    Emitter.sendToWindowsOfName('main', 'bonjour-install');
  }
}

const changeEvents = ['song', 'state', 'rating', 'lyrics', 'shuffle', 'repeat', 'playlists'];
const API_VERSION = JSON.parse(fs.readFileSync(path.resolve(`${__dirname}/../../../../package.json`))).apiVersion;

let ad;

changeEvents.forEach((channel) => {
  PlaybackAPI.on(`change:${channel}`, (newValue) => {
    if (server && server.broadcast) {
      server.broadcast(channel === 'state' ? 'playState' : channel, newValue);
    }
  });
});

PlaybackAPI.on('change:time', (timeObj) => {
  if (server && server.broadcast) {
    if (JSON.stringify(timeObj) !== JSON.stringify(oldTime)) {
      oldTime = timeObj;
      server.broadcast('time', timeObj);
    }
  }
});

const enableAPI = () => {
  server = new WebSocketServer({ port: global.API_PORT || process['env'].GPMDP_API_PORT || 5672 }, () => { // eslint-disable-line
    if (ad) {
      ad.stop();
      ad = null;
    }

    try {
      ad = mdns.createAdvertisement(mdns.tcp('GPMDP'), 5672, {
        name: os.hostname(),
        txtRecord: {
          API_VERSION,
        },
      });

      ad.start();
    } catch (e) {
      Logger.error('Could not initialize bonjour service with error: %j', e);
    }
    if (ad) ad.on('error', () => {});

    server.broadcast = (channel, data) => {
      server.clients.forEach((client) => {
        if (client.readyState !== WebSocket.OPEN) return;
        client.channel(channel, data);
      });
    };

    server.on('connection', (websocket) => {
      const ws = websocket;

      ws.json = (obj) => {
        ws.send(JSON.stringify(obj));
      };
      ws.channel = (channel, obj) => {
        ws.json({
          channel,
          payload: obj,
        });
      };

      ws.on('message', (data) => {
        try {
          const command = JSON.parse(data);
          if (command.namespace && command.method) {
            if (command.namespace === 'connect' && command.method === 'connect' && command.arguments.length === 1) {
              Emitter.sendToGooglePlayMusic('register_controller', {
                name: command.arguments[0],
              });
              return;
            }
            const args = command.arguments || [];
            if (!Array.isArray(args)) {
              throw Error('Bad arguments');
            }
            Emitter.sendToGooglePlayMusic('execute:gmusic', {
              namespace: command.namespace,
              method: command.method,
              args,
            });
          } else {
            throw Error('Bad command');
          }
        } catch (err) {
          Logger.error('WebSocketAPI Error: Invalid message recieved', { err, data });
        }
      });

      ws.channel('API_VERSION', API_VERSION);
      ws.channel('playState', PlaybackAPI.isPlaying());
      ws.channel('shuffle', PlaybackAPI.currentShuffle());
      ws.channel('repeat', PlaybackAPI.currentRepeat());
      ws.channel('playlists', PlaybackAPI.getPlaylists());
      if (PlaybackAPI.currentSong(true)) {
        ws.channel('song', PlaybackAPI.currentSong(true));
        ws.channel('time', PlaybackAPI.currentTime());
        ws.channel('lyrics', PlaybackAPI.currentSongLyrics(true));
      }
    });
  });

  server.on('error', () => {
    Emitter.sendToWindowsOfName('main', 'error', {
      title: 'Could not start Playback API',
      message: 'The playback API attempted (and failed) to start on port 5672.  Another application is probably using this port',  // eslint-disable-line
    });
    server = null;
  });
};

Emitter.on('playbackapi:toggle', (event, state) => {
  if (!state.state && server) {
    server.close();
    server = null;
  }
  if (state.state) {
    if (!server) {
      enableAPI();
    }
  } else if (ad) {
    ad.stop();
    ad = null;
  }
  Settings.set('playbackAPI', state.state);
});

if (Settings.get('playbackAPI', false)) {
  enableAPI();
}
