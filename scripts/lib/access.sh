#!/usr/bin/env bash
# The local access secret, for scripts that call the server (see SECURITY.md).
#
# The server writes its secret, mode 0600, to <support>/access-<port>.token, where <support> is
# FREMKIT_SUPPORT_DIR when that is an absolute path and ~/Library/Application Support/Fremkit
# otherwise; FREMKIT_ACCESS_TOKEN_FILE names the file outright. The secret is never put on a
# command line — any user on the Mac can read another process's arguments with `ps` — so curl is
# handed the header through a file descriptor: `curl -H @<(fremkit_auth_header) …`.
#
# The file is read on every call: each server has its own secret, written once it listens and
# removed when it exits, so a script follows a restart without noticing and sends nothing while no
# server runs.
#
# Source it; every function is quiet and best-effort, printing nothing when there is no secret.

# The port in an http://host:port/… URL, or 4242.
fremkit_port_of() {
    local rest=${1#*://}
    rest=${rest%%/*}
    case "$rest" in
        *:*) printf '%s\n' "${rest##*:}" ;;
        *) printf '4242\n' ;;
    esac
}

# Succeeds when a URL names this machine (127.0.0.1, localhost, [::1]): the only place the secret
# is sent. A user-info part (http://127.0.0.1@example.com) is looked past, not trusted. Other
# spellings of loopback (an IPv6 long form, a decimal IPv4) are not recognised: it fails closed.
fremkit_is_loopback_url() {
    local rest=${1#*://} port=''
    # The authority ends at the first of / \ ? #, whatever follows is not the host (a URL parser
    # reads a backslash as a slash in http and https).
    rest=${rest%%[/\\?#]*}
    rest=${rest##*@}
    local host
    case "$rest" in
        \[*)
            host=${rest%%]*}]
            port=${rest#*]}
            case "$port" in '') ;; :*) port=${port#:} ;; *) return 1 ;; esac
            ;;
        *:*) host=${rest%%:*}; port=${rest#*:} ;;
        *) host=$rest ;;
    esac
    # A port is empty or digits up to 65535; anything else is no URL a client would connect to.
    case "$port" in *[!0-9]*) return 1 ;; esac
    port=${port#"${port%%[!0]*}"}
    [ "${#port}" -le 5 ] && [ "${port:-0}" -le 65535 ] || return 1
    # Lower-cased with tr (bash 3.2 on macOS has no ${var,,}), as URL parsing does.
    host=$(printf '%s' "$host" | tr 'A-Z' 'a-z')
    case "$host" in
        127.0.0.1|localhost|'[::1]') return 0 ;;
    esac
    return 1
}

# The token file for a port (default 4242).
fremkit_token_file() {
    if [ -n "${FREMKIT_ACCESS_TOKEN_FILE:-}" ]; then
        printf '%s\n' "$FREMKIT_ACCESS_TOKEN_FILE"
        return
    fi
    local support="$HOME/Library/Application Support/Fremkit"
    case "${FREMKIT_SUPPORT_DIR:-}" in /*) support=$FREMKIT_SUPPORT_DIR ;; esac
    printf '%s/access-%s.token\n' "$support" "${1:-4242}"
}

# The `Authorization` header line for a port, or nothing when the file is not there.
fremkit_auth_header() {
    local file token
    file=$(fremkit_token_file "${1:-4242}")
    [ -r "$file" ] || return 0
    IFS= read -r token < "$file" || [ -n "$token" ] || return 0
    [ -n "$token" ] && printf 'Authorization: Bearer %s\n' "$token"
}

# A one-time link that signs a browser in and lands on $2 (a path, default /).
# $1 is the server's base URL, e.g. http://127.0.0.1:4242, which mints the code. $3 is the origin
# the link is opened on when that is not the server itself (the Vite dev server, which proxies
# /auth): the cookie belongs to the host the browser sees. Prints nothing on failure, and nothing
# for a base that is not this machine: the secret goes to loopback only, as the hooks send it.
fremkit_auth_url() {
    local base=${1%/} next=${2:-/} page=${3:-$1} port answer code
    fremkit_is_loopback_url "$base" || return 1
    port=$(fremkit_port_of "$base")
    answer=$(curl --silent --fail --max-time 3 -X POST -H @<(fremkit_auth_header "$port") "$base/api/auth/code") || return 1
    code=$(printf '%s' "$answer" | sed -n 's/.*"code":"\([A-Za-z0-9_-]*\)".*/\1/p')
    [ -n "$code" ] || return 1
    # The path goes in the query string: escape what would end it or split it.
    next=$(printf '%s' "$next" | sed 's/%/%25/g; s/&/%26/g; s/#/%23/g; s/?/%3F/g; s/+/%2B/g; s/ /%20/g')
    printf '%s/auth?code=%s&next=%s\n' "${page%/}" "$code" "$next"
}
