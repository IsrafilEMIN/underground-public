/^(not )?ok [0-9]+ - / {
  inerror = 0
  failed = ($0 ~ /^not ok/)
  name = $0
  sub(/^(not )?ok [0-9]+ - /, "", name)
  if (!failed && name !~ /^\[mac\] /) { detail = 0; next }
  reason = ""
  state = failed ? "fail" : "pass"
  if (match(name, / # SKIP/)) {
    reason = substr(name, RSTART + 8)
    name = substr(name, 1, RSTART - 1)
    state = "skip"
  }
  sub(/^\[mac\] /, "", name)
  printf "  %s  %s\n", state, name
  if (reason != "") printf "        %s\n", reason
  detail = failed
  shown = 0
  next
}

detail && /^  error: / {
  value = $0
  sub(/^  error: /, "", value)
  if (value ~ /^\|/) inerror = 1
  else { gsub(/^'|'$/, "", value); printf "        %s\n", value; detail = 0 }
  next
}

inerror && /^    / {
  if (shown < 3 && $0 !~ /^ *$/) { line = $0; sub(/^    /, "", line); printf "        %s\n", line; shown++ }
  next
}

inerror { inerror = 0; detail = 0 }
