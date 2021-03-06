const path = require('path');
const Slash = require('slash');

const Networking = require('./networking');
const Window = require('./window');

const EMOTES = {
  bow: 43,
  kitchen: 44,
  dance: 44,
  settle: 51,
  peace: 52
};

const CHANGERS = {
  chest: 0xA,
  height: 0xB,
  thighs: 0xC,
};

function id2str(id) {
  return `${id.high},${id.low}`;
}

function str2id(str) {
  const [high, low] = str.split(',');
  return { high, low };
}

function dye2int({r, g, b, a, o}) {
  return o ? (a << 24) | (r << 16) | (g << 8) | b : 0;
}

module.exports = function ArboreanApparel(dispatch) {
  const slash = new Slash(dispatch);
  const net = new Networking();
  const win = new Window();

  let myId;
  let outfit = {};
  let override = {};

  const networked = new Map();

  let selfInfo = {
    name: '',
    job: -1,
    race: -1,
    gender: -1,
  };

  let options = {
    hideidle: false,
    hidecb: false,
  };

  let crystalbind = {
    expires: 0,
    stacks: 0,
    type: 0,
  };

  const changer = {
    state: 0,
    field: 0,
    value: 0,
  };

  this.destructor = () => {
    net.close();
    win.close();
  };

  function broadcast(...args) {
    win.send(...args);
    net.send(...args);
  }

  function setOption(option, value) {
    if (options[option] !== value) {
      options[option] = value;
      broadcast('option', option, value);
      return true;
    }
    return false;
  }

  function toggleCrystalbind() {
    if (!crystalbind.expires) return; // no cb to toggle

    const { hidecb } = options;
    const add = 4600 + 10 * crystalbind.type;
    const rem = 1101 + 2 * crystalbind.type;
    const duration = crystalbind.expires - Date.now();

    broadcast('crystalbind', {
      expires: hidecb ? 0 : duration,
      stacks: crystalbind.stacks,
      type: crystalbind.type,
    });

    dispatch.toClient('S_ABNORMALITY_END', 1, {
      target: myId,
      id: hidecb ? add : rem,
    });

    dispatch.toClient('S_ABNORMALITY_BEGIN', 1, {
      target: myId,
      source: myId,
      id: hidecb ? rem : add,
      duration: duration,
      stacks: crystalbind.stacks,
    });
  }

  function doEmote(name) {
    const emote = EMOTES[name];
    if (!emote) return;

    if (!options.hideidle && (emote === 44 || emote === 51)) {
      setOption('hideidle', true);
      slash.print('[AA] Idle animations disabled.');
    }

    net.send('emote', emote);

    dispatch.toClient('S_SOCIAL', 1, {
      target: myId,
      animation: emote,
    });
  }

  function startChanger(name) {
    if (changer.state === 0) {
      dispatch.toClient('S_REQUEST_CONTRACT', 1, {
        senderId: myId,
        type: 0x3D,
        id: -1,
      });

      dispatch.toClient('S_INGAME_CHANGE_USER_APPEARANCE_START', 1, {
        dialogId: -1,
        field: CHANGERS[name],
      });
      changer.state = 1;
    } else {
      slash.print('[AA] Changer already in use.');
    }
  }

  /* --------- *
   * UI EVENTS *
   * --------- */
  win.on('load', () => {
    win.send('character', selfInfo);
    win.send('outfit', outfit, override);
    for (const k of Object.keys(options)) win.send('option', k, options[k]);
  });

  win.on('change', (over) => {
    for (const type of Object.keys(over)) {
      const id = over[type];
      if (id === false) {
        delete override[type];
      } else {
        override[type] = type.endsWith('Dye') ? dye2int(id) : id;
      }
    }

    net.send('outfit', override); // TODO

    dispatch.toClient('S_USER_EXTERNAL_CHANGE', 1,
      Object.assign({}, outfit, override)
    );
  });

  win.on('text', (info) => {
    net.send('text', info.id, info.text);

    dispatch.toClient('S_ITEM_CUSTOM_STRING', 1, {
      owner: myId,
      items: [{ item: info.id, text: info.text }],
    });
  });

  win.on('option', (option, value) => {
    const changed = setOption(option, value);

    if (option === 'hideidle') {
      slash.print(`[AA] Idle animations ${value ? 'dis' : 'en'}abled.`);
    } else if (option === 'hidecb') {
      if (changed) toggleCrystalbind();
      slash.print(`[AA] Crystalbind ${value ? 'dis' : 'en'}abled.`);
    }
  });

  win.on('emote', doEmote);

  win.on('changer', (name) => {
    startChanger(name);
  });

  slash.on('aa', (args) => {
    const [, cmd, arg] = args;
    switch (cmd) {
      case 'open': {
        win.show();
        break;
      }

      case 'idle': {
        setOption('hideidle', arg
          ? !!arg.match(/^(0|no|off|disabled?)$/i)
          : !options.hideidle
        );
        slash.print("[AA] Idle animations " + (options.hideidle ? 'dis' : 'en') + "abled.");
        break;
      }

      case 'cb':
      case 'crystalbind': {
        const changed = setOption('hidecb', arg
          ? !!args[1].match(/^(0|no|off|disabled?)$/i)
          : !options.hidecb
        );

        if (changed) {
          toggleCrystalbind();
        }

        slash.print("[AA] Crystalbind " + (options.hidecb ? 'dis' : 'en') + "abled.");
        break;
      }

      // TODO changer

      default: {
        if (EMOTES[cmd]) {
          doEmote(cmd);
          break;
        }

        if (CHANGERS[cmd]) {
          startChanger(cmd);
          break;
        }

        slash.print([
          '[AA] Usage:',
          '* /w /aa open - Opens the AA interface.',
          '* /w /aa idle [on|off] - Shows or hides your idle animations.',
          '* /w /aa cb [on|off] - Shows or hides your Crystalbind.',
        ].join('<br>'), true);
        break;
      }
    }
  });

  /* ----------- *
   * GAME EVENTS *
   * ----------- */
  dispatch.hook('S_LOGIN', 1, (event) => {
    myId = event.cid;

    let model = event.model - 10101;
    const job = model % 100;
    model = Math.floor(model / 100);
    const race = model >> 1;
    const gender = model % 2;

    selfInfo = {
      name: event.name,
      job,
      race,
      gender,
    };

    // TO DO look up saved settings
    outfit = {};
    override = {};

    net.send('login', id2str(myId));
    win.send('character', selfInfo);
    for (const key of Object.keys(options)) {
      broadcast('option', key, options[key]);
    }
    //broadcast('outfit', outfit, override);
    net.send('outfit', override);
    win.send('outfit', outfit, override);
  });

  dispatch.hook('S_SPAWN_USER', 1, (event) => {
    const user = networked.get(id2str(event.cid));
    if (!user) return;

    Object.assign(user.outfit, event); // save real setup
    Object.assign(event, user.override); // write custom setup

    if (user.override.costume && user.override.costumeText != null) {
      process.nextTick(() => {
        dispatch.toClient('S_ITEM_CUSTOM_STRING', 1, {
          owner: event.id,
          items: [{ item: user.override.costume, text: user.override.costumetext }],
        });
      });
    }

    return true;
  });

  dispatch.hook('S_USER_EXTERNAL_CHANGE', 1, (event) => {
    // self
    if (event.id.equals(myId)) {
      outfit = Object.assign({}, event);
      win.send('outfit', outfit, override);
      Object.assign(event, override);
      return true;
    }

    // other
    const user = networked.get(id2str(event.id));
    if (user) {
      Object.assign(user.outfit, event);
      user.outfit.inner = user.outfit.innerwear; // TODO
      Object.assign(event, user.override);
      event.innerwear = event.inner; // TODO
      return true;
    }
  });

  dispatch.hook('S_ITEM_CUSTOM_STRING', 1, (event) => {
    const user = networked.get(id2str(event.owner));
    if (user && user.override.costumeText != null) return false;
  });

  dispatch.hook('S_SOCIAL', 1, (event) => {
    if ([31, 32, 33].indexOf(event.animation) === -1) return;

    if (event.target.equals(myId)) {
       if (options.hideidle) return false;
    } else {
      const user = networked.get(id2str(event.target));
      if (user && user.options.hideidle) return false;
    }
  });

  function setCrystalbind(event) {
    if (event.id !== 4600 && event.id !== 4610) return;

    if (event.target.equals(myId)) {
      crystalbind = {
        expires: Date.now() + event.duration,
        stacks: event.stacks,
        type: +(event.id === 4610),
      };

      if (options.hidecb) {
        event.id = 1101 + 2 * crystalbind.type;
        return true;
      }
    } else {
      const user = networked.get(id2str(event.id));
      if (user && user.options.hidecb) return false;
    }
  }
  dispatch.hook('S_ABNORMALITY_BEGIN', 1, setCrystalbind);
  dispatch.hook('S_ABNORMALITY_REFRESH', 1, setCrystalbind);

  dispatch.hook('S_ABNORMALITY_END', 1, (event) => {
    if (event.target.equals(myId)) {
      if (event.id === 4600 || event.id === 4610) {
        crystalbind = {
          expires: 0,
          stacks: 0,
          type: 0,
        };

        if (options.hidecb) {
          event.id = 1101 + 2 * (event.id === 4610);
          return true;
        }
      }
    }
  });

  // CHANGERS
  dispatch.hook('S_INGAME_CHANGE_USER_APPEARANCE_START', 1, (event) => {
    changer.state = -1;
  });

  dispatch.hook('C_INGAME_CHANGE_USER_APPEARANCE_TRY', 1, (event) => {
    if (changer.state === 1) {
      Object.assign(changer, { state: 2 }, event);
      return false;
    }
  });

  dispatch.hook('cIngameChangeUserAppearanceCancel', (event) => {
    switch (changer.state) {
      case 2: {
        process.nextTick(() => {
          dispatch.toClient('S_PREPARE_INGAME_CHANGE_USER_APPEARANCE', 1, changer);
        });
        return false;
      }

      case 1: {
        process.nextTick(() => {
          dispatch.toClient('S_INGAME_CHANGE_USER_APPEARANCE_CANCEL', 1, {
            dialogId: -1,
          });
        });
        changer.state = 0;
        return false;
      }

      default: {
        changer.state = 0;
        break;
      }
    }
  });

  dispatch.hook('C_COMMIT_INGAME_CHANGE_USER_APPEARANCE', 1, (event) => {
    if (changer.state === 2) {
      process.nextTick(() => {
        dispatch.toClient('S_USER_APPEARANCE_CHANGE', 1, {
          id: myId,
          field: changer.field,
          value: changer.value,
        });

        dispatch.toClient('S_RESULT_INGAME_CHANGE_USER_APPEARANCE', 1, {
          ok: 1,
          field: changer.field,
        });

        net.send('changer', changer.field, changer.value);
        changer.state = 0;
      });

      return false;
    }
  });

  /* ------------- *
   * SERVER EVENTS *
   * ------------- */
  function addUser(id, user = {}) {
    if (!user.outfit) user.outfit = {};
    if (!user.override) user.override = {};
    if (!user.options) user.options = {};
    networked.set(id, user);
  }

  net.on('connect', () => {
    if (!myId || myId.isZero()) return;

    net.send('login', id2str(myId));
    net.send('options', options);
    net.send('outfit', override);
    // TODO: text, cb?
  });

  net.on('users', (users) => {
    for (const id of Object.keys(users)) {
      addUser(id, users[id]);
    }
  });

  net.on('add', (id) => {
    addUser(id);
  });

  net.on('remove', (id) => {
    networked.delete(id);
  });

  net.on('ping', () => {
    net.send('pong');
  });

  net.on('outfit', (id, over) => {
    if (!networked.has(id)) return;

    const user = networked.get(id);
    user.override = over;

    const base = {
      id: str2id(id),
      enable: true,
    };
    const outfit = Object.assign(base, user.outfit, user.override);
    dispatch.toClient('S_USER_EXTERNAL_CHANGE', 1, outfit);
  });

  net.on('text', (id, item, text) => {
    if (networked.has(id)) {
      Object.assign(networked.get(id).override, { costume: item, costumeText: text });
    }

    dispatch.toClient('S_ITEM_CUSTOM_STRING', 1, {
      owner: str2id(id),
      items: [{ item, text }],
    });
  });

  net.on('option', (id, key, val) => {
    if (networked.has(id)) networked.get(id).options[key] = val;
  });

  net.on('cb', (id, cb) => {
    const cid = str2id(id);
    const type = 4600 + 10 * cb.type;

    if (cb.expires) {
      dispatch.toClient('S_ABNORMALITY_BEGIN', 1, {
        target: cid,
        source: cid,
        id: type,
        duration: crystalbind.expires,
        stacks: crystalbind.stacks,
      });
    } else {
      dispatch.toClient('S_ABNORMALITY_END', 1, {
        target: cid,
        id: type,
      });
    }
  });

  net.on('emote', (id, emote) => {
    dispatch.toClient('S_SOCIAL', 1, {
      target: str2id(id),
      animation: emote,
    });
  });

  net.on('changer', (id, field, value) => {
    dispatch.toClient('S_USER_APPEARANCE_CHANGE', 1, {
      id: str2id(id),
      field,
      value,
    });
  });

  net.on('error', (err) => {
    // TODO
    console.warn(err);
  });

  /* ---------- *
   * INITIALIZE *
   * ---------- */
  net.connect({ host: 'localhost', port: 3458 });
  win.show();
};
