"""Перевірка supabase/schema.sql на локальному Postgres 16 (pip install pgserver).

    python tests/run_schema_test.py
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile

import pgserver

ROOT = pathlib.Path(__file__).resolve().parent.parent
BIN = pathlib.Path(pgserver.__file__).parent / "pginstall" / "bin"


def main() -> int:
    data = pathlib.Path(tempfile.mkdtemp(prefix="sklad-pg-"))
    srv = pgserver.get_server(data, cleanup_mode="stop")
    try:
        uri = srv.get_uri()
        # кожен прогін — у свіжій базі
        srv.psql("drop database if exists sklad_test;")
        srv.psql("create database sklad_test;")
        uri = uri.rsplit("/", 1)[0] + "/sklad_test"
        psql = str(BIN / ("psql.exe" if sys.platform == "win32" else "psql"))
        steps = [
            ROOT / "tests" / "supabase_stub.sql",
            ROOT / "supabase" / "schema.sql",
            ROOT / "supabase" / "schema.sql",  # повторний запуск має бути безпечним
            ROOT / "tests" / "schema_test.sql",
            ROOT / "tests" / "schema_migrate_test.sql",  # зі старої схеми (без порядку позицій) на нову
        ]
        for f in steps:
            r = subprocess.run([psql, "-q", "-v", "ON_ERROR_STOP=1", "-f", str(f), "-d", uri],
                               capture_output=True, text=True, encoding="utf-8",
                               env={"PGCLIENTENCODING": "UTF8", "SYSTEMROOT": "C:\\Windows"})
            out = (r.stdout + r.stderr).strip()
            print(f"--- {f.relative_to(ROOT)} (exit {r.returncode})")
            if out:
                print(out)
            if r.returncode != 0:
                return 1
        return 0
    finally:
        srv.cleanup()
        shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
