#!/usr/bin/env python3
"""Mirror official full installers, then atomically publish a local catalog."""
import argparse, datetime, fcntl, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile

REPO = 'Lxiayu/DshCockpit'
PATTERN = re.compile(r'^DshCockpit-[0-9][A-Za-z0-9.]*-(win-x64\.(?:exe|zip)|mac-(?:arm64|x64)\.dmg)$')

def curl(url, output):
    subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error', '--retry', '3',
                    '--connect-timeout', '20', '--max-time', '1800', '--proto', '=https',
                    '--proto-redir', '=https', '-H', 'Accept: application/vnd.github+json',
                    '-H', 'User-Agent: DshCockpit-Release-Mirror', '-o', str(output), url], check=True)

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()

def kind(name):
    if name.endswith('win-x64.exe'): return 'windows'
    if name.endswith('win-x64.zip'): return 'windows-portable'
    if name.endswith('mac-arm64.dmg'): return 'mac'
    return 'mac-intel'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='/www/wwwroot/dshcockpit.site/downloads')
    parser.add_argument('--keep', type=int, default=5, help='Number of recent stable releases listed (old files are retained).')
    args = parser.parse_args()
    root = pathlib.Path(args.root); root.mkdir(parents=True, exist_ok=True)
    # Lock and partial files live OUTSIDE the public download directory.
    state = root.parent.parent / '.dsh-mirror-state'; state.mkdir(mode=0o700, exist_ok=True)
    with (state / 'sync.lock').open('w') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: print('Another synchronization is running.'); return
        with tempfile.TemporaryDirectory(dir=state) as scratch:
            scratch = pathlib.Path(scratch)
            curl(f'https://api.github.com/repos/{REPO}/releases?per_page=50', scratch / 'releases.json')
            releases = json.loads((scratch / 'releases.json').read_text())
            if not isinstance(releases, list): raise ValueError('Invalid GitHub release response')
            releases = sorted((r for r in releases if not r['draft'] and not r['prerelease']), key=lambda r:r['published_at'], reverse=True)[:args.keep]
            catalog = []; failures = []
            for release in releases:
                tag = release['tag_name']
                if not re.fullmatch(r'v?[0-9][A-Za-z0-9._-]*', tag): continue
                files = []
                for asset in release['assets']:
                    name = asset['name']
                    if not PATTERN.fullmatch(name): continue  # excludes slim, blockmap, updater ZIPs
                    url = asset['browser_download_url']
                    if not url.startswith(f'https://github.com/{REPO}/releases/download/'): continue
                    destination = root / tag / name
                    expected = asset.get('digest', '') or ''
                    try:
                        valid = destination.exists() and destination.stat().st_size == asset['size']
                        checksum = digest(destination) if valid else None
                        if expected.startswith('sha256:'): valid = valid and checksum == expected[7:]
                        if not valid:
                            if shutil.disk_usage(root).free < asset['size'] + 1024**3: raise OSError('Less than 1 GiB reserve after download')
                            partial = scratch / name
                            print(f'Downloading {tag}/{name}', flush=True); curl(url, partial)
                            if partial.stat().st_size != asset['size']: raise ValueError('Size mismatch')
                            checksum = digest(partial)
                            if expected.startswith('sha256:') and checksum != expected[7:]: raise ValueError('SHA256 mismatch')
                            destination.parent.mkdir(exist_ok=True)
                            os.replace(partial, destination); destination.chmod(0o644)
                        files.append({'platform':kind(name),'name':name,'url':f'/downloads/{tag}/{name}', 'size':asset['size'],'sha256':checksum})
                    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
                        failures.append(f'{tag}/{name}: {exc}'); print(failures[-1], file=sys.stderr)
                if files:
                    catalog.append({'version':tag,'publishedAt':release['published_at'],'notesUrl':release['html_url'],'assets':files})
            # Never replace a known-good catalog with a partial synchronization.
            if failures or not catalog: raise RuntimeError('Synchronization incomplete; previous catalog remains available')
            payload = {'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'source':f'https://github.com/{REPO}/releases','releases':catalog}
            temporary = scratch / 'index.json'; temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2)+'\n'); temporary.chmod(0o644)
            os.replace(temporary, root / 'index.json')
            print(f'Published {len(catalog)} releases. Existing historical files retained.', flush=True)

if __name__ == '__main__':
    try: main()
    except Exception as exc: print(f'Mirror failed: {exc}', file=sys.stderr); sys.exit(1)
