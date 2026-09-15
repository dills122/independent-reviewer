"""Offline characterization probes for reviewd c9c6227, not desired behavior tests."""
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from reviewd import daemon, reviewer
from reviewd.commenter import _check_auto_approve_gates, post_review
from reviewd.models import (
    CLI, AutoApproveConfig, Finding, GlobalConfig, PRInfo, ProjectConfig,
    RepoConfig, ReviewResult, Severity,
)
from reviewd.state import StateDB


class Provider:
    def __init__(self, fail_inline=False, fail_delete=False):
        self.posts = []
        self.approvals = []
        self.fail_inline = fail_inline
        self.fail_delete = fail_delete

    def post_comment(self, repo, pr, body, **kwargs):
        if self.fail_inline and kwargs.get('file_path'):
            raise RuntimeError('injected inline failure')
        self.posts.append(body)
        return len(self.posts) + 100

    def delete_comment(self, *args):
        return not self.fail_delete

    def approve_pr(self, repo, pr):
        self.approvals.append((repo, pr))
        return True


def main():
    expected = 'c9c6227b725fda62db5bba7945b0139d18b2ddae'
    checkout = Path(reviewer.__file__).resolve().parents[2]
    actual = subprocess.run(['git', '-C', str(checkout), 'rev-parse', 'HEAD'],
                            check=True, capture_output=True, text=True, timeout=10).stdout.strip()
    if actual != expected:
        raise RuntimeError(f'Probe requires reviewd {expected}; found {actual}')
    results = {}
    pr = PRInfo('team/repo', 42, 'Change parser', 'fixture', 'feature', 'main',
                'fixture-head', 'https://example.invalid/pr/42')
    repo = RepoConfig('fixture', '/unused', provider='github', repo_slug=pr.repo_slug)
    global_config = GlobalConfig(repos=[repo])
    critical = Finding(Severity.CRITICAL, 'Logic', 'Wrong bound', 'a.py', 1,
                       None, 'UNIQUE_DETAIL_ONLY_IN_INLINE', 'return 2')
    result = ReviewResult('Overview', [critical], 'Review complete', approve=True)
    with tempfile.TemporaryDirectory(prefix='reviewd-lessons-') as temporary:
        root = Path(temporary)
        db_path = root / 'state.db'
        db = StateDB(str(db_path))
        parsed = reviewer.parse_review_result({})
        assert parsed.findings == [] and parsed.summary == ''
        results['missing_fields_accepted'] = True
        assert reviewer.parse_review_result({'approve': 'false'}).approve is True
        results['string_false_becomes_approval'] = True

        provider = Provider(fail_inline=True)
        post_review(provider, db, pr, result, ProjectConfig(), global_config)
        assert len(provider.posts) == 1
        assert 'UNIQUE_DETAIL_ONLY_IN_INLINE' not in provider.posts[0]
        results['failed_inline_detail_absent_from_summary'] = True

        db.record_comment(pr.repo_slug, pr.pr_id, 999)
        provider = Provider(fail_delete=True)
        post_review(provider, db, pr, ReviewResult('', [], ''), ProjectConfig(), global_config)
        assert 999 not in db.get_comment_ids(pr.repo_slug, pr.pr_id)
        results['failed_delete_loses_tracking'] = True

        aa = AutoApproveConfig(enabled=True, max_severity='nitpick', max_diff_lines=50)
        provider = Provider()
        project = ProjectConfig(skip_severities=['critical'], auto_approve=aa)
        post_review(provider, db, pr, result, project, global_config, diff_lines=1)
        assert len(provider.approvals) == 1
        results['filtered_critical_no_longer_blocks_approval'] = True
        clean = ReviewResult('', [], '', approve=True)
        assert _check_auto_approve_gates(aa, clean, None) is None
        assert _check_auto_approve_gates(aa, clean, -1) is None
        results['unknown_diff_size_passes_gate'] = True

        provider = Provider()
        with patch.object(daemon, 'get_provider', return_value=provider), \
             patch.object(daemon, 'review_pr', return_value=clean) as review:
            daemon._shutdown_event.clear()
            daemon._process_pr(pr, repo, ProjectConfig(), global_config, db, dry_run=True)
        assert review.call_count == 1 and provider.posts == []
        assert db.has_review(pr.repo_slug, pr.pr_id, pr.source_commit)
        results['dry_run_invokes_reviewer_and_marks_success'] = True

        db.start_review('team/interrupted', 1, 'head')
        db.close()
        db = StateDB(str(db_path))
        assert db.has_review('team/interrupted', 1, 'head')
        results['in_progress_survives_reopen_and_suppresses_retry'] = True

        startup = PRInfo('team/startup', 7, 'Existing', 'fixture', 'feature', 'main',
                         'initial', 'https://example.invalid/pr/7')
        with patch.object(daemon, '_fetch_repo_prs', return_value=[startup]):
            daemon._boot_summary(global_config, db, review_existing=False)
        assert db.get_review_history('team/startup')[0]['status'] == 'success'
        with patch.object(daemon, '_fetch_repo_prs', return_value=[startup]):
            daemon._boot_summary(global_config, db, review_existing=True)
        assert db.has_review('team/startup', 7, 'initial')
        results['startup_skip_recorded_as_success_even_on_later_review_existing'] = True
        db.close()

        start = time.monotonic()
        output = reviewer.invoke_cli(
            'fixture', str(root), cli=CLI.CLAUDE, timeout=0.05,
            cli_defaults={CLI.CLAUDE: [sys.executable, '-c',
                          "import time; time.sleep(0.3); print('{}')"]},
        )
        elapsed = time.monotonic() - start
        assert output.strip() == '{}' and elapsed >= 0.3
        results['timeout_50ms_child_300ms_returns_success_elapsed_s'] = round(elapsed, 3)

        checkout = root / 'checkout'
        checkout.mkdir()

        def git(*args, cwd=checkout):
            return subprocess.run(['git', *args], cwd=cwd, check=True,
                                  capture_output=True, text=True, timeout=10).stdout.strip()

        git('init', '--initial-branch=main')
        git('config', 'user.name', 'Review fixture')
        git('config', 'user.email', 'fixture@example.invalid')
        source = checkout / 'a.py'
        source.write_text('x = 0\n')
        git('add', 'a.py')
        git('commit', '-m', 'base')
        git('switch', '-c', 'feature')
        source.write_text('x = 1\n')
        git('commit', '-am', 'original PR head')
        old_head = git('rev-parse', 'HEAD')
        source.write_text('x = 2\n')
        git('commit', '-am', 'new PR head')
        new_head = git('rev-parse', 'HEAD')
        git('switch', 'main')
        remote = root / 'remote.git'
        git('clone', '--bare', str(checkout), str(remote))
        git('remote', 'add', 'origin', str(remote))
        moving_pr = PRInfo('team/local', 9, 'Moving head', 'fixture', 'feature',
                           'main', old_head, 'https://example.invalid/pr/9')
        worktree = reviewer.create_worktree(str(checkout), moving_pr)
        try:
            actual = git('rev-parse', 'HEAD', cwd=worktree)
            assert actual == new_head and actual != moving_pr.source_commit
            results['worktree_uses_new_branch_head_instead_of_recorded_commit'] = True
        finally:
            reviewer.cleanup_worktree(str(checkout), moving_pr)
    print('PROBE_RESULTS=' + json.dumps(results, sort_keys=True))


if __name__ == '__main__':
    main()
