#!/usr/bin/env python3
"""Live e2e for dsh-prompt-commands against a scratch web profile.

Verified against dsh 0.1.5-rc.2.

What it does, end to end:
  1. builds a scratch git project with `.agents/prompts/{hello.md,
     probe-sub.md}` (the per-agent project root);
  2. boots a scratch DSH_HOME web profile (`e2e`) from the shipped template
     with the server cwd at the scratch project, then installs this plugin
     (`dsh plugin add link:`) and restarts;
  3. seeds a workspace at the scratch project into DSH_HOME/storages/
     workspace.json — the web "Add workspace" button uses a host-native
     directory picker that headless Chromium cannot drive, and seeding the
     durable record (shape: packages/workspace/workspace/src/spec.ts
     `workspaceRecord`) is the reproducible equivalent;
  4. drives the web shell with Playwright:
       - the slash popup lists the peff templates (global, via the row
         promptDirs) plus the project templates (agent-scoped);
       - `/hello world` settles a `hello` command row and posts the EXPANDED
         text (`HELLO_FROM_world`) as a user message (inline delivery);
       - `/probe-sub banana` settles "Started — result will arrive as a
         context notice." and the session log gains the started/result
         notices (subagent delivery; the child itself needs an API key to
         complete, which a scratch profile lacks — the failure notice is the
         expected evidence);
       - LIVE discovery: dropping a new template into the project root and
         into the user root (a scratch $DSH_AGENTS_HOME) makes the command
         appear in the slash popup of the OPEN session without any restart,
         and deleting the project file removes it again.

Run from the plugin root:   python3 e2e/e2e-web.py
Scratch state lives in ./.e2e (git-ignored).
"""

import json
import os
import re
import select
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
E2E = ROOT / ".e2e"
HOME = E2E / "home"
PROJ = E2E / "proj"
# Pins the user template root (~/.agents/prompts) to the scratch area so the
# e2e never touches the real user's prompts.
AGENTS_HOME = E2E / "agents"
def _dsh_root():
    """The @deepseek-ai/dsh package root: $DSH_CLI, else the global `dsh` on PATH."""
    env = os.environ.get("DSH_CLI")
    if env:
        return Path(env)
    which = shutil.which("dsh")
    if which:
        return Path(which).resolve().parent.parent  # npm global bin: <pkg>/bin/dsh
    sys.exit("set DSH_CLI to the @deepseek-ai/dsh package root (or put `dsh` on PATH)")


DSH = _dsh_root()
PEFF_PROMPTS = os.environ.get("PEFF_PROMPTS_DIR", "")

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def sh(args, timeout=600, **kw):
    env = dict(os.environ, DSH_HOME=str(HOME), DSH_AGENTS_HOME=str(AGENTS_HOME))
    return subprocess.run(args, env=env, text=True, capture_output=True, timeout=timeout, **kw)


def boot_server(cwd, expect_url=True, extra_args=()):
    env = dict(os.environ, DSH_HOME=str(HOME), DSH_AGENTS_HOME=str(AGENTS_HOME))
    proc = subprocess.Popen(
        ["node", str(DSH / "lib" / "bin.js"), "--profile", "e2e", *extra_args,
         "--port", "0", "--no-open"],
        cwd=str(cwd), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    if not expect_url:
        return proc
    deadline = time.time() + 240
    buf = ""
    url = None
    while time.time() < deadline:
        if proc.poll() is not None:
            rest = proc.stdout.read()
            proc.kill()
            raise RuntimeError(
                f"server exited early before printing a URL (code {proc.returncode}); "
                f"output tail: {buf + rest!r}"[:3000])
        r, _, _ = select.select([proc.stdout], [], [], 0.5)
        if r:
            line = proc.stdout.readline()
            if not line:  # EOF
                proc.kill()
                raise RuntimeError(f"server closed stdout before printing a URL; output: {buf!r}"[:3000])
            buf += line
            m = re.search(r"(http://127\.0\.0\.1:\d+/\?token=\S+)", buf)
            if m:
                url = m.group(1)
                break
    if url is None:
        proc.kill()
        raise RuntimeError("no URL from server boot within deadline")
    return proc, url


def stop_server(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def seed_workspace():
    wid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "unit": {"name": "workspace", "version": 2},
        "global": {"initialized": True, "workspaceIds": [wid], "archivedSessionIds": []},
        "tables": {"workspaces": {wid: {
            "path": str(PROJ), "title": "proj", "sessionIds": [],
            "createdAt": now, "updatedAt": now,
        }}},
    }
    (HOME / "storages").mkdir(parents=True, exist_ok=True)
    (HOME / "storages" / "workspace.json").write_text(json.dumps(doc, indent=2) + "\n")


def dismiss_onboarding(page):
    for _ in range(4):
        clicked = None
        for label in ["Continue", "Configure later", "Later", "Skip"]:
            b = page.get_by_role("button", name=label)
            if b.count() > 0 and b.first.is_visible():
                try:
                    b.first.click(timeout=3000)
                    clicked = label
                    break
                except Exception:
                    pass
        if clicked is None:
            break
        page.wait_for_timeout(1500)


def focus_composer(page):
    ci = page.locator("[data-composer-input]")
    ci.first.click(timeout=5000)
    page.wait_for_timeout(300)
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    page.wait_for_timeout(300)
    return ci


def popup_items(page):
    out = []
    for el in page.locator("[role='listbox'] [role='option'], [role='listbox'] li").all():
        t = (el.inner_text() or "").strip().replace("\n", " | ")
        if t:
            out.append(t.lower())
    return out


def popup_filter(page, prefix):
    """Clear the composer and open the slash popup filtered to /prefix."""
    focus_composer(page)
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    page.keyboard.type("/" + prefix, delay=20)
    page.wait_for_timeout(800)


def popup_has(page, prefix, needle, expect, timeout=15):
    """Poll the slash popup until `needle` is (not) listed, as `expect` says."""
    deadline = time.time() + timeout
    last = []
    present = None
    while time.time() < deadline:
        popup_filter(page, prefix)
        last = popup_items(page)
        present = any(needle in item for item in last)
        if present == expect:
            break
        page.wait_for_timeout(700)
    check(f"live popup {'lists' if expect else 'drops'} /{needle}",
          present == expect, f"popup={last[:12]}")
    return present == expect


def main():
    if E2E.exists():
        shutil.rmtree(E2E)
    (PROJ / ".agents" / "prompts").mkdir(parents=True)

    # scratch git project with two project-root templates
    subprocess.run(["jj", "git", "init"], cwd=PROJ, check=True, capture_output=True)
    (PROJ / ".agents" / "prompts" / "hello.md").write_text(
        "---\ndescription: Greeting probe for e2e\nargument-hint: \"[name]\"\n---\n"
        "Say exactly: HELLO_FROM_$@.\n")
    (PROJ / ".agents" / "prompts" / "probe-sub.md").write_text(
        "---\ndescription: Subagent execution probe for e2e\nargument-hint: \"[topic]\"\n"
        "execution: subagent\n---\nReply with exactly one word: ${@}\n")

    # first boot creates the profile from the shipped web template; wait for
    # the URL (profile ready + deps installed) before stopping it
    proc, _ = boot_server(PROJ, expect_url=True,
                          extra_args=["--from-default-profile", "web"])
    stop_server(proc)

    # install the plugin, seed the workspace, boot for real
    r = sh(["node", str(DSH / "lib" / "bin.js"), "plugin", "--profile", "e2e", "add", f"link:{ROOT}"])
    check("plugin installed into profile",
          "dsh-prompt-commands" in (r.stdout + r.stderr), (r.stdout + r.stderr)[-300:])
    seed_workspace()

    # the shipped row carries no config: point it at the peff template set
    # through the scratch profile's patch layer
    if PEFF_PROMPTS and os.path.isdir(PEFF_PROMPTS):
        patch = HOME / "profiles" / "e2e" / "cordis.patch.yml"
        patch.parent.mkdir(parents=True, exist_ok=True)
        patch.write_text(
            "- id: prompt-commands\n"
            "  config:\n"
            "    promptDirs:\n"
            f"      - {PEFF_PROMPTS}\n")

    # one user-root template (the scratch $DSH_AGENTS_HOME/prompts)
    (AGENTS_HOME / "prompts").mkdir(parents=True, exist_ok=True)
    (AGENTS_HOME / "prompts" / "uglobal.md").write_text(
        "---\ndescription: User-root probe for e2e\n---\nSay exactly: UGLOBAL.\n")

    server, url = boot_server(PROJ)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1500, "height": 950})
            page.goto(url, wait_until="load")
            page.wait_for_timeout(5000)
            dismiss_onboarding(page)

            # ── registration: slash popup ──────────────────────────────────
            page.get_by_text("proj", exact=True).first.wait_for(timeout=10000)
            page.get_by_role("button", name="New session").first.click(timeout=5000)
            page.wait_for_timeout(4000)
            focus_composer(page)
            page.keyboard.type("/")
            page.wait_for_timeout(2000)
            page.screenshot(path=str(E2E / "slash-popup.png"))

            items = []
            for el in page.locator("[role='listbox'] [role='option'], [role='listbox'] li").all():
                t = (el.inner_text() or "").strip().replace("\n", " | ")
                if t:
                    items.append(t)
            joined = " ||| ".join(items).lower()
            check("slash popup: project /hello (agent-scoped .agents/prompts)", "hello" in joined)
            check("slash popup: project /probe-sub", "probe-sub" in joined)
            check("slash popup: user root /uglobal ($DSH_AGENTS_HOME/prompts)", "uglobal" in joined)
            if os.path.isdir(PEFF_PROMPTS):
                check("slash popup: peff /commit (global promptDirs)", "commit" in joined)
                check("slash popup: peff /plan", "plan" in joined)

            # ── inline delivery + expansion ────────────────────────────────
            page.keyboard.press("Escape")
            page.wait_for_timeout(500)
            focus_composer(page)
            page.keyboard.type("/hello world", delay=30)
            page.keyboard.press("Enter")
            page.wait_for_timeout(8000)
            page.screenshot(path=str(E2E / "hello-sent.png"))

            body = page.inner_text("body")
            check("inline: command row 'hello' + 'Completed'",
                  "hello" in body and "Completed" in body)
            check("inline: expanded user message HELLO_FROM_world",
                  "Say exactly: HELLO_FROM_world." in body)

            # ── subagent delivery ──────────────────────────────────────────
            focus_composer(page)
            page.keyboard.type("/probe-sub banana", delay=30)
            page.keyboard.press("Enter")
            page.wait_for_timeout(12000)
            page.screenshot(path=str(E2E / "probe-sub-sent.png"))

            body = page.inner_text("body")
            check("subagent: 'Started — result will arrive as a context notice.'",
                  "Started — result will arrive as a context notice." in body)

            # ── live discovery: no restart, open session ───────────────────
            # New template in the PROJECT root → command appears live.
            (PROJ / ".agents" / "prompts" / "zproj.md").write_text(
                "---\ndescription: Live project probe\n---\nSay exactly: ZPROJ.\n")
            popup_has(page, "z", "zproj", expect=True)

            # New template in the USER root → command appears live.
            (AGENTS_HOME / "prompts" / "zglobal.md").write_text(
                "---\ndescription: Live global probe\n---\nSay exactly: ZGLOBAL.\n")
            popup_has(page, "z", "zglobal", expect=True)

            # Delete the project file → command disappears live.
            (PROJ / ".agents" / "prompts" / "zproj.md").unlink()
            popup_has(page, "z", "zproj", expect=False, timeout=10)

            browser.close()

        # ── session-log evidence: started + result notices ────────────────
        time.sleep(3)
        log_text = ""
        sessions = HOME / "sessions"
        if sessions.exists():
            for f in sessions.rglob("session.v3.jsonl.zstd"):
                try:
                    log_text += subprocess.run(
                        ["zstd", "-dc", str(f)], capture_output=True, text=True).stdout
                except Exception:
                    pass
        check("session log: 'subagent has just started' notice",
              "subagent has just started" in log_text)
        check("session log: result notice (completed or failed path)",
              ("subagent just finished" in log_text) or ("subagent did NOT complete" in log_text)
              or ("subagent failed" in log_text))
    finally:
        stop_server(server)

    print()
    if failures:
        print(f"E2E: {len(failures)} FAILURE(S): {failures}")
        sys.exit(1)
    print("E2E: all checks passed")


if __name__ == "__main__":
    main()
