#!/usr/bin/env python3
"""dsh-multi-user — repoint a reverse proxy at the gateway.

Goal: the URL people already use should land on the multi-user gateway instead
of the raw DSH instance, without disturbing anything else nginx serves.

Design constraints — each one has caused a real incident somewhere:

* **Patch only the file that actually wins.** ``sites-enabled`` accumulates
  stale backups that still declare the same ``listen`` port. Rewriting all of
  them "works" but leaves the shadowed copies advertising a config nobody
  serves, and a later restore from one of them silently reverts the change. The
  effective file is the first one nginx loads that owns the upstream, which
  ``nginx -T`` tells us authoritatively.
* **Never edit backup-looking files.** ``*.bak*``, ``*~``, ``*.disabled``,
  ``*.orig``, ``*.save`` are reported as leftovers to move out, never written.
* **Classify by the path nginx loaded, not the symlink target.** A leftover can
  itself be a symlink (``dsh-web.bak-20260910-180829 -> sites-available/dsh-web``).
  Resolving first moves it out of ``sites-enabled`` on paper, so it never gets
  flagged as the port conflict it really is. Match the reported path; resolve
  only when reading or writing.
* **Always sweep, not just on the write path.** An install that finds the
  routing already correct used to return before cleanup, so leftovers from an
  earlier build survived every subsequent run. Sweeping is unconditional.
* **Only rewrite the DSH upstream.** A sidecar or API service proxied from the
  same block keeps its target.
* **Validate before reloading.** ``nginx -t`` runs first; on failure every
  patched file is restored and nothing is reloaded.
* **Idempotent.** A file already pointing at the gateway reports
  ``already routed`` and is not rewritten.

Exit codes: 0 changed or already correct, 2 nothing to do, 3 needs root,
1 failure.
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

SITES_DIRS = (Path("/etc/nginx/sites-enabled"), Path("/etc/nginx/conf.d"))
# Backups live OUTSIDE the directories nginx includes. A `*.bak` left next to a
# live site is still loaded by nginx, which is how a machine ends up with three
# server blocks fighting over one port (and how a later "restore" silently
# reinstates the wrong one).
BACKUP_DIR = Path("/etc/nginx/.dshmu-backups")
OUR_BACKUP_MARKER = ".bak-dshmu-"
LEFTOVER_PATTERNS = (
    re.compile(r"\.bak($|[.\-])"),
    re.compile(r"\.orig$"),
    re.compile(r"\.save$"),
    re.compile(r"\.disabled$"),
    re.compile(r"~$"),
)


def proxy_pattern(port: int) -> re.Pattern[str]:
    return re.compile(
        r"proxy_pass\s+http://(?:127\.0\.0\.1|localhost|\[::1\]):%d(?P<tail>/[^\s;]*)?" % port
    )


def is_leftover(path: Path) -> bool:
    name = path.name
    if OUR_BACKUP_MARKER in name:
        return True
    return any(pattern.search(name) for pattern in LEFTOVER_PATTERNS)


def sweep(stale_files: list[Path], verbose: bool = True) -> int:
    """Move leftover backups out of the nginx include path.

    A ``*.bak`` sitting next to a live site is still loaded by nginx: it declares
    the same ``listen`` port and produces ``conflicting server name`` warnings,
    and if the live file ever disappears the stale one silently takes over. The
    symlinked case moves the link only — the target in ``sites-available`` is
    untouched.
    """
    moved = 0
    for stale in stale_files:
        try:
            BACKUP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
            destination = BACKUP_DIR / stale.name
            if destination.exists():
                destination.unlink()
            stale.replace(destination)
            moved += 1
            if verbose:
                print(f"moved leftover out of the nginx include path: {stale.name} -> {BACKUP_DIR}")
        except OSError as error:
            print(f"warn: could not move {stale}: {error}", file=sys.stderr)
    return moved


def run_nginx(args: list[str]) -> tuple[int, str]:
    try:
        completed = subprocess.run(["nginx", *args], capture_output=True, text=True, timeout=60, check=False)
    except FileNotFoundError:
        return 127, "nginx not found"
    except subprocess.TimeoutExpired:
        return 124, "nginx timed out"
    return completed.returncode, (completed.stdout or "") + (completed.stderr or "")


def dumped_files() -> dict[str, str]:
    """The configuration nginx would actually load: path -> text, in load order.

    ``nginx -T`` prefixes each file with ``# configuration file <path>:``. Files
    that are never reached (or excluded by an ``include``) do not appear, which
    is exactly the discrimination we want.
    """
    code, output = run_nginx(["-T"])
    if code != 0:
        raise RuntimeError(f"nginx -T failed ({code}):\n{output}")
    files: dict[str, str] = {}
    current: str | None = None
    buffer: list[str] = []
    for line in output.splitlines():
        if line.startswith("# configuration file ") and line.endswith(":"):
            if current is not None:
                files[current] = "\n".join(buffer)
            current = line[len("# configuration file "):-1].strip()
            buffer = []
        elif current is not None:
            buffer.append(line)
    if current is not None:
        files[current] = "\n".join(buffer)
    return files


def loaded_candidates() -> list[Path]:
    """Files nginx loads that live in a directory we may edit."""
    out: list[Path] = []
    for raw in dumped_files():
        path = Path(raw)
        try:
            real = path.resolve()
        except OSError:
            real = path
        for directory in SITES_DIRS:
            try:
                real.relative_to(directory.resolve())
                break
            except (ValueError, OSError):
                continue
        else:
            continue
        if real not in out:
            out.append(real)
    return out


def strip_sudo_pw(argv: list[str]) -> list[str]:
    """Drop ``--sudo-pw <value>`` (and its value) before re-executing under sudo.

    Leaving the value behind turns it into a stray positional argument, which
    argparse then rejects — so both tokens have to go.
    """
    out: list[str] = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--sudo-pw":
            index += 2
            continue
        if token.startswith("--sudo-pw="):
            index += 1
            continue
        out.append(token)
        index += 1
    return out


def elevate(argv: list[str], sudo_pw: str) -> int:
    inner = " ".join(shlex.quote(part) for part in [sys.executable, __file__, *argv])
    completed = subprocess.run(["sudo", "-S", "-p", "", "bash", "-c", inner], input=f"{sudo_pw}\n", text=True, check=False)
    return completed.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway-port", type=int, required=True)
    parser.add_argument("--dsh-port", type=int, default=3080)
    parser.add_argument("--stamp", default="manual")
    parser.add_argument("--sudo-pw", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if os.geteuid() != 0 and not args.dry_run:
        if args.sudo_pw:
            return elevate(strip_sudo_pw(sys.argv[1:]), args.sudo_pw)
        print("needs root to edit /etc/nginx (pass --sudo-pw, or --dry-run to only inspect)", file=sys.stderr)
        return 3

    if args.gateway_port == args.dsh_port:
        print(f"gateway port equals the DSH port ({args.dsh_port}); nothing to do")
        return 2

    try:
        dumps = dumped_files()
    except RuntimeError as error:
        message = str(error)
        if "cannot load certificate" in message or "BIO_new_file" in message:
            print(
                "nginx -T needs root to read the TLS certificate key.\n"
                "Re-run with sudo, or pass --sudo-pw.",
                file=sys.stderr,
            )
            return 3
        print(message, file=sys.stderr)
        return 1
    if not dumps:
        print("nginx reported no configuration files")
        return 2

    to_gateway = proxy_pattern(args.gateway_port)
    to_dsh = proxy_pattern(args.dsh_port)

    effective: Path | None = None
    leftovers: list[Path] = []
    already: Path | None = None

    for raw, text in dumps.items():
        reported = Path(raw)
        if not any(_under(reported, directory) for directory in SITES_DIRS):
            continue
        try:
            real = reported.resolve()
        except OSError:
            real = reported
        owns_dsh = to_dsh.search(text) is not None
        owns_gateway = to_gateway.search(text) is not None
        # Classify on the reported name: a leftover may be a symlink whose target
        # lives outside sites-enabled, and resolving first would hide it.
        if is_leftover(reported):
            if owns_dsh or owns_gateway:
                leftovers.append(reported)
            continue
        if owns_gateway and effective is None and already is None:
            already = real
            # Do not break: a later, shadowed block may still point at DSH, and
            # that is worth reporting even though we will not touch it.
        if owns_dsh and effective is None:
            effective = real

    for path in leftovers:
        print(f"note: {path} is a leftover backup but nginx still loads it — it claims the same port")
    swept = sweep(leftovers) if (leftovers and not args.dry_run) else 0

    if already is not None and effective is None:
        print(f"already routed: {already}")
        return reload_nginx() if swept else 0
    if effective is None:
        print(f"no loaded server block proxies to 127.0.0.1:{args.dsh_port}; leaving nginx alone")
        return reload_nginx() if swept else 2

    try:
        original = effective.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        print(f"cannot read {effective}: {error}", file=sys.stderr)
        return 1

    updated, count = to_dsh.subn(
        lambda match: f"proxy_pass http://127.0.0.1:{args.gateway_port}{match.group('tail') or ''}",
        original,
    )
    if count == 0 or updated == original:
        print(f"already routed: {effective}")
        return reload_nginx() if swept else 0

    if args.dry_run:
        print(f"would rewrite {effective} ({count} target(s)) -> :{args.gateway_port}")
        return 0

    backup = BACKUP_DIR / f"{effective.name}.{args.stamp}"
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not backup.exists():
            backup.write_bytes(effective.read_bytes())
        effective.write_text(updated, encoding="utf-8")
    except OSError as error:
        print(f"FAILED to write {effective}: {error}", file=sys.stderr)
        return 1
    print(f"rewrote {effective} -> gateway :{args.gateway_port} ({count} target(s); backup {backup})")

    # Sweep up backups an older build may have dropped inside sites-enabled, even
    # if they do not currently claim the DSH port (they start with the same site
    # name, so they are unambiguously ours to move).
    strays = [
        candidate
        for candidate in sorted(effective.parent.glob(f"{effective.name}.*"))
        if candidate.name != effective.name and is_leftover(candidate)
    ]
    sweep(strays, verbose=False)

    code, output = run_nginx(["-t"])
    if code != 0:
        print("nginx -t failed — restoring the original file", file=sys.stderr)
        print(output, file=sys.stderr)
        if backup.exists():
            effective.write_bytes(backup.read_bytes())
        return 1

    code, output = run_nginx(["-s", "reload"])
    if code != 0:
        print(f"nginx reload failed:\n{output}", file=sys.stderr)
        return 1
    print("nginx reloaded")
    return 0


def reload_nginx() -> int:
    code, output = run_nginx(["-t"])
    if code != 0:
        print(f"nginx -t failed after cleanup:\n{output}", file=sys.stderr)
        return 1
    code, output = run_nginx(["-s", "reload"])
    if code != 0:
        print(f"nginx reload failed:\n{output}", file=sys.stderr)
        return 1
    print("nginx reloaded")
    return 0


def _under(path: Path, directory: Path) -> bool:
    try:
        path.relative_to(directory.resolve())
        return True
    except (ValueError, OSError):
        return False


if __name__ == "__main__":
    sys.exit(main())
