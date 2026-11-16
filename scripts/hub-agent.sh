#!/bin/sh
# 허브를 macOS launchd 에이전트로 등록한다. 로그인할 때 켜지고, 죽거나 재시작 요청으로 끝나면 launchd가 다시 띄운다.
# 사용법: scripts/hub-agent.sh install | uninstall | status
set -eu
LABEL=com.figma-mcp.hub
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$ROOT/packages/server/dist/index.cjs"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    NODE=$(command -v node)
    [ -f "$SCRIPT" ] || { echo "먼저 pnpm build 하세요: $SCRIPT 없음" >&2; exit 1; }
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.figma-mcp"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$SCRIPT</string><string>--hub</string><string>--stay</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>StandardOutPath</key><string>$HOME/.figma-mcp/hub.log</string>
  <key>StandardErrorPath</key><string>$HOME/.figma-mcp/hub.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "등록함: $PLIST"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "해제함"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" || echo "등록 안 됨"
    ;;
  *)
    echo "사용법: $0 install | uninstall | status" >&2
    exit 2
    ;;
esac
