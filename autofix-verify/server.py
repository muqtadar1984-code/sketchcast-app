import http.server, threading
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', 0)); self.rfile.read(n)
        self.send_response(401); self.send_header('content-type','application/json'); self.end_headers()
        self.wfile.write(b'{"error":"Unauthorized."}')
    def log_message(self, *a): pass
s = http.server.HTTPServer(('127.0.0.1', 41999), H)
threading.Thread(target=s.serve_forever, daemon=True).start()
import time; time.sleep(30)
