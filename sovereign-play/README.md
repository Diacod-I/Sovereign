# sovereign-play

A one-button wall-jump climber for your terminal, to play in a second pane while
Claude Code works. When Claude finishes, the match ends on a countdown and sends
you back to read the output.

```
▲ 412m   void 180m
│┊                          ┊│
│^                          ┊│
│┊              *           ^│
│┊                          ┊│  ◄ maya
│@                          ┊│
```

## Play

```bash
node index.js                      # single player
node index.js --host 7777          # host a race
node index.js --join 10.0.0.4:7777 # join one
```

`space` to leap off the wall, `q` to quit, `r` to restart after a fall.

You always cling to a wall and always leap to the other one — the arc is fixed.
The only decision is **when**, because you slide slowly while clinging and the
landing row might be spiked. The void rises from below the whole time, so waiting
is never free.

## Ending the match when Claude is done

Add the Stop hook. As a plugin it is already wired (`hooks/hooks.json`); standalone,
point your project at the script:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "${CLAUDE_PROJECT_DIR}/sovereign-play/scripts/signal-done.sh", "timeout": 5, "async": true }] }
    ]
  }
}
```

The hook drops `.claude/sovereign-play.done`. A running game polls for it, shows
`Claude is done — ending in 7s`, and exits to a scoreboard. In a race, the host
ending propagates to everyone.

The hook does nothing else on purpose: it always exits 0, never blocks a turn, and
is harmless when no game is running.

| Env var | Default | Purpose |
| --- | --- | --- |
| `SOVEREIGN_PLAY_SIGNAL` | `.claude/sovereign-play.done` | Signal path — change it to run several projects side by side |
| `SOVEREIGN_PLAY_COUNTDOWN` | `7` | Seconds between "Claude is done" and the match ending |

## Multiplayer

Both players climb the **same** tower — the host's seed is sent on connect — but
each runs its own physics and only broadcasts a height. There is no position sync
or rollback, because a race up a procedural tower does not need any: two numbers
and a name is the whole protocol, which is also why a flaky connection just makes
a rival's marker stale rather than breaking the game. LAN or localhost; there is
no NAT traversal.

## Tests

```bash
npm test
```

27 assertions with no terminal required. `step()` and `render()` are pure, so the
suite can prove the thing is actually playable: a policy with one jump of
lookahead climbs ~1280m, a policy that jumps blindly manages ~85m, and no row ever
spikes both walls at once (which would be an unavoidable death).

`node index.js --demo 400` prints a single frame headlessly.
