"""Run the existing validator with loopback-only HTTP and redirect checks."""
import runpy
import sys
import urllib.request
import urllib.parse
from pathlib import Path

base = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4174'
origin = urllib.parse.urlparse(base)
if origin.scheme != 'http' or origin.hostname not in ('127.0.0.1', 'localhost', '::1') or origin.username or origin.password:
    raise RuntimeError('Offline validation requires a loopback HTTP URL')

def check(url):
    parsed = urllib.parse.urlparse(url)
    if (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc):
        raise RuntimeError('External request blocked before network')

class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirect())
def guarded_open(request, *args, **kwargs):
    check(request.full_url if isinstance(request, urllib.request.Request) else request)
    return opener.open(request, *args, **kwargs)

urllib.request.urlopen = guarded_open
sys.argv = ['validate_build.py', base]
runpy.run_path(str(Path(__file__).resolve().parents[1] / 'audit' / 'validate_build.py'), run_name='__main__')
