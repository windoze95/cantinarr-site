#!/usr/bin/env python3
"""Select only the current Cantinarr main commit, with exact-SHA green CI."""
import argparse
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

REPOSITORY = 'windoze95/cantinarr'
PROJECT = 'cantinarr-docs'


def request(url, token):
    headers = {'Accept': 'application/json', 'User-Agent': 'cantinarr-docs-publisher'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
        return json.load(response)


def github(path):
    return request('https://api.github.com/repos/' + REPOSITORY + '/' + path, os.environ.get('GH_TOKEN'))


def verified_sha(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{40}', value):
        raise ValueError('GitHub did not return a full commit SHA.')
    return value


def has_green_ci(sha, runs):
    # Head SHA is the tested checkout for main push runs. PR merge previews
    # and workflow_dispatch runs cannot stand in for that evidence.
    return any(run.get('head_sha') == sha and run.get('head_branch') == 'main'
               and run.get('event') == 'push' and run.get('name') == 'CI'
               and run.get('status') == 'completed' and run.get('conclusion') == 'success'
               and run.get('head_repository', {}).get('full_name') == REPOSITORY
               for run in runs)


def already_published(sha, project):
    deployment = project.get('canonical_deployment') or {}
    return (deployment.get('environment') == 'production'
            and deployment.get('latest_stage', {}).get('status') == 'success'
            and deployment.get('deployment_trigger', {}).get('metadata', {}).get('commit_hash') == sha)


def output(**values):
    file = os.environ.get('GITHUB_OUTPUT')
    if file:
        with Path(file).open('a') as stream:
            for key, value in values.items():
                stream.write(f'{key}={value}\n')
    print(json.dumps(values))


def select(expected=None):
    sha = verified_sha(github('commits/main')['sha'])
    if expected and sha != verified_sha(expected):
        output(ready='false', reason='Main changed during the build. The next run will publish it.')
        return
    runs = github(f'actions/workflows/ci.yml/runs?head_sha={sha}&branch=main&event=push&per_page=100')
    if not has_green_ci(sha, runs['workflow_runs']):
        output(ready='false', reason='Waiting for successful CI for current main.', sha=sha)
        return
    try:
        github(f'contents/docs-site/package-lock.json?ref={sha}')
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        output(ready='false', reason='Documentation source is not on main yet.', sha=sha)
        return
    account = os.environ['CLOUDFLARE_ACCOUNT_ID']
    project = request(f'https://api.cloudflare.com/client/v4/accounts/{account}/pages/projects/{PROJECT}',
                      os.environ['CLOUDFLARE_API_TOKEN'])
    if not project.get('success'):
        raise RuntimeError('Cloudflare could not read the documentation project.')
    if already_published(sha, project['result']):
        output(ready='false', reason='Current main is already published.', sha=sha)
        return
    output(ready='true', sha=sha)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-sha', help='Recheck the selected SHA immediately before publication.')
    args = parser.parse_args()
    try:
        select(args.expected_sha)
    except (urllib.error.URLError, KeyError, ValueError, RuntimeError) as error:
        # Do not print response bodies, request headers, or credential values.
        raise SystemExit(f'Documentation publication selection failed: {type(error).__name__}')
