import WebSocket from 'ws';
import EventEmitter from 'events';

export default class UlanziApi extends EventEmitter {
  constructor() {
    super();
    this.uuid = '';
    this.websocket = null;
    this.address = '127.0.0.1';
    this.port = 3906;
  }

  connect(uuid, defaultPort = 3906, defaultAddress = '127.0.0.1') {
    const [argvAddress, argvPort] = process.argv.slice(2);
    this.address = argvAddress || defaultAddress;
    this.port = argvPort || defaultPort;
    this.uuid = uuid;

    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }

    const isMain = this.uuid.split('.').length === 4;
    this.websocket = new WebSocket(`ws://${this.address}:${this.port}`);

    this.websocket.on('open', () => {
      this.websocket.send(
        JSON.stringify({
          code: 0,
          cmd: 'connected',
          uuid: this.uuid,
        })
      );
      this.emit('connected');
    });

    this.websocket.on('error', (err) => {
      this.emit('error', err);
    });

    this.websocket.on('close', () => {
      this.emit('close');
    });

    this.websocket.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!data || (typeof data.code !== 'undefined' && data.cmdType !== 'REQUEST')) {
        return;
      }

      if (isMain) {
        this.send(data.cmd, { code: 0, ...data });
      }

      if (data.cmd === 'clear' && Array.isArray(data.param)) {
        for (const item of data.param) {
          item.context = this.encodeContext(item);
        }
      } else {
        data.context = this.encodeContext(data);
      }

      this.emit(data.cmd, data);
    });
  }

  encodeContext(msg) {
    return `${msg.uuid}___${msg.key}___${msg.actionid}`;
  }

  decodeContext(context) {
    const [uuid, key, actionid] = String(context).split('___');
    return { uuid, key, actionid };
  }

  send(cmd, params = {}) {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(
        JSON.stringify({
          cmd,
          uuid: this.uuid,
          ...params,
        })
      );
    }
  }

  setBaseDataIcon(context, data, text = '') {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send('state', {
      param: {
        statelist: [
          {
            uuid,
            key,
            actionid,
            type: 1,
            data,
            textData: text,
            showtext: Boolean(text),
          },
        ],
      },
    });
  }

  toast(msg) {
    this.send('toast', { msg });
  }
}
