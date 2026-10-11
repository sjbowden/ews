#!/usr/bin/env python3

import argparse
import datetime as dt
import gzip
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
DB_PATH = ROOT_DIR / "data" / "ews-main.sqlite"
BACKFILL_SCRIPT = ROOT_DIR / "scripts" / "backfill_history.py"
CHUNK_DAYS = 7


def parse_args():
    parser = argparse.ArgumentParser(
        description="Backfill every complete UTC day since the last backfill, then optionally write a dated backup."
    )
    parser.add_argument("--db", default=str(DB_PATH), help="SQLite database path.")
    parser.add_argument("--start-date", help="Inclusive start date in YYYY-MM-DD. Defaults to the end of the last completed backfill.")
    parser.add_argument(
        "--backup-dir",
        default=os.environ.get("EWS_BACKUP_DIR"),
        help="Directory for a gzipped copy of the database. Defaults to EWS_BACKUP_DIR; skipped when unset.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print the planned date ranges without downloading.")
    return parser.parse_args()


def last_backfilled_end_date(db_path):
    connection = sqlite3.connect(db_path)
    try:
        rows = connection.execute(
            "SELECT details FROM ingestion_runs WHERE run_type = 'historical_backfill' AND status = 'completed'"
        ).fetchall()
    finally:
        connection.close()

    end_dates = [json.loads(row[0])["end_date"] for row in rows if row[0]]
    if not end_dates:
        raise ValueError("No completed backfill found. Run scripts/backfill_history.py first or pass --start-date.")

    return dt.date.fromisoformat(max(end_dates))


def write_backup(db_path, backup_dir):
    backup_dir = pathlib.Path(backup_dir).expanduser()
    backup_dir.mkdir(parents=True, exist_ok=True)
    stem = pathlib.Path(db_path).stem
    destination = backup_dir / f"{stem}_{dt.datetime.now(dt.timezone.utc):%Y%m%d}.sqlite.gz"

    with tempfile.TemporaryDirectory() as temp_dir:
        snapshot_path = pathlib.Path(temp_dir) / "snapshot.sqlite"
        source = sqlite3.connect(db_path)
        snapshot = sqlite3.connect(snapshot_path)
        try:
            source.backup(snapshot)
            integrity = snapshot.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            snapshot.close()
            source.close()

        if integrity != "ok":
            raise RuntimeError(f"Backup snapshot failed its integrity check: {integrity}")

        partial_path = destination.with_name(destination.name + ".partial")
        with open(snapshot_path, "rb") as snapshot_file, gzip.open(partial_path, "wb") as gzip_file:
            shutil.copyfileobj(snapshot_file, gzip_file)
        partial_path.replace(destination)

    return destination


def main():
    args = parse_args()
    start_date = dt.date.fromisoformat(args.start_date) if args.start_date else last_backfilled_end_date(args.db)
    # The end date is exclusive, so today's incomplete UTC day is left for the next run.
    end_date = dt.datetime.now(dt.timezone.utc).date()

    chunk_start = start_date
    while chunk_start < end_date:
        chunk_end = min(chunk_start + dt.timedelta(days=CHUNK_DAYS), end_date)
        print(f"Backfilling {chunk_start.isoformat()}..{chunk_end.isoformat()}", file=sys.stderr)
        if not args.dry_run:
            # Each chunk commits on its own, so an interrupted top-up resumes from the last finished chunk.
            subprocess.run(
                [
                    sys.executable,
                    str(BACKFILL_SCRIPT),
                    "--db",
                    args.db,
                    "--start-date",
                    chunk_start.isoformat(),
                    "--end-date",
                    chunk_end.isoformat(),
                ],
                check=True,
            )
        chunk_start = chunk_end

    backup_path = None
    if args.backup_dir and not args.dry_run:
        backup_path = write_backup(args.db, args.backup_dir)

    print(
        json.dumps(
            {
                "ok": True,
                "dryRun": args.dry_run,
                "startDate": start_date.isoformat(),
                "endDate": end_date.isoformat(),
                "days": max(0, (end_date - start_date).days),
                "backupPath": str(backup_path) if backup_path else None,
            }
        )
    )


if __name__ == "__main__":
    main()
