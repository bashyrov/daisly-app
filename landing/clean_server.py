from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parent
PORT = 4180


class CleanUrlHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        redirect_target = self.clean_redirect_target()
        if redirect_target:
            self.send_response(308)
            self.send_header("Location", redirect_target)
            self.end_headers()
            return

        super().do_GET()

    def do_HEAD(self):
        redirect_target = self.clean_redirect_target()
        if redirect_target:
            self.send_response(308)
            self.send_header("Location", redirect_target)
            self.end_headers()
            return

        super().do_HEAD()

    def clean_redirect_target(self):
        parts = urlsplit(self.path)
        path = parts.path
        clean_path = path

        if clean_path.endswith("/index.html"):
            clean_path = clean_path[:-10] or "/"
        elif clean_path.endswith(".html"):
            clean_path = clean_path[:-5]
        elif clean_path != "/" and clean_path.endswith("/"):
            clean_path = clean_path.rstrip("/")

        if clean_path == path:
            return None

        return urlunsplit(("", "", clean_path, parts.query, ""))

    def translate_path(self, path):
        translated = Path(super().translate_path(path))
        if translated.exists():
            return str(translated)

        parts = urlsplit(path)
        clean_path = parts.path.strip("/")
        if clean_path and "." not in Path(clean_path).name:
            html_file = ROOT / f"{clean_path}.html"
            if html_file.exists():
                return str(html_file)

        return str(translated)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), CleanUrlHandler)
    print(f"Serving Daisly at http://127.0.0.1:{PORT}/")
    server.serve_forever()
