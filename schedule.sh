#!/bin/bash
# Usage: ./schedule.sh [--claude|--gemini|--openai] <enable|disable> [HH:MM | YYYY-MM-DD HH:MM | +Nm]
set -euo pipefail

label=""; action=""; time_args=()
for arg in "$@"; do
  case "$arg" in
    --claude|--gemini|--openai) label="${arg#--}" ;;
    enable|disable) action="$arg" ;;
    *) time_args+=("$arg") ;;
  esac
done
# Default target is the single token-gated worker (wrangler.toml). The provider flags
# still target the legacy per-provider workers during the transition.
config="${label:+wrangler.${label}.toml}"; config="${config:-wrangler.toml}"
name="${label:-api-proxy}"
time_arg="${time_args[*]:-}"

[[ "$action" =~ ^(enable|disable)$ ]] || {
  echo "Usage: ./schedule.sh [--claude|--gemini|--openai] <enable|disable> [HH:MM | YYYY-MM-DD HH:MM | +Nm]"; exit 1
}

[[ "$action" == "enable" ]] && from=false to=true || from=true to=false
dir=$(cd "$(dirname "$0")" && pwd)

if [[ -z "$time_arg" ]]; then
  sed -i '' "s/workers_dev = $from/workers_dev = $to/" "$dir/$config"
  grep -q "workers_dev = $to" "$dir/$config" || { echo "ERROR: sed failed"; exit 1; }
  cd "$dir" && nubx wrangler deploy --config "$config"
  exit 0
fi

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

logfile="/tmp/${name}-schedule.log"

cat > "/tmp/${name}-scheduled.sh" <<SCRIPT
sleep $delay
sed -i '' 's/workers_dev = $from/workers_dev = $to/' "$dir/$config"
grep -q "workers_dev = $to" "$dir/$config" || { echo "ERROR: sed failed"; exit 1; }
cd "$dir" && nubx wrangler deploy --config "$config"
SCRIPT

nohup bash "/tmp/${name}-scheduled.sh" > "$logfile" 2>&1 &
echo "Scheduled $name $action in $((delay/3600))h $(( (delay%3600)/60 ))m (PID: $!)"
echo "  Cancel: kill $!  |  Logs: cat $logfile"
