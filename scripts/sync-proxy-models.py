#!/usr/bin/env python3
# Brings the OpenCode Go models of the model proxy (CLIProxyAPI, see Decision 14) up to date: which models it
# offers, and how hard each one can think. Run it when Go adds or retires models.
#
# It asks OpenCode for Go's catalog (`opencode models opencode-go --refresh --verbose`, which first fetches the
# latest one from models.dev). A model the catalog marks as `@ai-sdk/openai-compatible` goes in. Any other model is
# sent a one-token message on the proxy's OpenAI-style endpoint, and goes in only when it answers there. Each model's
# levels are the `variants` the catalog names. A model Go no longer has is taken out.
#
# It changes only the `models` of the proxy's `opencode-go` entry, which has to be there already (with Go's address
# and key). The file is written in place, so the running proxy notices and reloads it by itself.
#
#   See what would change:  scripts/sync-proxy-models.py --dry-run
#   Change it:              scripts/sync-proxy-models.py
#
# --config points at another config file (default: ~/.config/cli-proxy-api/config.yaml).
import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import yaml

ENTRY = 'opencode-go'
OPENAI_STYLE = '@ai-sdk/openai-compatible'


# Go's models as OpenCode lists them: the id without the `opencode-go/` in front, and what OpenCode knows of it.
# The list is an id on a line of its own, followed by that model's details as JSON.
def catalog():
    listed = subprocess.run(
        ['opencode', 'models', ENTRY, '--refresh', '--verbose'], capture_output=True, text=True, check=True
    ).stdout
    decoder = json.JSONDecoder()
    models, rest = {}, listed.strip()
    while rest:
        name, rest = rest.split('\n', 1)
        details, end = decoder.raw_decode(rest.lstrip())
        rest = rest.lstrip()[end:].strip()
        models[name.strip().removeprefix(f'{ENTRY}/')] = details
    return models


# Whether Go answers this model on its OpenAI-style endpoint, the one the proxy uses. Gives back why not, or None.
# Go wants a session id, which the proxy normally copies from Claude's request. Here there is no request to copy.
def refused(entry, model):
    headers = {key: value for key, value in (entry.get('headers') or {}).items() if not str(value).startswith('$')}
    headers |= {
        'authorization': f"Bearer {entry['api-key-entries'][0]['api-key']}",
        'content-type': 'application/json',
        'x-opencode-session': 'acocrew-sync-proxy-models',
    }
    body = {'model': model, 'max_tokens': 1, 'messages': [{'role': 'user', 'content': 'hi'}]}
    request = urllib.request.Request(f"{entry['base-url']}/chat/completions", json.dumps(body).encode(), headers)
    try:
        urllib.request.urlopen(request, timeout=60).read()
        return None
    except urllib.error.HTTPError as err:
        return f'{err.code}: {err.read().decode()[:120]}'
    except OSError as err:
        return str(err)


def main():
    parser = argparse.ArgumentParser(description="Bring the model proxy's OpenCode Go models up to date.")
    parser.add_argument('--config', type=Path, default=Path.home() / '.config/cli-proxy-api/config.yaml')
    parser.add_argument('--dry-run', action='store_true', help='only say what would change')
    args = parser.parse_args()

    config = yaml.safe_load(args.config.read_text())
    entry = next((e for e in config.get('openai-compatibility') or [] if e.get('name') == ENTRY), None)
    if not entry:
        sys.exit(f'{args.config} has no openai-compatibility entry named {ENTRY}. Add one with Go\'s address and key.')

    models, skipped = [], []
    for name, details in sorted(catalog().items()):
        why = None if details['api']['npm'] == OPENAI_STYLE else refused(entry, name)
        if why:
            skipped.append(f'{name} ({why})')
            continue
        levels = list(details.get('variants') or {})
        models.append({'name': name, 'alias': name, 'thinking': {'levels': levels}})

    before = {model['name']: (model.get('thinking') or {}).get('levels') for model in entry.get('models') or []}
    after = {model['name']: model['thinking']['levels'] for model in models}
    for name in sorted(after.keys() - before.keys()):
        print(f'+ {name} {after[name]}')
    for name in sorted(before.keys() - after.keys()):
        print(f'- {name}')
    for name in sorted(after.keys() & before.keys()):
        if after[name] != before[name]:
            print(f'~ {name} {before[name]} -> {after[name]}')
    for line in skipped:
        print(f'  skipped {line}')
    print(f'{len(models)} models.')
    if args.dry_run or after == before:
        return print('Nothing written.' if args.dry_run else 'Already up to date.')

    entry['models'] = models
    # In place, so the file stays the same file and the proxy's watcher sees the change.
    with args.config.open('r+') as file:
        file.write(yaml.safe_dump(config, sort_keys=False, allow_unicode=True))
        file.truncate()
    print(f'Written to {args.config}. The proxy reloads it by itself.')


if __name__ == '__main__':
    main()
