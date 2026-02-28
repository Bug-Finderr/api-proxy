#!/bin/bash
# Usage: ./schedule.sh [--gemini] <enable|disable> <HH:MM | YYYY-MM-DD HH:MM | +Nm>
set -euo pipefail

config="wrangler.claude.toml"; label="claude"
[[ "${1:-}" == "--gemini" ]] && config="wrangler.gemini.toml" label="gemini" && shift

action=${1:-}; shift || true; time_arg="${*:-}"
[[ "$action" =~ ^(enable|disable)$ && -n "$time_arg" ]] || {
  echo "Usage: ./schedule.sh [--gemini] <enable|disable> <HH:MM | YYYY-MM-DD HH:MM | +Nm>"; exit 1
}

[[ "$action" == "enable" ]] && from=false to=true || from=true to=false
dir=$(cd "$(dirname "$0")" && pwd)
now=$(date +%s)

if [[ "$time_arg" =~ ^\+([0-9]+)m$ ]]; then
  delay=$((BASH_REMATCH[1] * 60))
elif [[ "$time_arg" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2} ]]; then
  target=$(date -j -f "%Y-%m-%d %H:%M" "$time_arg" +%s)
  delay=$((target - now))
  (( delay <= 0 )) && { echo "Error: date is in the past"; exit 1; }
else
  target=$(date -j -f "%Y-%m-%d %H:%M" "$(date +%Y-%m-%d) $time_arg" +%s)
  delay=$(( (target - now + 86400) % 86400 ))
fi

logfile="/tmp/${label}-proxy-schedule.log"

cat > "/tmp/${label}-proxy-scheduled.sh" <<SCRIPT
sleep $delay
sed -i '' 's/workers_dev = $from/workers_dev = $to/' "$dir/$config"
grep -q "workers_dev = $to" "$dir/$config" || { echo "ERROR: sed failed"; exit 1; }
cd "$dir" && bunx wrangler deploy --config "$config"
SCRIPT

nohup bash "/tmp/${label}-proxy-scheduled.sh" > "$logfile" 2>&1 &
echo "Scheduled $label $action in $((delay/3600))h $(( (delay%3600)/60 ))m (PID: $!)"
echo "  Cancel: kill $!  |  Logs: cat $logfile"
