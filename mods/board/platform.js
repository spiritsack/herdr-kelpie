// The board mod's Linux side: the pieces that differ per OS. state.js calls in
// here at the spots marked "Linux"; a Mac keeps its launchd path. See LINUX.md
// at the top of the repository.
import { exec, window } from "herdr";

// A Linux machine runs its engine as this systemd user unit, in place of the
// launchd agent. ensureEngine writes it like the plist.
export const UNIT = "herdr-board.service";

const oses = {};
// A machine's system from `uname -s`, lower case: "linux", "darwin". null is this one.
export async function osOf(machine) {
  const k = machine ?? "";
  if (oses[k]) return oses[k];
  const r = await exec("uname", ["-s"], { on: machine });
  const s = r.stdout.trim().toLowerCase();
  if (r.code !== 0 || !s) throw new Error(`Could not tell which system ${machine ?? "this machine"} runs: ${(r.stderr || r.stdout).trim()}`);
  return (oses[k] = s);
}
export const osNow = (machine) => oses[machine ?? ""] ?? null;

// Where to look when an engine does not answer.
export const serviceHint = (machine, label) =>
  (osNow(machine) ?? (machine ? null : window().platform)) === "linux" ? `systemctl --user status ${UNIT}` : `launchctl print gui/$UID/${label}`;

// The unit's text: the plist's program, PATH and stderr file. It starts with the
// user's systemd instance (default.target), so after a login, or at boot with
// lingering on (loginctl enable-linger).
const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
export const systemdUnit = ({ node, home, hcPath, machine, pathEnv }) => `[Unit]
Description=Herdr board engine

[Service]
ExecStart=${[node, `${home}/engine/engine.mjs`, "--home", home, "--hc", hcPath, "--machine", machine].map(q).join(" ")}
Environment=${q(`PATH=${pathEnv.split(":").filter((d) => d !== "/opt/homebrew/bin").join(":")}`)}
Restart=always
RestartSec=5
StandardOutput=null
StandardError=append:${String(home).replace(/%/g, "%%")}/engine.err

[Install]
WantedBy=default.target
`;

// The end of ensureEngine's install script on Linux ($4: the unit file just
// written, $6: the uid), in place of launchctl: load the unit and (re)start it.
// When that fails, the VERSION just written goes again, so the next check (once
// a minute) tries again instead of calling the engine current.
export const LINUX_SERVICE = `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$6}"
{ systemctl --user daemon-reload && systemctl --user enable --quiet ${UNIT} && systemctl --user restart ${UNIT}; } || { rm -f "$1/engine/VERSION"; echo "Could not start ${UNIT} with systemctl --user." >&2; exit 1; }
exit 0`;

// The file picker on Linux ($1: the output file), run in the background like
// the osascript one: herdr's exec stops after 30 s. zenity exits 1 when the
// person cancels; the paths come one per line.
export const PICK_LINUX = 'o="$1"; nl=$(printf "\\n_"); nl=${nl%_}; (zenity --file-selection --multiple --title="Attach files" --separator="$nl" >"$o" 2>"$o.err"; echo $? >"$o.done") </dev/null >/dev/null 2>&1 &';
