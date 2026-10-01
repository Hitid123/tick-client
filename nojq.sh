# Degraded path, sourced by statusline.sh when jq is unavailable or failed.
# Sets DISPLAY and TICKLINE. Same contract: never fail, never touch the network.
#
# This parser is deliberately dumb. It is correct for the flat, machine-generated
# JSON Claude Code emits and for our own state files, and nothing else.

_tick_str() {
  # $1 = json text, $2 = key -> first string value, or empty
  printf '%s' "$1" | tr -d '\n' \
    | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -1 \
    | awk '{ gsub(/\\u[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]/, "");
             gsub(/\033\[[0-9;]*[A-Za-z]/, "");
             gsub(/\[[0-9;]*m/, "");
             print }' \
    | tr -d '\\"' | tr -c '[:print:]' ' ' | sed 's/[[:space:]]*$//'
}
_tick_num() {
  printf '%s' "$1" | tr -d '\n' \
    | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
    | head -1
}

_tick_now=$(( $(date +%s) * 1000 ))
_tick_sid=$(_tick_str "$STDIN_JSON" session_id)
_tick_model=$(_tick_str "$(printf '%s' "$STDIN_JSON" \
  | sed -n 's/.*"model"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p')" id)
_tick_api=$(_tick_num "$STDIN_JSON" total_api_duration_ms); : "${_tick_api:=0}"
_tick_dur=$(_tick_num "$STDIN_JSON" total_duration_ms);     : "${_tick_dur:=0}"

_tick_cid=null
_tick_text=''
if [ -f "$CUR" ]; then
  _tick_cur=$(cat "$CUR" 2>/dev/null)
  _tick_exp=$(_tick_num "$_tick_cur" expires_at); : "${_tick_exp:=0}"
  if [ "$_tick_exp" -gt "$_tick_now" ]; then
    _tick_text=$(_tick_str "$_tick_cur" text)
    _tick_c=$(_tick_str "$_tick_cur" creative_id)
    [ -n "$_tick_c" ] && _tick_cid="\"$_tick_c\""
  fi
fi

if [ -z "$_tick_text" ] && [ -f "$CFG" ]; then
  _tick_text=$(_tick_str "$(cat "$CFG" 2>/dev/null)" own_line)
fi
if [ -z "$_tick_text" ] && [ -f "$BAL" ]; then
  _tick_av=$(_tick_num "$(cat "$BAL" 2>/dev/null)" available); : "${_tick_av:=0}"
  if [ "$_tick_av" -gt 0 ]; then
    # SEP comes from statusline.sh and is already ASCII-safe in a C locale.
    _tick_text=$(printf 'TICK %s $%d.%02d' "$SEP" \
      "$(( _tick_av / 1000000 ))" "$(( (_tick_av / 10000) % 100 ))")
  fi
fi

# Truncate to COLUMNS-4 columns, marker included, creative capped at 60.
#
# awk counts bytes in a C locale, so this cuts conservatively short rather than
# long, and iconv drops the half-written codepoint a byte-wise cut can leave at
# the end. Column-accurate fitting lives in the jq path; this one only has to
# avoid producing a wrapped line or a broken glyph.
_tick_fit() {
  awk -v cols="$COLS" -v ell="$ELLIPSIS" '
    { b = cols - 6; if (b > 60) b = 60; if (b < 1) b = 1;
      if (length($0) <= b) print $0; else print substr($0, 1, b - 1) ell }'
}
if command -v iconv >/dev/null 2>&1; then
  DISPLAY=$(printf '%s' "$_tick_text" | _tick_fit 2>/dev/null | iconv -c -f UTF-8 -t UTF-8 2>/dev/null)
else
  DISPLAY=$(printf '%s' "$_tick_text" | _tick_fit 2>/dev/null)
fi

TICKLINE=$(printf '{"ts":%s,"sid":"%s","cid":%s,"api_ms":%s,"dur_ms":%s,"model":"%s"}' \
  "$_tick_now" "$_tick_sid" "$_tick_cid" "$_tick_api" "$_tick_dur" "$_tick_model")
