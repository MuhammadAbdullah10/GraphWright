"""Start Graphwright on http://localhost:8000 and open it in the browser."""
import argparse
import threading
import webbrowser

import uvicorn

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    url = f"http://localhost:{args.port}"
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f"Graphwright running at {url}  (Ctrl+C to stop)")
    uvicorn.run("app.main:app", host=args.host, port=args.port, log_level="warning")
