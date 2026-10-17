#!/bin/bash
# iepl-whitelist 服务端安装脚本。
#
# 用法（在服务器上以 root 运行，需要 systemd 与 Python 3.8+）：
#   sudo ./install.sh
#
# 可选环境变量（不设置则交互询问）：
#   UPSTREAM_URL      IEPL 白名单 API 的完整地址
#   UPSTREAM_API_KEY  API Key（只写入服务器上权限 600 的文件）
#   DOMAIN            你的同步服务域名，仅用于在结尾打印 Caddy 配置片段
#
# 它会做什么：
#   1. 把 server.py / stats.py 放到 /opt/iepl-whitelist
#   2. 在 /etc/iepl-whitelist 生成 upstream.env 与 token.env（权限 600，首次随机生成 token）
#   3. 安装并启动 systemd 服务 iepl-whitelist
# 它不会做什么：不安装也不修改 Caddy / nginx，只在最后打印要加的配置片段。
#
# 重复运行是安全的：已有的配置与 token 会保留，只更新程序文件并重启服务。
set -euo pipefail

NAME=iepl-whitelist
APP_DIR=/opt/$NAME
ETC_DIR=/etc/$NAME
UNIT_DIR=/etc/systemd/system
PREFIX="${PREFIX:-}"                # 仅用于测试：把所有文件装到该前缀目录下
SKIP_SYSTEMD="${SKIP_SYSTEMD:-}"    # 仅用于测试：跳过 systemctl
SRC="$(cd "$(dirname "$0")" && pwd)"

die() { echo "错误: $*" >&2; exit 1; }

[ -n "$PREFIX" ] || [ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo ./install.sh"
command -v python3 >/dev/null || die "未找到 python3"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || die "需要 Python 3.8 或更高版本"
if [ -z "$SKIP_SYSTEMD" ]; then command -v systemctl >/dev/null || die "未找到 systemctl（需要 systemd）"; fi

T_APP="$PREFIX$APP_DIR"
T_ETC="$PREFIX$ETC_DIR"
T_UNIT="$PREFIX$UNIT_DIR"
mkdir -p "$T_APP" "$T_ETC" "$T_UNIT"
chmod 700 "$T_ETC"

echo "[1/3] 安装程序文件 -> $APP_DIR"
install -m 644 "$SRC/server.py" "$T_APP/server.py"
install -m 644 "$SRC/stats.py" "$T_APP/stats.py"

echo "[2/3] 生成配置 -> $ETC_DIR"
if [ -f "$T_ETC/upstream.env" ] && [ -z "${UPSTREAM_URL:-}${UPSTREAM_API_KEY:-}" ]; then
  echo "      保留已有的 upstream.env"
else
  [ -n "${UPSTREAM_URL:-}" ] || read -r -p "      IEPL 白名单 API 完整地址: " UPSTREAM_URL || true
  [ -n "${UPSTREAM_API_KEY:-}" ] || { read -r -s -p "      API Key（输入不回显）: " UPSTREAM_API_KEY || true; echo; }
  [ -n "${UPSTREAM_URL:-}" ] && [ -n "${UPSTREAM_API_KEY:-}" ] || die "API 地址和 API Key 都不能为空（也可用环境变量 UPSTREAM_URL / UPSTREAM_API_KEY 传入）"
  # 值会写进双引号里，systemd 会处理反斜杠转义，所以这几个字符一律不允许
  for v in "$UPSTREAM_URL" "$UPSTREAM_API_KEY"; do
    case "$v" in
      *\"* | *\\* | *$'\n'*) die "API 地址 / API Key 里不能包含双引号、反斜杠或换行" ;;
    esac
  done
  ( umask 077; printf 'UPSTREAM_URL="%s"\nUPSTREAM_API_KEY="%s"\n' "$UPSTREAM_URL" "$UPSTREAM_API_KEY" > "$T_ETC/upstream.env" )
fi

NEW_TOKEN=""
if [ ! -f "$T_ETC/token.env" ]; then
  NEW_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
  ( umask 077; printf 'CLIENT_TOKEN=%s\n' "$NEW_TOKEN" > "$T_ETC/token.env" )
else
  echo "      保留已有的 token.env（token 不变）"
fi
chmod 600 "$T_ETC/upstream.env" "$T_ETC/token.env"

echo "[3/3] 安装 systemd 服务 $NAME"
sed -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@ETC_DIR@#$ETC_DIR#g" "$SRC/$NAME.service" > "$T_UNIT/$NAME.service"
if [ -z "$SKIP_SYSTEMD" ]; then
  systemctl daemon-reload
  systemctl enable "$NAME" >/dev/null 2>&1
  systemctl restart "$NAME"
  sleep 1
  if ! systemctl is-active --quiet "$NAME"; then
    journalctl -u "$NAME" --no-pager -n 15 || true
    die "服务没有成功启动，请查看上面的日志"
  fi
  if command -v curl >/dev/null; then
    # 请求来自本机回环时服务端会信任 X-Real-IP，这里借此做一次自检（不访问上游）
    out="$(curl -s --max-time 5 -H 'X-Real-IP: 203.0.113.7' http://127.0.0.1:8787/ip || true)"
    case "$out" in
      *203.0.113.7*) echo "      自检通过：服务已在 127.0.0.1:8787 正常响应" ;;
      *) echo "      ⚠️ 自检没有拿到预期响应（$out）；若你改过 PORT，可忽略，否则请查看日志" ;;
    esac
  fi
else
  echo "      （已跳过 systemctl）"
fi

DOMAIN_SHOWN="${DOMAIN:-YOUR_DOMAIN}"
cat <<EOF

================================ 安装完成 ================================
下一步：

1. 把下面的站点块加到 Caddy 配置（/etc/caddy/Caddyfile）并重载（systemctl reload caddy）。
   DNS 只配 A 记录指向本机；也可使用 Caddyfile.example。

   $DOMAIN_SHOWN {
   	encode gzip
   	reverse_proxy 127.0.0.1:8787 {
   		header_up X-Real-IP {remote_host}
   	}
   }

2. 验证（应返回你当前的公网 IP）：
   curl https://$DOMAIN_SHOWN/ip

3. 在 Stash 覆写里填写：api = https://$DOMAIN_SHOWN ，token = 见下
EOF
if [ -n "$NEW_TOKEN" ]; then
  cat <<EOF

   本次新生成的 token（只显示这一次，请妥善保存，不要外传）：
   $NEW_TOKEN
EOF
else
  echo
  echo "   token 保存在 $ETC_DIR/token.env（root 可读）。"
fi
echo "============================================================================"
