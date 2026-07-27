#!/bin/zsh
# Cerry 슬랙 봇 상태 점검 (19맥에서 실행 — 보통 26맥의 cerrycheck 가 호출)
#
# "봇이 떠 있다"만으로는 정상 여부를 알 수 없다. 2026-07-27 장애 때 프로세스는
# 멀쩡한데 슬랙 답변만 안 나오는 상태로 반나절 방치됐다. 그래서 실제로 답변을
# 막는 요인(키체인 잠김, 멈춘 자식 프로세스)까지 함께 본다.

LABEL="com.psw95.cerry-slack-bot"
PLIST_TMP="/tmp/cerrycheck-keychain.plist"
LOG_TMP="/tmp/cerrycheck-keychain.log"
PROBLEM=0

print "Cerry 슬랙 봇 상태"
print "──────────────────────────────"

# 1. launchd 등록 + 프로세스
if launchctl list | grep -q "$LABEL"; then
  PID=$(pgrep -f "agents-in-slack/index.js" | head -1)
  if [[ -n "$PID" ]]; then
    print "봇 프로세스    : ✅ 실행 중 (PID $PID)"
  else
    print "봇 프로세스    : ❌ 등록됐지만 안 떠 있음"
    PROBLEM=1
  fi
else
  print "봇 프로세스    : ❌ launchd 등록 없음"
  PROBLEM=1
fi

# 2. 엔드포인트
SESSIONS=$(curl -s --max-time 3 localhost:7391 2>/dev/null)
if [[ -z "$SESSIONS" ]]; then
  print "엔드포인트     : ❌ 응답 없음"
  PROBLEM=1
elif [[ "$SESSIONS" == "활성 세션 없음" ]]; then
  print "엔드포인트     : ✅ 응답 (활성 세션 없음)"
else
  COUNT=$(print -r -- "$SESSIONS" | grep -c .)
  print "엔드포인트     : ✅ 응답 (활성 세션 ${COUNT}개)"
fi

# 3. 키체인 — GUI 세션 컨텍스트에서만 진짜 상태를 알 수 있어 launchd로 확인한다.
#    잠겨 있으면 claude 가 인증 단계에서 무한 대기 → 슬랙이 "생각 중"에서 멈춘다.
cat > "$PLIST_TMP" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>com.psw95.cerrycheck-kc</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/security</string>
		<string>show-keychain-info</string>
		<string>$HOME/Library/Keychains/login.keychain-db</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>StandardOutPath</key><string>$LOG_TMP</string>
	<key>StandardErrorPath</key><string>$LOG_TMP</string>
</dict>
</plist>
EOF
: > "$LOG_TMP"
launchctl bootstrap "gui/$(id -u)" "$PLIST_TMP" 2>/dev/null
sleep 3
KC=$(cat "$LOG_TMP" 2>/dev/null)
launchctl bootout "gui/$(id -u)/com.psw95.cerrycheck-kc" 2>/dev/null
rm -f "$PLIST_TMP" "$LOG_TMP"

if [[ "$KC" == *"Keychain"* && "$KC" != *"interaction is not allowed"* ]]; then
  print "키체인         : ✅ 해제됨"
  KC_LOCKED=0
else
  print "키체인         : ❌ 잠김 — 슬랙 답변이 안 나옵니다"
  KC_LOCKED=1
  PROBLEM=1
fi

# 4. 멈춘 자식 프로세스 (키체인 잠김의 전형적 증상)
STUCK=$(pgrep -f "claude-agent-sdk-darwin-x64" 2>/dev/null | grep -c .)
if [[ "$STUCK" -eq 0 ]]; then
  print "멈춘 프로세스  : ✅ 없음"
else
  print "멈춘 프로세스  : ⚠️  ${STUCK}개 쌓여 있음"
  PROBLEM=1
fi

print "──────────────────────────────"

if [[ "$PROBLEM" -eq 0 ]]; then
  print "정상입니다. 슬랙에서 바로 쓰면 됩니다."
else
  print "조치가 필요합니다:"
  [[ "$KC_LOCKED" -eq 1 ]] && print "  1. VNC 로그인 → Finder ⌘K → vnc://100.116.55.41"
  print "  2. 아래 명령으로 정리 (26맥에서):"
  print "     cerryfix"
fi
