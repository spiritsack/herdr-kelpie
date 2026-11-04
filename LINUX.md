# Kelpie on Linux

The board also runs on Linux. The mod and the engine are the same files as on a Mac. What differs per system lives in two modules:

- `mods/board/platform.js`: the mod's side (the systemd unit, the file picker, which service to name in errors);
- `mods/board/engine/platform.mjs`: the engine's side (secrets, the load gate's numbers, Chrome's process names, the brief notes).

Each hook in the shared files carries a `Linux` comment. On a Mac nothing changes: the engine still runs as the launchd agent `dev.herdr.board` and keeps secrets in the Keychain.

A Linux machine can be the one with the app, another machine that Herdr is connected to, or both. Macs and Linux machines can be mixed.

## What you need

On each Linux machine that runs agents:

- systemd with a user instance (`systemctl --user` answers);
- Node 18 or newer, `git` and `hc`, found by your login shell (as on a Mac, the board asks `$SHELL -lic 'command -v node; command -v hc'`);
- for members' secrets: `secret-tool` (libsecret) and a running Secret Service, such as gnome-keyring, or KeePassXC or KWallet with theirs turned on;
- optional: `zenity` for "Browse…" in a task (without it, drag files in), and `xdg-open` to open pull requests.

## Install

As in the README: copy `mods/board/` into `~/.config/herdr-app/mods/` and open a board. The first open installs the engine on each machine:

- the engine's files in `~/.config/herdr-app/board` on the machine with the app, and in `~/.herdr/board` on the others;
- the systemd user unit `~/.config/systemd/user/herdr-board.service`, in place of the plist, with the same program, PATH and `engine.err`. The board then runs `systemctl --user daemon-reload`, `enable` and `restart`;
- the `herdr-board` skill in `~/.agents/skills/` and the link from `~/.claude/skills/`, as on a Mac.

An engine update rewrites the unit and restarts it. If systemd refuses, the board leaves the engine marked as not installed and tries again a minute later.

To see the engine: `systemctl --user status herdr-board`, `journalctl --user -u herdr-board`, and `engine.log` and `engine.err` in the board home.

## How it differs from a Mac

| | macOS | Linux |
|---|---|---|
| The engine's service | launchd agent `dev.herdr.board` | systemd user unit `herdr-board.service` (`WantedBy=default.target`) |
| Secrets | Keychain, service `herdr-board` | Secret Service through `secret-tool`: attributes `service herdr-board` and `account <team>/<member>/<NAME>`. The value goes over stdin, never in argv |
| Load gate | `sysctl` (memory pressure level, swap, load, cores) | `/proc/loadavg`, `/proc/meminfo` and PSI (`/proc/pressure/memory`). Memory pressure becomes the same levels: 2 (warning) at `some avg10` ≥ 10 %, `full avg10` ≥ 2 % or under 5 % of memory available; 4 (critical) at 40 %, 10 % or under 2 % |
| Closing an agent's Chrome | `Google Chrome.app`, Chromium, Chrome for Testing, `chrome-headless-shell` | also `chrome`, `chromium`, `google-chrome*` and `chrome-headless-shell` by their Linux paths |
| Default brief notes | "The shell is zsh"; Safari, Preview, `open` | the machine's own login shell; the desktop browser, an image viewer, `xdg-open` |
| "Browse…" in a task | `osascript` file dialog | `zenity --file-selection` |
| Secrets socket | moves to `~/.herdr/run` when the path nears 100 bytes | the same, at 107 bytes |

## Good to know

- **The unit starts with your systemd user instance**: at your first login (a desktop or ssh login), or at boot with `loginctl enable-linger`. Secrets read only while the keyring is unlocked, which usually means after a desktop login.
- **The unit names the `node` your login shell finds.** If that is a version manager's path and it moves, the engine stops until the next engine update rewrites the unit. Edit `ExecStart` in the unit, or point your login shell at a stable `node`.
- **`~/.config/systemd/user`** is where the unit goes. A systemd user instance that runs with another `XDG_CONFIG_HOME` won't find it.
- **One argument is at most 128 KiB on Linux** (`MAX_ARG_STRLEN`), and `engine.mjs` is near that. The board sends it to every machine in pieces, so this holds on both systems.
- **The app's wording stays Mac-like** in places: "this Mac" in some messages, and "Keychain" in the Teams window.

## Uninstall

Close every board first: an open board reinstalls the engine within a minute.

```sh
systemctl --user disable --now herdr-board.service
rm ~/.config/systemd/user/herdr-board.service && systemctl --user daemon-reload
secret-tool clear service herdr-board         # every member secret on this machine
rm -rf ~/.config/herdr-app/board ~/.config/herdr-app/mods/board   # on other machines: ~/.herdr/board
rm -rf ~/.agents/skills/herdr-board ~/.claude/skills/herdr-board
```

Board worktrees, `board/*` branches and agent terminals stay; remove them as you would on a Mac.

## Tests

```sh
cd mods/board
node --test engine/platform.test.mjs   # the Linux layer; on a Mac, the /proc read is skipped
```
