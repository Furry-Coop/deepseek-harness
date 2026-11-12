"""Project the step-less opening turn and its late wake through the Python SDK.

The scenario patch owns the model boundary and holds the first pre-step, so this
drives the real loop twice through public prompts, waits for the session to go
idle, and compares the wire projection with the durable session log.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
BINARY = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
SCENARIO = ROOT / 'snapshots' / 'sdk' / 'first-step-wake'
PATCH = SCENARIO / 'cordis.yml'
SESSION_ID = 'fixture-root-session'


class _EmptyResponse(BaseModel):
    pass


def _fixture_version(name: str) -> int:
    match = re.fullmatch(r'session(?:\.v([1-9]\d*))?\.jsonl', name)
    return int(match.group(1) or 0) if match is not None else -1


def scenario_fixture() -> Path:
    """Select the highest parent generation like the Node snapshot harness."""
    files = [path for path in SCENARIO.glob('session*.jsonl') if _fixture_version(path.name) >= 0]
    assert files, 'the scenario owns no parent transcript'
    return max(files, key=lambda path: _fixture_version(path.name))


def scenario_inputs() -> tuple[str, str]:
    """Derive the caller task and the recorded wake from the committed transcript."""
    rows = [json.loads(line) for line in scenario_fixture().read_text(encoding='utf-8').splitlines() if line]
    assert rows[0]['type'] == 'session'
    body = rows[1:]
    start = next(index for index, row in enumerate(body) if row['type'] == 'turn/start')
    closing = next(index for index, row in enumerate(body) if row['type'] == 'turn/end')
    spliced = [
        row['data']['inserted'][0]['content'][0]['text']
        for row in body[:start]
        if row['type'] == 'agent/inbox/spliced' and row['data']['inserted']
    ]
    assert len(spliced) == 1
    wake = next(
        row['data']['content'][0]['text']
        for row in body[closing + 1:]
        if row['type'] == 'user/message' and row['data']['source']['kind'] == 'user'
    )
    return spliced[0], wake


def _texts(blocks: list[dict[str, Any]]) -> list[str]:
    return [block['text'] for block in blocks if block['type'] == 'text']


def project(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarize turns, admitted caller text, requests, and replies per turn."""
    turns: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for event in events:
        kind = event['type']
        if kind == 'turn/start':
            current = {
                'turn': event['data']['turn'],
                'steps': [],
                'user_texts': [],
                'requests': 0,
                'assistant_texts': [],
                'reason': None,
            }
        elif kind == 'turn/end' and current is not None:
            current['reason'] = event['data']['reason']['kind']
            turns.append(current)
            current = None
        elif current is not None and kind == 'step/start':
            current['steps'].append(event['data']['step'])
        elif current is not None and kind == 'user/message' and event['data']['source']['kind'] == 'user':
            current['user_texts'].extend(_texts(event['data']['content']))
        elif current is not None and kind == 'request/header':
            current['requests'] += 1
        elif current is not None and kind == 'assistant/message':
            current['assistant_texts'].extend(_texts(event['data']['message']['content']))
    return {'turns': turns}


@pytest.mark.skipif(
    shutil.which('node') is None or not BINARY.exists(),
    reason='requires Node and the built dsh profile runtime',
)
def test_first_step_wake_snapshot(tmp_path: Path) -> None:
    node = shutil.which('node')
    assert node is not None
    task, wake = scenario_inputs()
    home = tmp_path / 'home'
    with DeepSeekHarness(
        cwd=str(tmp_path),
        env={'DSH_HOME': str(home), 'DSH_TELEMETRY_DISABLED': '1', 'DSH_SNAPSHOT': 'replay'},
        provider='deepseek-account',
        model='deepseek-v4-flash',
        _launch_args=(node, str(BINARY), '--profile', 'sdk', '--patch', str(PATCH)),
    ) as harness:
        with harness.client.subscribe_session_notifications(SESSION_ID) as subscription:
            first = harness.client.session_prompt(SESSION_ID, [{'type': 'text', 'text': task}])
            second = harness.client.session_prompt(SESSION_ID, [{'type': 'text', 'text': wake}])
            harness.client.request(
                'session/wait', {'sessionId': SESSION_ID}, response_model=_EmptyResponse,
            )
            wire = []
            subscription.drain(wire.append)
    assert first and second and first != second

    wire_events = [
        notification.payload['event']
        for notification in wire
        if notification.method == 'session.event' and notification.payload['sessionId'] == SESSION_ID
    ]
    persisted = sorted((home / 'sessions').rglob('*.jsonl'))
    assert len(persisted) == 1
    durable_lines = persisted[0].read_text(encoding='utf-8').splitlines()
    assert json.loads(durable_lines[0])['type'] == 'session'
    durable_events = [json.loads(line) for line in durable_lines[1:] if line]
    assert project(wire_events) == project(durable_events)

    expected = Path(__file__).with_name('expected') / 'first-step-wake.json'
    assert project(wire_events) == json.loads(expected.read_text(encoding='utf-8'))
