// Multiplayer, kept as small as it can possibly be.
//
// Both players climb the SAME tower — the host's seed is sent to everyone — but
// each client runs its own physics locally and only broadcasts a height. There
// is no position sync, no rollback, no tick alignment, because a race up a
// procedural tower does not need any of it. Two numbers and a name is the entire
// protocol, which is also why it survives a flaky connection.

import net from 'node:net';

const line = (obj) => JSON.stringify(obj) + '\n';

/** Splits a socket's stream into newline-delimited JSON objects. */
function onMessages(sock, fn) {
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!raw.trim()) continue;
      try { fn(JSON.parse(raw)); } catch {}
    }
  });
}

export function host(port, seed, name, onPeers) {
  const peers = new Map(); // socket -> { name, best }
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    sock.write(line({ type: 'hello', seed }));
    peers.set(sock, { name: 'player', best: 0 });

    onMessages(sock, (m) => {
      if (m.type === 'state') {
        peers.set(sock, { name: String(m.name ?? 'player').slice(0, 12), best: Number(m.best) || 0 });
        onPeers([...peers.values()]);
      }
    });
    const drop = () => { peers.delete(sock); onPeers([...peers.values()]); };
    sock.on('close', drop);
    sock.on('error', drop);
  });
  server.listen(port);

  return {
    server,
    broadcast(best, ending) {
      const msg = line({ type: 'state', name, best, ending });
      for (const sock of peers.keys()) { try { sock.write(msg); } catch {} }
    },
    close() { for (const s of peers.keys()) s.destroy(); server.close(); },
  };
}

export function join(host, port, name, onSeed, onPeers, onEnding) {
  const sock = net.createConnection({ host, port });
  sock.setNoDelay(true);
  onMessages(sock, (m) => {
    if (m.type === 'hello') onSeed(m.seed);
    if (m.type === 'state') {
      onPeers([{ name: String(m.name ?? 'host').slice(0, 12), best: Number(m.best) || 0 }]);
      if (m.ending) onEnding(m.ending);
    }
  });
  return {
    sock,
    broadcast(best) { try { sock.write(line({ type: 'state', name, best })); } catch {} },
    close() { sock.destroy(); },
  };
}
