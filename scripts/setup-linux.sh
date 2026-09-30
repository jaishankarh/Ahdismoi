#!/usr/bin/env bash
# One-time setup for Ricky's computer control on Linux.
#   X11:      installs xdotool + a screenshot tool.
#   Wayland:  installs ydotool + a screenshot tool, and runs ydotoold as a user service
#             with access to /dev/uinput (needs sudo once, then a log out / log in).
# Safe to re-run.
set -euo pipefail

session="${XDG_SESSION_TYPE:-}"
if [[ -z "$session" && -n "${WAYLAND_DISPLAY:-}" ]]; then session="wayland"; fi
session="${session:-x11}"
echo "Detected session type: $session"

if command -v apt-get >/dev/null; then
  PM="apt"
elif command -v dnf >/dev/null; then
  PM="dnf"
elif command -v pacman >/dev/null; then
  PM="pacman"
elif command -v zypper >/dev/null; then
  PM="zypper"
else
  PM=""
fi

install() {
  case "$PM" in
    apt) sudo apt-get update -qq && sudo apt-get install -y "$@" ;;
    dnf) sudo dnf install -y "$@" ;;
    pacman) sudo pacman -S --needed --noconfirm "$@" ;;
    zypper) sudo zypper install -y "$@" ;;
    *) echo "Unknown package manager. Please install manually: $*"; return 1 ;;
  esac
}

# Keyring so Electron can encrypt saved API keys (most desktops already have one).
if ! pgrep -x gnome-keyring-d >/dev/null && ! pgrep -x kwalletd5 >/dev/null && ! pgrep -x kwalletd6 >/dev/null; then
  echo "Note: no system keyring is running. Saved API keys will only be obfuscated."
  echo "      Install gnome-keyring (GNOME) or KWallet (KDE), or keep keys in .env.local."
fi

if [[ "$session" == "wayland" ]]; then
  echo "Installing ydotool and a screenshot tool…"
  case "$PM" in
    apt) install ydotool gnome-screenshot || true; install grim || true ;;
    dnf) install ydotool gnome-screenshot grim || true ;;
    pacman) install ydotool grim || true ;;
    zypper) install ydotool grim || true ;;
  esac

  if ! command -v ydotool >/dev/null; then
    echo "ydotool is not available from your package manager. Build it from https://github.com/ReimuNotMoe/ydotool and re-run this script."
    exit 1
  fi

  echo "Giving your user access to /dev/uinput (needed by ydotoold)…"
  sudo groupadd -f input
  sudo usermod -aG input "$USER"
  echo 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' | sudo tee /etc/udev/rules.d/80-ricky-uinput.rules >/dev/null
  sudo modprobe uinput || true
  echo uinput | sudo tee /etc/modules-load.d/ricky-uinput.conf >/dev/null
  sudo udevadm control --reload-rules && sudo udevadm trigger || true

  echo "Setting up ydotoold as a user service…"
  mkdir -p "$HOME/.config/systemd/user"
  YDOTOOLD="$(command -v ydotoold || echo /usr/bin/ydotoold)"
  cat >"$HOME/.config/systemd/user/ydotoold.service" <<EOF
[Unit]
Description=ydotool daemon (used by Ricky computer control)

[Service]
ExecStart=$YDOTOOLD --socket-path=%t/.ydotool_socket --socket-own=%U:%G
Restart=on-failure

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now ydotoold.service || true

  # Point ydotool at the user socket for every login shell and for Ricky.
  PROFILE_LINE='export YDOTOOL_SOCKET="$XDG_RUNTIME_DIR/.ydotool_socket"'
  if ! grep -qF "$PROFILE_LINE" "$HOME/.profile" 2>/dev/null; then
    echo "$PROFILE_LINE" >>"$HOME/.profile"
  fi
  mkdir -p "$HOME/.config/environment.d"
  echo 'YDOTOOL_SOCKET=${XDG_RUNTIME_DIR}/.ydotool_socket' >"$HOME/.config/environment.d/ydotool.conf"

  echo
  echo "Done. Log out and back in (so the 'input' group and YDOTOOL_SOCKET apply), then start Ricky."
else
  echo "Installing xdotool and a screenshot tool…"
  case "$PM" in
    apt) install xdotool scrot ;;
    dnf) install xdotool scrot ;;
    pacman) install xdotool scrot ;;
    zypper) install xdotool scrot ;;
  esac
  echo
  echo "Done. Start Ricky with: npm run dev"
fi
