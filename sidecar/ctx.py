"""Read context usage (used/limit tokens) of the most recently active Antigravity conversation.
Prints JSON. Uses reverse-engineered protobuf layout of gen_metadata: field1 -> field9 -> field10 {1: used, 4: limit}."""
import sqlite3, glob, os, json, sys

def rv(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1; r |= (c & 0x7f) << s; s += 7
        if c < 0x80: return r, i

def fields(b):
    i = 0
    while i < len(b):
        k, i = rv(b, i); f, w = k >> 3, k & 7
        if w == 0: v, i = rv(b, i)
        elif w == 2:
            l, i = rv(b, i); v = b[i:i + l]; i += l
        elif w == 1: v = b[i:i + 8]; i += 8
        elif w == 5: v = b[i:i + 4]; i += 4
        else: raise ValueError
        yield f, v

def get(b, f):
    for k, v in fields(b):
        if k == f: return v

def usage(d):
    try:
        x = get(d, 1); x = get(x, 9); x = get(x, 10)
        return get(x, 1), get(x, 4)
    except Exception:
        return None

def latest(cid=None):
    home = os.path.expanduser('~/.gemini')
    dbs = [p for p in glob.glob(os.path.join(home, 'antigravity*', 'conversations', '*.db'))]
    if cid:
        dbs = [p for p in dbs if os.path.basename(p)[:-3] == cid]
    dbs.sort(key=lambda p: max(os.path.getmtime(p), os.path.getmtime(p + '-wal') if os.path.exists(p + '-wal') else 0), reverse=True)
    for p in dbs:
        try:
            c = sqlite3.connect('file:' + p.replace(os.sep, '/') + '?mode=ro', uri=True)
            for (d,) in c.execute('select data from gen_metadata order by idx desc limit 40'):
                u = usage(d)
                if u and u[0] and u[1]:
                    st = c.execute('select status from steps order by idx desc limit 1').fetchone()
                    return {'id': os.path.basename(p)[:-3], 'used': u[0], 'limit': u[1], 'status': st[0] if st else None}
        except Exception:
            continue

if __name__ == '__main__':
    sys.stdout.write(json.dumps(latest(sys.argv[1] if len(sys.argv) > 1 else None) or {}))
