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
