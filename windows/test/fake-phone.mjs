// A pretend iPhone for testing bridge.ps1: the Message Access (MAP) server side of OBEX, over TCP instead of Bluetooth.
// Speaks the subset the bridge uses: CONNECT (MAS target), SETPATH, GET msg-listing / message (with continuation),
// PUT message (single or multi-packet), DISCONNECT.
//   import { fakePhone } from './fake-phone.mjs'; const ph = await fakePhone({ port, maxPacket });
//   ph.inbox.push({ handle, from, text, datetime, type }); ph.sent -> [{ to, text, packets }]; ph.close()
import net from 'node:net';

const MAS = Buffer.from('bb582b40420c11dbb0de0800200c9a66', 'hex');
const be16 = n => Buffer.from([(n >> 8) & 255, n & 255]);
const pkt = (code, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([code]), be16(body.length + 3), body]); };
const hdr = (id, v) => Buffer.concat([Buffer.from([id]), be16(v.length + 3), v]);
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function headers(buf, off) {
  const h = {};
  for (let i = off; i < buf.length;) {
    const id = buf[i], kind = id & 0xC0;
    if (kind === 0x00 || kind === 0x40) { const n = buf.readUInt16BE(i + 1); h[id] = buf.subarray(i + 3, i + n); i += n; }
    else if (kind === 0x80) { h[id] = buf.subarray(i + 1, i + 2); i += 2; }
    else { h[id] = buf.subarray(i + 1, i + 5); i += 5; }
  }
  return h;
}
const appParams = b => { const o = {}; for (let i = 0; b && i + 1 < b.length; i += 2 + b[i + 1]) o[b[i]] = b.subarray(i + 2, i + 2 + b[i + 1]); return o; };
const nameOf = b => (b && b.length > 2 ? Buffer.from(b.subarray(0, b.length - 2)).swap16().toString('utf16le') : '');

export function bmessage(m) {
  const body = String(m.text).split('\n').map(l => /^(BEGIN:|END:)/i.test(l) ? ' ' + l : l).join('\n');
  return ['BEGIN:BMSG', 'VERSION:1.0', 'STATUS:UNREAD', 'TYPE:SMS_GSM', 'FOLDER:telecom/msg/inbox',
    'BEGIN:VCARD', 'VERSION:2.1', 'FN;CHARSET=UTF-8:Rider', 'N:Rider;;;;', 'TEL:' + m.from, 'END:VCARD',
    'BEGIN:BENV', 'BEGIN:BBODY', 'CHARSET:UTF-8', 'LENGTH:' + Buffer.byteLength(body), 'BEGIN:MSG', body, 'END:MSG', 'END:BBODY', 'END:BENV', 'END:BMSG'].join('\r\n') + '\r\n';
}
export function parseBmessage(s) {
  const head = s.split(/BEGIN:BENV/i)[0];
  const to = (/BEGIN:BENV[\s\S]*?(?:TEL|EMAIL)[^:\r\n]*:([^\r\n]*)/i.exec(s) || [])[1] || '';
  const m = /\r?\nBEGIN:MSG\r?\n([\s\S]*?)\r?\nEND:MSG\r?\n/.exec(s);
  const text = m ? m[1].split('\n').map(l => /^ (BEGIN:|END:)/i.test(l) ? l.slice(1) : l).join('\n') : null;
  return { to: to.trim(), text, originatorEmpty: /TEL:\r?\n/.test(head) };
}

export function fakePhone({ port, maxPacket = 0x2000, refuse = 0 } = {}) {
  const st = { inbox: [], sent: [], listings: 0, gets: 0, connects: 0, sockets: new Set() };
  const server = net.createServer(sock => {
    st.sockets.add(sock); sock.on('close', () => st.sockets.delete(sock)); sock.on('error', () => {});
    let buf = Buffer.alloc(0), path = [], pending = null, put = null;
    const reply = b => sock.write(b);
    const sendChunks = () => {  // the next piece of a GET answer
      const room = maxPacket - 3 - 3;
      const piece = pending.subarray(0, room); pending = pending.subarray(room);
      if (pending.length) reply(pkt(0x90, hdr(0x48, piece)));
      else { reply(pkt(0xA0, hdr(0x49, piece))); pending = null; }
    };
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 3 && buf.length >= buf.readUInt16BE(1)) {
        const n = buf.readUInt16BE(1), p = buf.subarray(0, n); buf = buf.subarray(n);
        const op = p[0];
        if (op === 0x80) {
          st.connects++;
          const h = headers(p, 7);
          if (refuse) { reply(pkt(refuse)); continue; }
          if (!h[0x46] || !h[0x46].equals(MAS)) { reply(pkt(0xC4)); continue; }
          reply(pkt(0xA0, Buffer.from([0x10, 0x00]), be16(maxPacket), Buffer.from([0xCB, 0, 0, 0, 1]), hdr(0x4A, MAS)));
        } else if (op === 0x85) {
          const h = headers(p, 5), name = nameOf(h[0x01]);
          if (!name) path = []; else path.push(name.toLowerCase());
          reply(pkt(0xA0));
        } else if (op === 0x83) {
          const h = headers(p, 3);
          if (pending) { sendChunks(); continue; }
          const type = h[0x42] ? h[0x42].toString('ascii').replace(/\0$/, '') : '';
          const name = nameOf(h[0x01]).toLowerCase(), ap = appParams(h[0x4C]);
          if (path.join('/') !== 'telecom/msg') { reply(pkt(0xC4)); continue; }
          if (type === 'x-bt/MAP-msg-listing' && name === 'inbox') {
            st.listings++;
            const max = ap[0x01] ? ap[0x01].readUInt16BE(0) : 1024, subjLen = ap[0x13] ? ap[0x13][0] : 255;
            const items = st.inbox.slice().reverse().slice(0, max);
            const xml = '<?xml version="1.0"?>\n<!DOCTYPE MAP-msg-listing SYSTEM "x-bt/MAP-msg-listing.dtd">\n<MAP-msg-listing version="1.0">\n' +
              items.map(m => `<msg handle="${m.handle}" subject="${m.rawSubject != null ? m.rawSubject : xmlEsc(String(m.text).slice(0, subjLen))}" datetime="${m.datetime}" sender_name="Rider" sender_addressing="${m.noAddr ? '' : xmlEsc(m.from)}" type="${m.type || 'SMS_GSM'}" size="${Buffer.byteLength(m.text)}" read="no"/>`).join('\n') +
              '\n</MAP-msg-listing>\n';
            pending = Buffer.from(xml, 'utf8'); sendChunks();
          } else if (type === 'x-bt/message') {
            st.gets++;
            const m = st.inbox.find(x => String(x.handle) === name);
            if (!m) { reply(pkt(0xC4)); continue; }
            pending = Buffer.from(bmessage(m), 'utf8'); sendChunks();
          } else reply(pkt(0xC0));
        } else if (op === 0x02 || op === 0x82) {
          const h = headers(p, 3);
          if (!put) put = { name: nameOf(h[0x01]).toLowerCase(), type: h[0x42] ? h[0x42].toString('ascii').replace(/\0$/, '') : '', parts: [], packets: 0 };
          put.packets++;
          if (h[0x48]) put.parts.push(h[0x48]);
          if (h[0x49]) put.parts.push(h[0x49]);
          if (op === 0x02) { reply(pkt(0x90)); continue; }
          const msg = parseBmessage(Buffer.concat(put.parts).toString('utf8'));
          const ok = put.type === 'x-bt/message' && put.name === 'outbox' && path.join('/') === 'telecom/msg';
          if (ok) st.sent.push(Object.assign(msg, { packets: put.packets }));
          reply(ok ? pkt(0xA0, hdr(0x01, Buffer.from('2000' + st.sent.length + '\0', 'utf16le').swap16())) : pkt(0xC0));
          put = null;
        } else if (op === 0x81) { reply(pkt(0xA0)); }
        else reply(pkt(0xD1));
      }
    });
  });
  return new Promise(res => server.listen(port, '127.0.0.1', () => res(Object.assign(st, {
    close: () => new Promise(r => { st.sockets.forEach(s => s.destroy()); server.close(() => r()); }),
  }))));
}

// The iPhone's hands-free side (HFP Audio Gateway) for calling tests: answers the link setup, records ATD numbers.
//   const ag = await fakeAg({ port, refuseDial }); ag.dialed -> ['+15125550101', …]; ag.commands -> every AT command seen
export function fakeAg({ port, refuseDial = false, refuseSetup = false } = {}) {
  const st = { dialed: [], commands: [], sockets: new Set() };
  const server = net.createServer(sock => {
    st.sockets.add(sock); sock.on('close', () => st.sockets.delete(sock)); sock.on('error', () => {});
    let buf = '';
    const say = (...lines) => sock.write(lines.map(l => '\r\n' + l + '\r\n').join(''));
    sock.on('data', d => {
      buf += d.toString('ascii');
      let i;
      while ((i = buf.indexOf('\r')) >= 0) {
        const cmd = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!cmd) continue;
        st.commands.push(cmd);
        if (refuseSetup && cmd.startsWith('AT+BRSF')) { say('ERROR'); continue; }
        if (/^AT\+BRSF=\d+$/.test(cmd)) say('+BRSF: 871', 'OK');
        else if (cmd === 'AT+CIND=?') say('+CIND: ("service",(0,1)),("call",(0,1)),("callsetup",(0-3)),("battchg",(0-5)),("signal",(0-5)),("roam",(0,1)),("callheld",(0-2))', 'OK');
        else if (cmd === 'AT+CIND?') say('+CIND: 1,0,0,5,4,0,0', 'OK');
        else if (/^AT\+CMER=/.test(cmd)) say('OK');
        else if (/^ATD[+\d]+;$/.test(cmd)) {
          if (refuseDial) say('ERROR');
          else { st.dialed.push(cmd.slice(3, -1)); say('OK'); setTimeout(() => say('+CIEV: 3,2'), 100); }
        } else say('ERROR');
      }
    });
  });
  return new Promise(res => server.listen(port, '127.0.0.1', () => res(Object.assign(st, {
    close: () => new Promise(r => { st.sockets.forEach(s => s.destroy()); server.close(() => r()); }),
  }))));
}
