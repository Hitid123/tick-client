#!/bin/sh
# TICK status line.
#
# Contract (TZ section 2, 4.1):
#   - no network, ever;
#   - no business logic: read state, print, append tick;
#   - target runtime < 30 ms;
#   - ALWAYS exit 0, otherwise Claude Code leaves the line blank.
#
# Reads Claude Code session JSON on stdin. Only these fields are touched:
#   session_id, model.id, cost.total_api_duration_ms, cost.total_duration_ms
# Nothing else is read, stored or forwarded.

TICK_HOME="${TICK_HOME:-$HOME/.tick}"
STATE="$TICK_HOME/state"
CUR="$STATE/current.json"
CFG="$TICK_HOME/config.json"
BAL="$STATE/balance.json"
TICKS="$STATE/ticks.ndjson"
PIDF="$STATE/daemon.pid"
DAEMON="$TICK_HOME/daemon.mjs"

COLS="${COLUMNS:-80}"
case "$COLS" in ''|*[!0-9]*) COLS=80 ;; esac
[ "$COLS" -lt 24 ] && COLS=24

# --- terminal capabilities ---------------------------------------------------
# stdout is a pipe into Claude Code, never a tty, so `[ -t 1 ]` would always say
# "no colour". The environment is the only honest signal we have.

MARKER=$(printf '\342\226\214')   # U+258C, a block cursor — the brand's mark
ELLIPSIS=$(printf '\342\200\246') # U+2026
SEP=$(printf '\302\267')          # U+00B7
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  '') ;;                                   # unset: assume UTF-8, as terminals do
  *UTF-8*|*utf-8*|*UTF8*|*utf8*) ;;
  *) MARKER='|'; ELLIPSIS='~'; SEP='-' ;;  # C, POSIX, ISO-8859-*: stay in ASCII
esac

# Three levels in one line, from the brand guide. The whole scheme in a sentence:
# the marker is a disclosure and stays quiet, the offer arrives bright and settles
# one step down after two seconds, and the promo code is the only coloured thing
# on the line.
#
#   marker            #5F5C57  ANSI 59   muted always
#   offer, 0-2 s      #F0EEE9  ANSI 255  full brightness as the line changes
#   offer, after      #A8A49E  ANSI 248  one step down, and then never again
#   promo code        #FFB000  ANSI 214  bold, the single accent
#
# NO_COLOR is honoured as specified at no-color.org; TERM=dumb has no SGR at all.
COLOR=1
if [ -n "${NO_COLOR+set}" ]; then
  COLOR=0
else
  case "${TERM:-}" in
    dumb|'') COLOR=0 ;;
  esac
fi

MARK_ON=''; TEXT_FRESH=''; TEXT_SETTLED=''; PROMO_ON=''; COLOR_OFF=''
if [ "$COLOR" -eq 1 ]; then
  MARK_ON=$(printf '\033[38;5;59m')
  TEXT_FRESH=$(printf '\033[38;5;255m')
  TEXT_SETTLED=$(printf '\033[38;5;248m')
  PROMO_ON=$(printf '\033[1;38;5;214m')
  COLOR_OFF=$(printf '\033[0m')
fi

# OSC 8 hyperlinks are officially supported in the status line. Terminals that do
# not implement them skip the sequence, so this is on unless we are clearly not
# talking to a terminal, or the user turned it off in config.json.
LINKS=1
case "${TERM:-}" in dumb|'') LINKS=0 ;; esac

emit() {
  # $1 = visible text, already fitted. $2 = click URL, may be empty.
  # $3 = "1" for the first two seconds of this offer, "0" afterwards.
  #
  # The fade happens once per offer and does not repeat. There is movement
  # exactly when the line changed, and it is gone the moment it has been read.
  # Blinking text would be noticed every second forever, which is how a status
  # line becomes the reason somebody uninstalls.
  if [ -z "$1" ]; then
    printf '\n'
    return
  fi
  if [ "$LINKS" -eq 1 ] && [ -n "$2" ]; then
    # \033]8;;URL\a TEXT \033]8;;\a  — the URL is invisible and costs no width.
    printf '%s%s%s \033]8;;%s\a%s%s%s\033]8;;\a\n' \
      "$MARK_ON" "$MARKER" "$COLOR_OFF" "$2" "$TEXT_ON" "$1" "$COLOR_OFF"
  else
    printf '%s%s%s %s%s%s\n' \
      "$MARK_ON" "$MARKER" "$COLOR_OFF" "$TEXT_ON" "$1" "$COLOR_OFF"
  fi
}

STDIN_JSON=$(cat 2>/dev/null)

DISPLAY=''
CLICK_URL=''
PROMO=''
FRESH='0'
TICKLINE=''

if command -v jq >/dev/null 2>&1; then
  # --rawfile aborts jq when the path is missing, so guard every input.
  f_cur=/dev/null; [ -f "$CUR" ] && f_cur="$CUR"
  f_cfg=/dev/null; [ -f "$CFG" ] && f_cfg="$CFG"
  f_bal=/dev/null; [ -f "$BAL" ] && f_bal="$BAL"

  OUT=$(printf '%s' "$STDIN_JSON" | jq -r \
    --argjson cols "$COLS" \
    --arg ell "$ELLIPSIS" \
    --arg sep "$SEP" \
    --rawfile cur "$f_cur" \
    --rawfile cfg "$f_cfg" \
    --rawfile bal "$f_bal" \
    '
    # Visible length must ignore ANSI SGR sequences (TZ 4.3).
    # One pass for both escape families: OSC (hyperlink, window title, clipboard)
    # and CSI/SGR (colour). Stripping must happen before the control-character
    # sweep, or an OSC payload survives as visible text once its escape becomes
    # a space. Combined into a single gsub because `clean` runs on four fields on
    # every refresh, and the 30 ms budget is the whole reason this file exists.
    def strip_escapes:
      gsub("\\e(\\][^\\a\\e]*(\\a|\\e\\\\)|\\[[0-9;]*[A-Za-z])"; "");
    def clean: (. // "") | tostring | strip_escapes | gsub("[[:cntrl:]]"; " ");
    # Only our own http(s) links are ever emitted, and never with a quote or a
    # control character in them.
    def safe_url:
      (. // "") | tostring
      | if test("^https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$") then . else "" end;

    # Terminal columns, not codepoints: CJK and emoji occupy two cells, and
    # combining marks and variation selectors occupy none. Getting this wrong
    # wraps the status line onto a second row, which looks like a crash.
    def cw:
      if   (. >= 768   and . <= 879)    then 0   # combining diacriticals
      elif (. >= 8203  and . <= 8207)   then 0   # zero width space .. RLM
      elif (. >= 65024 and . <= 65039)  then 0   # variation selectors
      elif (. >= 4352   and . <= 4447)
        or (. >= 11904  and . <= 12350)
        or (. >= 12353  and . <= 13311)
        or (. >= 13312  and . <= 19903)
        or (. >= 19968  and . <= 40959)
        or (. >= 40960  and . <= 42191)
        or (. >= 44032  and . <= 55203)
        or (. >= 63744  and . <= 64255)
        or (. >= 65072  and . <= 65135)
        or (. >= 65280  and . <= 65376)
        or (. >= 65504  and . <= 65510)
        or (. >= 127744 and . <= 128591)
        or (. >= 128640 and . <= 128767)
        or (. >= 129280 and . <= 129535)
        or (. >= 131072 and . <= 262141)
      then 2 else 1 end;
    def width: explode | map(cw) | add // 0;

    # Marker plus its space is two columns; the creative itself caps at 60.
    def budget: ($cols - 4 - 2) as $b
                | (if $b > 60 then 60 elif $b < 1 then 1 else $b end);
    def fit:
      . as $t | budget as $b
      | if ($t | width) <= $b then $t
        else
          ($ell | width) as $ew
          | reduce ($t | explode)[] as $c ([0, [], false];
              if .[2] then .
              elif (.[0] + ($c | cw)) <= ($b - $ew) then [.[0] + ($c | cw), .[1] + [$c], false]
              else [.[0], .[1], true] end)
          | (.[1] | implode) + $ell
        end;

    def money: (. / 10000 | floor) as $c
               | ((($c / 100) | floor | tostring) + "."
                  + ((($c % 100) | tostring) | if length < 2 then "0" + . else . end));

    (now * 1000 | floor) as $now
    | (if type == "object" then . else {} end) as $in
    | (try ($cur | fromjson) catch null) as $c
    | (try ($cfg | fromjson) catch null) as $g
    | (try ($bal | fromjson) catch null) as $b
    | (if ($c | type) == "object" and (($c.expires_at // 0) > $now) then $c else null end) as $live
    | (if $live != null and (($live.text | clean | length) > 0)
       then [ (if ($live.creative_id // null) == null then null
               else ($live.creative_id | tostring) end),
              ($live.text | clean) ]
       else
         # Fallback order (TZ 4.4): own line, then balance, then nothing.
         (($g.own_line? // "") | clean) as $own
         | (($b.available? // 0) | if type == "number" then . else 0 end) as $av
         | if ($own | length) > 0 then [null, $own]
           elif $av > 0 then [null, "TICK " + $sep + " $" + ($av | money)]
           else [null, ""] end
       end) as $out

    | ($out[1] | fit),
      (if $live != null then ($live.click_url | safe_url) else "" end),
      # The promo code, so the one actionable word can be picked out of the line.
      (if $live != null then ($live.promo_code // "" | clean) else "" end),
      # How recently this creative arrived: 1 for the first two seconds, then 0.
      # The script already knows how long the current offer has been up, so the
      # shade comes out of that number — no network call, no second process.
      (if $live == null then "0"
       else (if ($now - ($live.shown_at // 0)) < 2000 then "1" else "0" end)
       end),
      ({ ts: $now,
         sid: ($in.session_id | clean),
         cid: $out[0],
         api_ms: (($in.cost?.total_api_duration_ms // 0)
                  | if type == "number" then . else 0 end),
         dur_ms: (($in.cost?.total_duration_ms // 0)
                  | if type == "number" then . else 0 end),
         model: ($in.model?.id | clean) } | tojson)
    ' 2>/dev/null)

  if [ -n "$OUT" ]; then
    { IFS= read -r DISPLAY; IFS= read -r CLICK_URL; IFS= read -r PROMO
      IFS= read -r FRESH; IFS= read -r TICKLINE; } <<OUT_EOF
$OUT
OUT_EOF
  fi
fi

if [ -z "$TICKLINE" ] && [ -f "$TICK_HOME/nojq.sh" ]; then
  # jq missing or failed: degraded pure-shell path (TZ 3).
  . "$TICK_HOME/nojq.sh" 2>/dev/null
fi

# The shade of the offer text, picked from how long it has been up.
TEXT_ON=''
if [ "$COLOR" -eq 1 ]; then
  if [ "$FRESH" = "1" ]; then TEXT_ON="$TEXT_FRESH"; else TEXT_ON="$TEXT_SETTLED"; fi
fi

# A promo code is the one word in the line a reader can act on, so it is the one
# word that gets its own colour, and the only coloured thing on the line. Unlike
# the arrival fade it stays: the code is still useful on the fifth minute.
# Substitution is plain parameter expansion, so a code that got truncated away
# simply is not found and nothing happens.
if [ -n "$PROMO" ] && [ "$COLOR" -eq 1 ]; then
  case "$DISPLAY" in
    *"$PROMO"*)
      _pre=${DISPLAY%%"$PROMO"*}
      _post=${DISPLAY#*"$PROMO"}
      # Closing with the prevailing shade rather than a reset, or the promo
      # punches a hole in the rest of the line and everything after it goes
      # back to the terminal's own colour.
      DISPLAY="$_pre$PROMO_ON$PROMO$TEXT_ON$_post"
      ;;
  esac
fi

emit "$DISPLAY" "$CLICK_URL" "$FRESH"

# --- append tick -------------------------------------------------------------
if [ -n "$TICKLINE" ]; then
  [ -d "$STATE" ] || mkdir -p "$STATE" 2>/dev/null
  # 2 MB means the daemon is dead and the backlog is stale anyway (TZ 4.1).
  SZ=0
  [ -f "$TICKS" ] && SZ=$(wc -c <"$TICKS" 2>/dev/null | tr -d ' ')
  case "$SZ" in ''|*[!0-9]*) SZ=0 ;; esac
  [ "$SZ" -gt 2097152 ] && : >"$TICKS" 2>/dev/null
  printf '%s\n' "$TICKLINE" >>"$TICKS" 2>/dev/null
fi

# --- keep the daemon alive, never wait for it --------------------------------
alive=0
if [ -f "$PIDF" ]; then
  pid=$(tr -d ' \n' <"$PIDF" 2>/dev/null)
  case "$pid" in
    ''|*[!0-9]*) alive=0 ;;
    *) kill -0 "$pid" 2>/dev/null && alive=1 ;;
  esac
fi
if [ "$alive" -eq 0 ] && [ -f "$DAEMON" ] && command -v node >/dev/null 2>&1; then
  nohup node "$DAEMON" >>"$STATE/daemon.log" 2>&1 </dev/null &
fi

exit 0
