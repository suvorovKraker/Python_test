import socket
import sys

import uvicorn

PORT = 8000


def is_port_busy(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex(("127.0.0.1", port)) == 0


if __name__ == "__main__":
    if is_port_busy(PORT):
        print(f"\n  Ошибка: порт {PORT} уже занят.")
        print("  Скорее всего, сервер уже запущен в другом окне PyCharm/терминале.")
        print(f"  Откройте сайт: http://127.0.0.1:{PORT}")
        print(f"  Или остановите старый процесс: lsof -ti:{PORT} | xargs kill -9\n")
        sys.exit(1)

    uvicorn.run("app.main:app", host="0.0.0.0", port=PORT, reload=True)
