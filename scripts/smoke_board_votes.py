#!/usr/bin/env python3
"""Exercise voting against disposable Wrangler D1. Refuses non-loopback hosts."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from http.cookiejar import CookieJar
import json
import os
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPCookieProcessor
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8791')
    args = parser.parse_args()
    url = urlsplit(args.base_url)
    if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('use only a disposable local Wrangler server over HTTP')
    base = args.base_url.rstrip('/')
    admin_token = os.environ.get('BOARD_TEST_ADMIN_TOKEN', 'local-roadmap-qa')
    opener = build_opener(HTTPCookieProcessor(CookieJar()))

    def api(path, body=None, *, admin=False, client=opener):
        headers = {'content-type': 'application/json'}
        if admin:
            headers['authorization'] = 'Bearer ' + admin_token
        request = Request(base + path, headers=headers,
                          data=json.dumps(body).encode() if body is not None else None)
        try:
            response = client.open(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def cast(vote, client=opener):
        return api('/api/board/vote', {'id': idea_id, 'vote': vote}, client=client)

    def check(result, up, down, vote):
        status, body = result
        assert status == 200, result
        assert [body['upvotes'], body['downvotes'], body['vote']] == [up, down, vote], body
        assert body['votes'] == up and body['voted'] == (vote == 'up'), body

    status, board = api('/api/board')
    assert status == 200 and board['siteKey'] is None, 'disable Turnstile locally for this smoke'
    title = 'Schedule media requests for the weekend ' + uuid4().hex[:8]
    status, submitted = api('/api/board/submit', {'title': title, 'detail': 'Choose when a queued request should be sent. Local QA fixture.'})
    assert status == 200, submitted
    status, admin_board = api('/api/board/admin', admin=True)
    assert status == 200, admin_board
    idea = next(f for f in admin_board['features'] if f['title'] == title)
    idea_id = idea['id']
    assert idea['status'] == 'pending'
    assert all(f['id'] != idea_id for f in api('/api/board')[1]['features'])
    assert api('/api/board/vote', {'id': idea_id, 'vote': 'down'})[0] == 404
    assert api('/api/board/admin', {'id': idea_id, 'action': 'approve'}, admin=True)[0] == 200
    check(cast('up'), 1, 0, 'up')
    check(cast('up'), 1, 0, 'up')
    check(cast('down'), 0, 1, 'down')
    check(cast('down'), 0, 1, 'down')
    item = next(f for f in api('/api/board')[1]['features'] if f['id'] == idea_id)
    assert [item['upvotes'], item['downvotes'], item['vote']] == [0, 1, 'down']
    check(cast(None), 0, 0, None)
    check(cast(None), 0, 0, None)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for result in pool.map(cast, ['up'] * 8):
            check(result, 1, 0, 'up')
    second = build_opener(HTTPCookieProcessor(CookieJar()))
    assert api('/api/board', client=second)[0] == 200
    check(cast('down', second), 1, 1, 'down')
    check(cast('down'), 0, 2, 'down')
    admin_item = next(f for f in api('/api/board/admin', admin=True)[1]['features'] if f['id'] == idea_id)
    assert [admin_item['upvotes'], admin_item['downvotes']] == [0, 2]
    assert api('/api/board/admin')[0] == 401
    assert api('/api/board/admin', {'id': idea_id, 'action': 'shipped'}, admin=True)[0] == 200
    assert cast(None)[0] == 404
    assert api('/api/board/admin', {'id': idea_id, 'action': 'open'}, admin=True)[0] == 200
    # Leave the fixture open with distinct nonzero totals for visual QA.
    check(cast('up'), 1, 1, 'up')
    print(f'Local D1 smoke passed: submission/moderation, retries, concurrent requests, switching/removal, cookie reload, separate public/admin totals, shipped lock. Fixture #{idea_id}: 1 up, 1 down.')


if __name__ == '__main__':
    main()
