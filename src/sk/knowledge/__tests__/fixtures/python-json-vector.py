import json, hashlib, sys
raw = r'''{"sections": [{"sid": "s1", "title": "Why letters? — \"quoted\"", "blocks": [{"type": "paragraph", "text": "Tab\there\nnew\u0001ctl \u007f del   ls / slash 😀 emoji العربية", "n": 1.0, "e": 1e-05, "big": 1e16, "f": 0.1, "nz": -0.0, "huge": 1.5e300, "i": 12345678901234567890, "mz": -0, "x": 2.50, "y": 1E3, "z": 123.456e-2}]}], "exercises": [{"xid": "x1", "￿": 1, "😀": 2, "B": 3, "a": 4, "é": 5, "answer": "7", "worked_solution": "x = 7"}], "ignored": true}'''
ch = json.loads(raw)
s = json.dumps({"sections": ch["sections"], "exercises": ch["exercises"]}, sort_keys=True, ensure_ascii=False)
sys.stdout.buffer.write((json.dumps({"raw": raw, "dumps": s, "sha": hashlib.sha256(s.encode("utf-8")).hexdigest()}, ensure_ascii=True)).encode())
