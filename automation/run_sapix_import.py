"""GitHub Actions entry point. Original files and model intermediates stay private."""
import argparse
import os
import tempfile
from pathlib import Path

from sapix_import import SapixStudio, run_import
from studio_common import StudioError, mask_secret, require

RETRYABLE = {"continue_later", "studio_unavailable", "drive_uncertain", "drive_download", "drive_unavailable",
             "claude_connection", "claude_unavailable", "claude_timeout", "claude_stream"}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--report-failure", action="store_true")
    args = parser.parse_args(argv)
    token = os.environ.get("STUDIO_RUNNER_TOKEN", "")
    mask_secret(token)
    studio = None
    try:
        require(bool(os.environ.get("GITHUB_RUN_ID")), "runner_config", "クラウド実行の識別情報を確認できません。", True)
        studio = SapixStudio(os.environ.get("STUDIO_URL", ""), token, args.job_id)
        if args.report_failure:
            job = studio.job()
            if job.get("status") not in ("queued", "running"):
                return 0
            studio.update(status="running", runId=os.environ["GITHUB_RUN_ID"])
            studio.update(status="failed", stage="failed", retryable=True, error="クラウド実行が中断しました。保存済みの結果から再開してください。")
            return 0
        with tempfile.TemporaryDirectory(prefix="sapix-import-", dir=os.environ.get("RUNNER_TEMP") or None) as folder:
            run_import(studio, Path(folder))
        return 0
    except StudioError as error:
        if error.code in ("cancelled", "runner_conflict"):
            return 0
        if studio is not None:
            try:
                studio.update(status="needs_attention" if error.attention else "failed", stage="failed",
                    error=error.public_message, retryable=error.code in RETRYABLE)
            except StudioError:
                pass
        print("SAPIX import stopped: " + error.code, flush=True)
        return 1
    except Exception:
        if studio is not None:
            try:
                studio.update(status="failed", stage="failed", retryable=False,
                              error="取り込み処理を完了できませんでした。実行設定を確認してください。")
            except StudioError:
                pass
        # Never print a traceback that might contain source content or credentials.
        print("SAPIX import stopped: unexpected_error", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
