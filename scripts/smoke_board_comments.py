#!/usr/bin/env python3
"""Exercise comments/responses against disposable local D1. Refuses remote hosts."""
import argparse
import json
import os
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8791')
    args = parser.parse_args()
    url = urlsplit(args.base_url)
    if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('use only a disposable local Wrangler server over HTTP')
    base = args.base_url.rstrip('/')
    token = os.environ.get('BOARD_TEST_ADMIN_TOKEN', 'local-roadmap-qa')

    def api(path, body=None, *, admin=False):
        headers = {'content-type': 'application/json'}
        if admin:
            headers['authorization'] = 'Bearer ' + token
        request = Request(base + path, headers=headers,
                          data=json.dumps(body).encode() if body is not None else None)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def ok(path, body=None, *, admin=False):
        status, result = api(path, body, admin=admin)
        assert status == 200, (path, status, result)
        return result

    assert ok('/api/board')['siteKey'] is None, 'disable Turnstile locally for this smoke'
    title = 'Discuss roadmap requests ' + uuid4().hex[:8]
    ok('/api/board/submit', {'title': title, 'detail': 'Local comments and pinned response QA.'})
    feature = next(f for f in ok('/api/board/admin', admin=True)['features'] if f['title'] == title)
    feature_id = feature['id']
    comments_path = '/api/board/comments?id=' + str(feature_id)

    def act(action, **fields):
        return ok('/api/board/admin', {'id': feature_id, 'action': action, **fields}, admin=True)

    assert api(comments_path)[0] == 404, 'pending feature discussion must stay private'
    act('approve')
    assert ok(comments_path)['comments'] == []
    visitor_body = 'Could this support weekends too? <script>alert("literal text")</script>'
    assert ok('/api/board/comments', {'id': feature_id, 'body': visitor_body, 'website': ''})['queued']
    assert ok(comments_path)['comments'] == [], 'unapproved comments must stay private'
    private = ok(comments_path, admin=True)['comments']
    assert len(private) == 1 and private[0]['status'] == 'pending'
    assert private[0]['author'] == 'visitor' and private[0]['body'] == visitor_body
    assert 'ip_hash' not in private[0]
    visitor_id = private[0]['id']
    admin_feature = next(f for f in ok('/api/board/admin', admin=True)['features'] if f['id'] == feature_id)
    assert [admin_feature['commentCount'], admin_feature['pendingCommentCount']] == [0, 1]
    act('approve_comment', commentId=visitor_id)
    act('comment', body='Yes, weekend scheduling is part of this request.')
    comments = ok(comments_path)['comments']
    assert [c['author'] for c in comments] == ['visitor', 'maintainer']
    assert comments[0]['body'] == visitor_body
    assert ok(comments_path + '&after=' + str(visitor_id))['comments'][0]['id'] == comments[1]['id']
    assert api('/api/board/admin', {'id': feature_id, 'action': 'respond', 'body': 'Unauthorized'})[0] == 401
    response_body = 'Planned: choose a day and time for each request.\nWe will post progress here.'
    act('respond', body=response_body)
    public_feature = next(f for f in ok('/api/board')['features'] if f['id'] == feature_id)
    assert public_feature['maintainerResponse'] == response_body and public_feature['responseUpdatedAt']
    assert public_feature['commentCount'] == 2
    assert len(ok(comments_path)['comments']) == 2, 'response must not become a comment'
    act('respond', body='')
    public_feature = next(f for f in ok('/api/board')['features'] if f['id'] == feature_id)
    assert public_feature['maintainerResponse'] == ''
    assert len(ok(comments_path)['comments']) == 2
    act('shipped')
    assert ok('/api/board/comments', {'id': feature_id, 'body': 'Thanks for shipping this!'})['queued']
    pending = next(c for c in ok(comments_path, admin=True)['comments'] if c['status'] == 'pending')
    act('delete_comment', commentId=pending['id'])
    act('open')
    act('respond', body=response_body)

    # Optional GitHub issue association is independent of discussion content.
    issue_url = 'https://github.com/windoze95/cantinarr/issues/677'
    assert act('link_issue', url=issue_url + '#issuecomment-123')['githubIssueUrl'] == issue_url
    public_feature = next(f for f in ok('/api/board')['features'] if f['id'] == feature_id)
    assert public_feature['githubIssueUrl'] == issue_url
    admin_feature = next(f for f in ok('/api/board/admin', admin=True)['features'] if f['id'] == feature_id)
    assert admin_feature['githubIssueUrl'] == issue_url
    assert api('/api/board/admin', {'id': feature_id, 'action': 'link_issue', 'url': issue_url})[0] == 401
    assert api('/api/board/admin', {'id': feature_id, 'action': 'link_issue', 'url': 'javascript:alert(1)'}, admin=True)[0] == 400
    act('link_issue', url='https://github.com/windoze95/cantinarr/issues/676')
    assert next(f for f in ok('/api/board')['features'] if f['id'] == feature_id)['githubIssueUrl'].endswith('/676')
    act('link_issue', url='')
    assert next(f for f in ok('/api/board')['features'] if f['id'] == feature_id)['githubIssueUrl'] == ''
    act('link_issue', url=issue_url)
    assert len(ok(comments_path)['comments']) == 2

    # Delete a separate feature containing both comment and response fixtures.
    delete_title = 'Disposable discussion ' + uuid4().hex[:8]
    ok('/api/board/submit', {'title': delete_title})
    delete_id = next(f['id'] for f in ok('/api/board/admin', admin=True)['features'] if f['title'] == delete_title)
    for action, fields in [('comment', {'body': 'Temporary comment'}), ('respond', {'body': 'Temporary response'}), ('link_issue', {'url': issue_url}), ('delete', {})]:
        ok('/api/board/admin', {'id': delete_id, 'action': action, **fields}, admin=True)
    assert api('/api/board/comments?id=' + str(delete_id), admin=True)[0] == 404
    print(f'Local D1 comments smoke passed: private pending comments, moderation, maintainer comments, '
          f'pinned response save/clear, GitHub issue links, cursor reads, shipped comments, auth and deletion. Fixture #{feature_id}.')


if __name__ == '__main__':
    main()
