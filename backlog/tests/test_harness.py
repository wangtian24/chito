import json
import re
import os
import runpy
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


class HarnessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        old = {k: os.environ.get(k) for k in ("BL_HOME", "BL_DB")}
        self.addCleanup(lambda: [os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
                                 for k, v in old.items()])
        os.environ["BL_HOME"] = self.tmp.name
        os.environ["BL_DB"] = str(Path(self.tmp.name) / "backlog.db")
        self.bl = runpy.run_path(str(Path(__file__).parents[1] / "bin" / "bl"))
        self.c = self.bl["connect"]()
        self.addCleanup(self.c.close)
        for key in ("A", "B"):
            self.c.execute("INSERT INTO projects(key,name,status,executor,created,updated) VALUES(?,?,'executing','daemon','x','x')", (key, key))
            self.c.execute("INSERT INTO tickets(key,project,title,state,created,updated) VALUES(?,?,'task','todo','x','x')", (key + "-1", key))

    def test_command_selection_and_model_defaults(self):
        t = self.c.execute("SELECT * FROM tickets WHERE key='A-1'").fetchone()
        model = self.bl["model_for"](self.c, t)
        self.assertEqual(model, "opus")
        self.assertEqual(self.bl["worker_command"](self.c, t, model, "prompt")[:2], ["claude", "-p"])

        self.c.execute("INSERT INTO settings VALUES('project:A','harness','\"codex\"')")
        self.assertIsNone(self.bl["model_for"](self.c, t))
        self.assertEqual(self.bl["worker_command"](self.c, t, None, "prompt")[:2],
                         ["codex", "exec"])
        self.assertNotIn("--sandbox", self.bl["worker_command"](self.c, t, None, "prompt"))

        self.c.execute("INSERT INTO settings VALUES('global','model','\"gpt-6.1-sol\"')")
        self.assertEqual(self.bl["model_for"](self.c, t), "gpt-6.1-sol")
        self.c.execute("DELETE FROM settings WHERE scope='global' AND key='model'")

        self.c.execute("UPDATE settings SET value='\"pi\"' WHERE scope='project:A' AND key='harness'")
        self.c.execute("INSERT INTO settings VALUES('project:A','model',?)", (json.dumps("together/moonshotai/Kimi-K3"),))
        model = self.bl["model_for"](self.c, t)
        cmd = self.bl["worker_command"](self.c, t, model, "prompt")
        self.assertEqual(cmd[1:7], ["--print", "--approve", "--provider", "together", "--model", model])

    def test_quota_is_project_scoped(self):
        self.bl["note_quota"](self.c, "A-1", "status 429 too many requests", "test")
        self.assertIsNotNone(self.bl["quota_until"](self.c, "A"))
        self.assertIsNone(self.bl["quota_until"](self.c, "B"))
        self.assertEqual([t["key"] for t in self.bl["ready"](self.c, mode="daemon")], ["B-1"])
        self.bl["note_quota"](self.c, None, "status 429 too many requests", "test", project="B")
        self.assertIsNone(self.bl["quota_until"](self.c))

    def test_pi_worker_reports_to_backlog(self):
        fake = Path(self.tmp.name) / "pi"
        fake.write_text('#!/bin/sh\nbl done "$BL_TICKET" -m "fake worker complete" --final\n')
        fake.chmod(0o755)
        self.c.execute("INSERT INTO settings VALUES('project:A','harness','\"pi\"')")
        self.c.execute("INSERT INTO settings VALUES('project:A','model',?)", (json.dumps("together/moonshotai/Kimi-K3"),))
        self.c.execute("UPDATE tickets SET state='in_progress', claimed_by='test-agent', attempts=1 WHERE key='A-1'")
        t = self.c.execute("SELECT * FROM tickets WHERE key='A-1'").fetchone()
        with patch.dict(os.environ, {"PATH": self.tmp.name + ":" + os.environ["PATH"], "BL_DAEMON": "1"}):
            proc, log = self.bl["spawn_worker"](self.c, t, "test-agent", "test")
            self.assertEqual(proc.wait(timeout=10), 0)
            log.close()
        self.assertEqual(self.c.execute("SELECT state FROM tickets WHERE key='A-1'").fetchone()[0], "done")
        spawn = self.c.execute("SELECT data FROM events WHERE ticket='A-1' AND kind='spawn'").fetchone()
        self.assertEqual(json.loads(spawn[0])["harness"], "pi")

    def test_session_messages_reach_hooks_once_with_key(self):
        import io, contextlib
        from types import SimpleNamespace as NS
        sid = "11111111-2222-3333-4444-555555555555"
        def run(**kw):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf), patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": "", "BL_TICKET": ""}):
                self.bl["cmd_msg"](NS(json=False, ticket=None, limit=50, **kw))
        run(action="send", target=sid, text=["use", "red"])
        def hook(ev):
            buf = io.StringIO()
            with patch("sys.stdin", io.StringIO(json.dumps({"session_id": sid}))), contextlib.redirect_stdout(buf):
                self.bl["cmd_hook"](NS(event=ev))
            return buf.getvalue()
        key = self.bl["msg_key"](sid)
        self.assertIn(key, hook("session-start"))
        first = json.loads(hook("beat"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("use red", first); self.assertIn(f"key {key}", first); self.assertIn("bl msg reply 1", first)
        self.assertEqual(hook("beat").strip(), "")          # delivered once
        run(action="send", target=sid, text=["sub"])
        buf = io.StringIO()
        with patch("sys.stdin", io.StringIO(json.dumps({"session_id": sid, "agent_id": "x"}))), contextlib.redirect_stdout(buf):
            self.bl["cmd_hook"](NS(event="beat"))
        self.assertEqual(buf.getvalue().strip(), "")       # a subagent's tool call doesn't take it
        self.assertNotEqual(key, self.bl["msg_key"]("99999999-2222-3333-4444-555555555555"))
        self.assertEqual(json.loads(hook("stop"))["decision"], "block")  # the main thread still gets it  # a stopping session still gets it
        run(action="reply", target="1", text=["done"])
        rows = self.c.execute("SELECT dir, reply_to, body FROM messages ORDER BY id").fetchall()
        self.assertEqual([tuple(r) for r in rows][-1], ("out", 1, "done"))

if __name__ == "__main__":
    unittest.main()


class TldrAndRepoScopeTest(HarnessTest):
    def test_tldr_rule(self):
        ok = self.bl["tldr_problem"]
        self.assertIsNone(ok("Approve PR #12. It adds grid references."))
        self.assertIsNotNone(ok("One. Two. Three. Four."))
        self.assertIsNone(ok("Pick a price:\n- Pro $24.99/yr\n- Founder $49.99\n- Free tier stays"))
        self.assertIsNotNone(ok("\n".join(f"- item {i}" for i in range(8))))
        self.assertIsNotNone(ok(""))

    def test_done_and_fail_store_tldr(self):
        os.environ.pop("BL_AGENT", None)
        self.c.execute("UPDATE tickets SET state='in_progress' WHERE key='A-1'")
        self.c.commit()
        ns = lambda **kw: type("A", (), {"key": "A-1", "message": "long result", "tldr": None, "force": True, "final": True, **kw})()
        self.bl["cmd_fail"](ns(tldr="Build broke on Safari. Retry after the fix."))
        meta = json.loads(self.c.execute("SELECT meta FROM tickets WHERE key='A-1'").fetchone()["meta"])
        self.assertEqual(meta["tldr"]["text"], "Build broke on Safari. Retry after the fix.")
        with self.assertRaises(SystemExit):
            self.bl["cmd_fail"](ns(tldr="One. Two. Three. Four."))

    def test_repo_scope_setting(self):
        self.c.execute("UPDATE projects SET repo='/r/map' WHERE key='A'")
        self.c.execute("INSERT INTO settings VALUES('repo:/r/map','review','\"self\"')")
        self.assertEqual(self.bl["setting"](self.c, "review", "A"), "self")
        self.c.execute("INSERT INTO settings VALUES('project:A','review','\"pr\"')")
        self.assertEqual(self.bl["setting"](self.c, "review", "A"), "pr")
        self.assertNotEqual(self.bl["setting"](self.c, "review", "B"), "self")

    def test_tldr_edge_shapes(self):
        ok = self.bl["tldr_problem"]
        self.assertIsNotNone(ok("A. B. C. D. E. F.\n- ok"))
        self.assertIsNone(ok(["first", "second"]))
        self.assertIsNotNone(ok(None))

    def test_tldr_backfill_retries_once(self):
        self.c.execute("UPDATE tickets SET assignee='human', result='r' WHERE key='A-1'")
        upd = self.c.execute("SELECT updated FROM tickets WHERE key='A-1'").fetchone()["updated"]
        meta = {"tldr_try": {"updated": upd, "tries": 1, "error": "too long"}}
        self.c.execute("UPDATE tickets SET meta=? WHERE key='A-1'", (json.dumps(meta),))
        self.assertIn("A-1", [t["key"] for t, _ in self.bl["waiting_without_tldr"](self.c)])
        t = self.c.execute("SELECT * FROM tickets WHERE key='A-1'").fetchone()
        self.assertIn("rejected (too long)", self.bl["tldr_prompt"](t, None))
        meta["tldr_try"]["tries"] = 2
        self.c.execute("UPDATE tickets SET meta=? WHERE key='A-1'", (json.dumps(meta),))
        self.assertNotIn("A-1", [t["key"] for t, _ in self.bl["waiting_without_tldr"](self.c)])

    def _gh(self, state):
        from types import SimpleNamespace
        return patch("subprocess.run", return_value=SimpleNamespace(returncode=0, stdout=state + "\n"))

    def _state(self):
        return self.c.execute("SELECT state FROM tickets WHERE key='A-1'").fetchone()["state"]

    def test_done_waits_for_pr_merge(self):
        from argparse import Namespace
        url = "PR https://github.com/o/r/pull/7 open"
        self.c.execute("UPDATE tickets SET state='in_review', result=? WHERE key='A-1'", (url,))
        approve = Namespace(key="A-1", state="done", reset=False, reason="from chito", force_merge=False)
        with self._gh("OPEN"), self.assertRaises(SystemExit):
            self.bl["cmd_move"](approve)
        self.assertEqual(self._state(), "in_review")
        with self._gh("OPEN"):   # worker's bl done on an in_review ticket stays with the human
            self.bl["cmd_done"](Namespace(key="A-1", message=None, tldr=None, force=False, final=True, force_merge=False))
        self.assertEqual(self._state(), "in_review")
        with self._gh("MERGED"):
            self.bl["cmd_move"](approve)
        self.assertEqual(self._state(), "done")

    def test_done_without_pr_or_forced(self):
        from argparse import Namespace
        self.c.execute("UPDATE tickets SET state='in_review', result='no PR, a doc' WHERE key='A-1'")
        self.bl["cmd_move"](Namespace(key="A-1", state="done", reset=False, reason=None, force_merge=False))
        self.assertEqual(self._state(), "done")
        self.c.execute("UPDATE tickets SET state='in_review', result='https://github.com/o/r/pull/8' WHERE key='A-1'")
        with self._gh("CLOSED"):
            self.bl["cmd_move"](Namespace(key="A-1", state="done", reset=False, reason=None, force_merge=True))
        self.assertEqual(self._state(), "done")

    def test_prompt_shows_project_now(self):
        c = self.c
        c.execute("INSERT INTO tickets(key,project,title,state,created,updated,started) VALUES('A-2','A','sibling work','in_progress','x','x','x')")
        c.execute("INSERT INTO tickets(key,project,title,state,result,created,updated,finished) VALUES('A-3','A','landed','done','PR #9 merged\nmore','x','x','y')")
        c.execute("INSERT INTO tickets(key,project,title,state,created,updated,started) VALUES('B-2','B','other project','in_progress','x','x','x')")
        t = c.execute("SELECT * FROM tickets WHERE key='A-1'").fetchone()
        p = self.bl["build_prompt"](c, t)
        self.assertIn("## Project area: A", p)
        self.assertIn("- A-2 sibling work", p)
        self.assertIn("- A-3 landed: PR #9 merged", p)
        self.assertNotIn("B-2", p)
        self.assertNotIn("more", p.split("## Project area: A")[1].split("## Protocol")[0])

    def test_project_area_notes(self):
        c, bl = self.c, self.bl
        c.execute("INSERT INTO tickets(key,project,title,state,created,updated,started) VALUES('A-2','A','sibling','in_progress','x','x','x')")
        ns = lambda **k: type("A", (), k)
        bl["add_note"](ns(target="A-2", text=["render.js", "drawRiver"]), "touching")
        bl["add_note"](ns(target="A-2", text=["render.js only"]), "touching")
        bl["add_note"](ns(target="A", text=["Generate groups are land, terrain, type"]), "memory")
        bl["add_note"](ns(target="A-2", text=["renamed GROUPS.roads"]), "msg")
        bl["add_note"](ns(target="B", text=["other project fact"]), "memory")
        p = bl["build_prompt"](c, c.execute("SELECT * FROM tickets WHERE key='A-1'").fetchone())
        self.assertIn("Generate groups are land, terrain, type", p)
        self.assertIn("renamed GROUPS.roads", p)
        self.assertIn("- A-2 sibling · touching: render.js only", p)
        self.assertNotIn("drawRiver", p)
        self.assertNotIn("other project fact", p)
        c.execute("UPDATE tickets SET state='done' WHERE key='A-2'")
        self.assertEqual(bl["touching_of"](c, "A"), {})
        mid = c.execute("SELECT id FROM notes WHERE kind='memory' AND project='A'").fetchone()[0]
        bl["cmd_forget"](ns(id=mid))
        p = bl["build_prompt"](c, c.execute("SELECT * FROM tickets WHERE key='A-1'").fetchone())
        self.assertNotIn("Generate groups", p)
        self.assertIn("bl area A", bl["worker_instruction"](c.execute("SELECT * FROM tickets WHERE key='A-1'").fetchone()))

    def test_stop_project_work_releases_held_tickets(self):
        c, bl = self.c, self.bl
        c.execute("UPDATE tickets SET state='in_progress', claimed_by='orchs:A:1', attempts=1 WHERE key='A-1'")
        c.execute("INSERT INTO tickets(key,project,title,state,claimed_by,attempts,created,updated) VALUES('A-2','A','w','in_progress','daemon:9:1',1,'x','x')")
        c.execute("INSERT INTO tickets(key,project,title,state,claimed_by,created,updated) VALUES('A-3','A','me','in_progress','cc:abcd','x','x')")
        with patch.dict(bl["stop_project_work"].__globals__, project_processes=lambda *a, **k: []):
            n, rel = bl["stop_project_work"](c, "A", "switched", orchestrators_only=True)
            self.assertEqual(rel, ["A-1"])
            n, rel = bl["stop_project_work"](c, "A", "paused")
            self.assertEqual(rel, ["A-2"])
        st = dict(c.execute("SELECT key, state FROM tickets WHERE project='A'").fetchall())
        self.assertEqual(st, {"A-1": "todo", "A-2": "todo", "A-3": "in_progress"})
        self.assertEqual(c.execute("SELECT attempts FROM tickets WHERE key='A-2'").fetchone()[0], 0)

    def test_red_main_banner_and_guard(self):
        c, bl = self.c, self.bl
        c.execute("UPDATE projects SET repo='/tmp/r' WHERE key='A'")
        repo = str(Path("/tmp/r").resolve())
        h = {"state": "red", "red_sha": "a" * 40, "green_sha": "b" * 40, "suites": "e2e:ux", "ticket": "A-9", "since": "x"}
        c.execute("INSERT INTO settings VALUES(?,?,?)", (f"repo:{repo}", "main_health", json.dumps(h)))
        p = bl["build_prompt"](c, c.execute("SELECT * FROM tickets WHERE key='A-1'").fetchone())
        self.assertIn("MAIN IS RED", p)
        self.assertIn("git rebase bbbbbbbbb", p)
        g = bl["pre_tool_guard"]
        with patch.dict(os.environ, {"BL_TICKET": "A-1"}):
            self.assertTrue(g(c, {"tool_name": "Bash", "tool_input": {"command": "gh pr merge 3 --squash"}}))
            self.assertTrue(g(c, {"tool_name": "Bash", "tool_input": {"command": "git pull --rebase origin main"}}))
            self.assertIsNone(g(c, {"tool_name": "Bash", "tool_input": {"command": "git rebase bbbbbbb"}}))
            self.assertIsNone(g(c, {"tool_name": "Bash", "tool_input": {"command": "npm test"}}))
        with patch.dict(os.environ, {"BL_TICKET": "A-9"}):
            self.assertIsNone(g(c, {"tool_name": "Bash", "tool_input": {"command": "gh pr merge 3"}}))
        c.execute("UPDATE settings SET value=? WHERE key='main_health'", (json.dumps({"state": "green", "green_sha": "c"}),))
        with patch.dict(os.environ, {"BL_TICKET": "A-1"}):
            self.assertIsNone(g(c, {"tool_name": "Bash", "tool_input": {"command": "gh pr merge 3"}}))

    def test_reclaim_resumes_previous_session(self):
        c, bl = self.c, self.bl
        wt = Path(self.tmp.name) / "wt"; wt.mkdir()
        home = Path(self.tmp.name) / "home"
        slug = re.sub(r"[^A-Za-z0-9]", "-", str(wt.resolve()))
        (home / ".claude" / "projects" / slug).mkdir(parents=True)
        (home / ".claude" / "projects" / slug / "sid-1.jsonl").write_text("{}")
        ins = "INSERT INTO events(ticket,project,kind,actor,body,at,session_id) VALUES('A-1','A',?,?,?,?,?)"
        c.execute(ins, ("claim", "daemon:1:1", "claimed", "1", None))
        c.execute(ins, ("note", "daemon:1:1", "touching x", "2", "sid-1"))
        c.execute(ins, ("state", "user:me", "in_progress → todo: project paused", "3", None))
        c.execute(ins, ("claim", "daemon:1:2", "claimed", "4", None))
        t = c.execute("SELECT * FROM tickets WHERE key='A-1'").fetchone()
        with patch.dict(os.environ, {"HOME": str(home)}):
            sid, why = bl["previous_session"](c, t, str(wt))
            self.assertEqual(sid, "sid-1")
            self.assertIn("project paused", why)
            (home / ".claude" / "projects" / slug / "sid-1.jsonl").unlink()
            self.assertEqual(bl["previous_session"](c, t, str(wt)), (None, None))
        self.assertIn("resuming backlog ticket A-1", bl["resume_prompt"](t, why))

    def test_speculation_ready_done_and_unstage(self):
        c, bl = self.c, self.bl
        c.execute("INSERT INTO tickets(key,project,title,state,created,updated) VALUES('A-2','A','follower','todo','x','x')")
        c.execute("INSERT INTO deps(ticket,blocker) VALUES('A-2','A-1')")
        c.execute("UPDATE tickets SET state='in_progress', claimed_by='w1', meta=? WHERE key='A-1'",
                  (json.dumps({"staged": {"branch": "feat-a"}}),))
        keys = lambda: [t["key"] for t in bl["ready"](c, "A")]
        self.assertEqual(keys(), [])                       # speculate off: a staged blocker still blocks
        c.execute("INSERT INTO settings VALUES('project:A','speculate','true')")
        self.assertEqual(keys(), ["A-2"])                  # speculate on: the follower may start
        c.execute("UPDATE tickets SET title='Deploy A to production' WHERE key='A-2'")
        self.assertEqual(keys(), [])                       # deploys never start speculatively
        c.execute("UPDATE tickets SET title='follower', meta=? WHERE key='A-2'", (json.dumps({"speculate": False}),))
        self.assertEqual(keys(), [])                       # nor tickets that opt out
        c.execute("UPDATE tickets SET meta='{}' WHERE key='A-2'")
        self.assertEqual(bl["speculative_bases"](c, "A-2"), [("A-1", "feat-a", None)])
        self.assertIn("blocked by unfinished A-1", bl["blockers_unfinished_reason"](c, "A-2"))
        with patch.dict(os.environ, {"BL_TICKET": "A-2"}):
            self.assertTrue(bl["pre_tool_guard"](c, {"tool_name": "Bash", "tool_input": {"command": "gh pr merge 5"}}))
        c.execute("UPDATE tickets SET state='in_progress', claimed_by='w2' WHERE key='A-2'")
        bl["release_ticket"](c, c.execute("SELECT * FROM tickets WHERE key='A-1'").fetchone(), "tests failed")
        self.assertNotIn("staged", json.loads(c.execute("SELECT meta FROM tickets WHERE key='A-1'").fetchone()[0]))
        self.assertTrue(c.execute("SELECT 1 FROM events WHERE ticket='A-2' AND body LIKE '%went back%'").fetchone())
        c.execute("UPDATE tickets SET state='done' WHERE key='A-1'")
        self.assertIsNone(bl["blockers_unfinished_reason"](c, "A-2"))

    def test_park_waits_for_blockers_then_resumes(self):
        c, bl = self.c, self.bl
        c.execute("INSERT INTO tickets(key,project,title,state,created,updated) VALUES('A-2','A','follower','in_progress','x','x')")
        c.execute("UPDATE tickets SET claimed_by='w2' WHERE key='A-2'")
        c.execute("INSERT INTO deps(ticket,blocker) VALUES('A-2','A-1')")
        c.execute("UPDATE tickets SET state='in_progress', claimed_by='w1' WHERE key='A-1'")
        ns = lambda **k: type("A", (), {"force": False, "until": None, "pr": "https://x/pr/2", **k})
        with patch.dict(os.environ, {"BL_AGENT": "w2"}):
            bl["cmd_park"](ns(key="A-2"))
        t2 = c.execute("SELECT * FROM tickets WHERE key='A-2'").fetchone()
        self.assertEqual(t2["state"], "todo")
        self.assertEqual(bl["park_waiting"](c, t2), "blockers")
        c.execute("UPDATE tickets SET meta=json_set(meta,'$.staged',json('{\"branch\":\"f\"}')) WHERE key='A-2'")
        bl["cmd_park"].__globals__["release_ticket"](c, c.execute("SELECT * FROM tickets WHERE key='A-2'").fetchone(), "parked: x", keep_staged=True)
        self.assertIn("staged", json.loads(c.execute("SELECT meta FROM tickets WHERE key='A-2'").fetchone()[0]))
        self.assertNotIn("A-2", [t["key"] for t in bl["ready"](c, "A")])
        c.execute("INSERT INTO settings VALUES('project:A','speculate','true')")
        c.execute("UPDATE tickets SET meta=? WHERE key='A-1'", (json.dumps({"staged": {"branch": "b"}}),))
        self.assertNotIn("A-2", [t["key"] for t in bl["ready"](c, "A")])   # parked: speculation doesn't wake it
        c.execute("UPDATE tickets SET state='done' WHERE key='A-1'")
        self.assertIn("A-2", [t["key"] for t in bl["ready"](c, "A")])
        self.assertIn("rebase your branch onto origin/main", bl["resume_prompt"](t2, "in_progress → todo: parked: PR ready"))

    def test_project_cap_unlimited_by_default(self):
        self.assertIsNone(self.bl["project_cap"](self.c, "A"))
        self.c.execute("INSERT INTO settings VALUES('project:A','max_parallel','2')")
        self.assertEqual(self.bl["project_cap"](self.c, "A"), 2)
        self.c.execute("UPDATE settings SET value='0' WHERE scope='project:A' AND key='max_parallel'")
        self.assertIsNone(self.bl["project_cap"](self.c, "A"))
