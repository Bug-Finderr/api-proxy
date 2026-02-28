#!/bin/bash
# Usage: ./schedule.sh <enable|disable> <HH:MM | +Nm>
set -euo pipefail

action=${1:-}; time_arg=${2:-}
[[ "$action" =~ ^(enable|disable)$ && -n "$time_arg" ]] || {
  echo "Usage: ./schedule.sh <enable|disable> <HH:MM | +Nm>"; exit 1
}

[[ "$action" == "enable" ]] && from=false to=true || from=true to=false
dir=$(cd "$(dirname "$0")" && pwd)

if [[ "$time_arg" =~ ^\+([0-9]+)m$ ]]; then
  delay=$((BASH_REMATCH[1] * 60))
else
  target=$(date -j -f "%Y-%m-%d %H:%M" "$(date +%Y-%m-%d) $time_arg" +%s)
  delay=$(( (target - $(date +%s) + 86400) % 86400 ))
fi

cat > /tmp/claude-proxy-scheduled.sh <<SCRIPT
sleep $delay
sed -i '' 's/workers_dev = $from/workers_dev = $to/' "$dir/wrangler.toml"
grep -q "workers_dev = $to" "$dir/wrangler.toml" || { echo "ERROR: sed failed"; exit 1; }
cd "$dir" && bunx wrangler deploy
SCRIPT

nohup bash /tmp/claude-proxy-scheduled.sh > /tmp/claude-proxy-disable.log 2>&1 &
echo "Scheduled $action in $((delay/3600))h $(( (delay%3600)/60 ))m (PID: $!)"
echo "  Cancel: kill $!  |  Logs: cat /tmp/claude-proxy-disable.log"
