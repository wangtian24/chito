import json
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
