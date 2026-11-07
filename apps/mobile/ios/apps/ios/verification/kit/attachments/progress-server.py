"""Loopback-only slow receiver for real URLSession upload-progress checks."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import time


class Receiver(BaseHTTPRequestHandler):
    def do_POST(self):
        remaining = int(self.headers['Content-Length'])
        while remaining:
            chunk = self.rfile.read(min(32768, remaining))
            if not chunk:
                return
            remaining -= len(chunk)
            time.sleep(.01)
        time.sleep(.15)
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        try:
            self.wfile.write(b'{}')
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_args):
        pass


server = HTTPServer(('127.0.0.1', 0), Receiver)
print(f'http://127.0.0.1:{server.server_port}/upload', flush=True)
server.serve_forever()
