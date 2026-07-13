import socket
import subprocess


def _is_wifi_lan_ip(ip: str) -> bool:
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        octets = [int(p) for p in parts]
    except ValueError:
        return False
    if octets[0] == 192 and octets[1] == 168:
        return True
    if octets[0] == 172 and 16 <= octets[1] <= 31:
        return True
    if octets[0] == 10 and octets[1] != 8:
        return True
    return False


def get_local_ip() -> str:
    for iface in ("en0", "en1", "en2", "en3"):
        try:
            result = subprocess.run(
                ["ipconfig", "getifaddr", iface],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            )
            ip = result.stdout.strip()
            if ip and _is_wifi_lan_ip(ip):
                return ip
        except (OSError, subprocess.SubprocessError):
            continue

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("192.168.1.1", 80))
            ip = sock.getsockname()[0]
            if _is_wifi_lan_ip(ip):
                return ip
    except OSError:
        pass

    return "127.0.0.1"
