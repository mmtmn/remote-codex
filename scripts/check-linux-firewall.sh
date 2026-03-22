#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"

echo "Remote Codex Linux firewall check"
echo "Host: ${HOST}"
echo "Port: ${PORT}"
echo

if [[ "${HOST}" == "127.0.0.1" || "${HOST}" == "localhost" || "${HOST}" == "::1" ]]; then
  echo "Relay is configured for loopback-only access."
  echo "No UFW or iptables opening is needed for this mode."
  exit 0
fi

echo "Relay is configured for non-loopback access."
echo "You need the port to be open in the local firewall and any upstream NAT/security group."
echo

if command -v ss >/dev/null 2>&1; then
  echo "Listening TCP sockets on ${PORT}:"
  ss -ltn "( sport = :${PORT} )" || true
  echo
fi

if command -v ufw >/dev/null 2>&1; then
  echo "ufw status:"
  if status_output="$(ufw status numbered 2>/dev/null)"; then
    printf '%s\n' "${status_output}"
  else
    echo "  unable to inspect ufw without elevated privileges"
  fi
  echo
  echo "Suggested ufw command if you intend to expose this relay:"
  echo "  sudo ufw allow ${PORT}/tcp"
  echo
else
  echo "ufw not installed."
  echo
fi

if command -v iptables >/dev/null 2>&1; then
  echo "iptables INPUT rules mentioning port ${PORT}:"
  if iptables -S INPUT 2>/dev/null | grep -E -- "--dport ${PORT}\\b" >/dev/null; then
    iptables -S INPUT 2>/dev/null | grep -E -- "--dport ${PORT}\\b" || true
  else
    echo "  no INPUT rule for tcp/${PORT} was found, or root privileges are required to inspect all rules."
  fi
  echo
  echo "Suggested iptables command if you intend to expose this relay:"
  echo "  sudo iptables -I INPUT -p tcp --dport ${PORT} -j ACCEPT"
  echo "  # persist that rule with your distro's firewall tooling"
  echo
else
  echo "iptables not installed."
  echo
fi

echo "If remote devices still cannot connect, also check:"
echo "- your router or cloud security group"
echo "- whether the relay is really bound to ${HOST}:${PORT}"
echo "- whether you should be using TLS/reverse proxy instead of a raw public ws endpoint"
