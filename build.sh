#!/bin/bash
# Сборка hostsgen-ui: программа-помощник и SSH-клиент под три процессора Keenetic и архивы для установки
# через веб-интерфейс (папка install на накопителе OPKG).
#   dist/install/hostsgen-ui-{mipsel,mips,aarch64}.tar.gz — по архиву на процессор, пути внутри относительно /opt
# Нужны: node (тесты веб-модулей), zig (кросс-компиляция C со статическим musl), python3, curl.
set -euo pipefail
cd "$(dirname "$0")"

# zig 0.17.0 из официального архива обычно лежит в ~/tools (см. CLAUDE.md)
if ! command -v zig >/dev/null; then
	for dir in "$HOME"/tools/zig-*/; do [ -x "$dir/zig" ] && PATH="$dir:$PATH"; done
fi
command -v zig >/dev/null || { echo "нет zig в PATH" >&2; exit 1; }

node --test tests/*.test.js

BIN=dist/bin
CACHE=.cache
rm -rf dist
mkdir -p "$BIN" dist/install "$CACHE"

# mipsel — MT7621 (Giga KN-1010/1011 и др.), mips — EcoNet (DSL-модели), aarch64 — MT7981/MT7622/MT7988.
# На MIPS у Keenetic нет FPU: собираем с программной плавающей точкой.
BUILDS="mipsel:mipsel-linux-musleabi:-msoft-float mips:mips-linux-musleabi:-msoft-float aarch64:aarch64-linux-musl:"

for build in $BUILDS; do
	IFS=: read -r arch target extra <<<"$build"
	zig cc -target "$target" $extra -Os -s -static -Wall -Wextra -Werror \
		-o "$BIN/hostsgen-ui.$arch" helper/hostsgen-ui.c
done

# SSH-клиент dbclient из dropbear: в прошивке dropbear есть только сервер. Исходники — с сайта автора,
# SHA-256 сверен с ним и с Alpine Linux; сборка под каждый процессор кэшируется в .cache.
DROPBEAR=2026.94
DROPBEAR_SHA256=e098034a843699200c8c977a991fff73159735bf795d5f72ef672c41a6b1ae81
sha256() { python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"; }
for build in $BUILDS; do
	IFS=: read -r arch target extra <<<"$build"
	out=$CACHE/dbclient-$DROPBEAR.$arch
	if [ ! -x "$out" ]; then
		if [ ! -d "$CACHE/dropbear-$DROPBEAR" ]; then
			tarball=$CACHE/dropbear-$DROPBEAR.tar.bz2
			[ -f "$tarball" ] || curl -fsSL -o "$tarball" "https://matt.ucc.asn.au/dropbear/releases/dropbear-$DROPBEAR.tar.bz2"
			if [ "$(sha256 "$tarball")" != "$DROPBEAR_SHA256" ]; then
				echo "dropbear-$DROPBEAR.tar.bz2: не совпал SHA-256" >&2
				rm -f "$tarball"
				exit 1
			fi
			tar -xjf "$tarball" -C "$CACHE"
		fi
		work=$CACHE/dbclient-build.$arch
		rm -rf "$work"
		mkdir -p "$work"
		cp tools/dropbear-localoptions.h "$work/localoptions.h"
		echo "сборка dbclient ($arch)…"
		if ! (cd "$work" && "../dropbear-$DROPBEAR/configure" --host="${target/musleabi/musl}" --enable-static \
			--disable-zlib --disable-syslog --disable-lastlog --disable-utmp --disable-utmpx --disable-wtmp \
			--disable-wtmpx --disable-loginfunc --disable-pututline --disable-pututxline --enable-bundled-libtom \
			CC="zig cc -target $target $extra" AR="zig ar" RANLIB="zig ranlib" \
			CFLAGS="-Os -ffunction-sections -fdata-sections" LDFLAGS="-s -Wl,--gc-sections" &&
			make -j8 PROGRAMS=dbclient STATIC=1) >"$work/build.log" 2>&1; then
			tail -20 "$work/build.log" >&2
			exit 1
		fi
		cp "$work/dbclient" "$out"
		rm -rf "$work"
	fi
	cp "$out" "$BIN/dbclient.$arch"
done

# Веб-модули встраиваются одним скриптом: сначала общая часть, на которую опираются остальные
cat web/common.js web/addon.js web/vps.js >dist/addon.js

# Архив под каждый процессор. Прошивка запускает initrc и вообще скрипты из /opt только через /opt/bin/sh,
# лежащую в /opt, — обычно её привозит Entware. Без Entware её даёт наш архив: ссылку на помощник своего
# процессора (helper/hostsgen-ui.c, sh_mode). Только ссылкой: обычный файл npkg пишет сквозь существующую
# ссылку и затёр бы busybox Entware; ссылку Entware sh → busybox помощник возвращает при первом запуске.
for build in $BUILDS; do
	IFS=: read -r arch target extra <<<"$build"
	pkg=dist/pkg-$arch
	mkdir -p "$pkg/bin" "$pkg/etc/init.d" "$pkg/share/hostsgen-ui/bin"
	ln -s "/opt/share/hostsgen-ui/bin/hostsgen-ui.$arch" "$pkg/bin/sh"
	cp "$BIN/hostsgen-ui.$arch" "$BIN/dbclient.$arch" "$pkg/share/hostsgen-ui/bin/"
	cp dist/addon.js server/vps-setup.sh "$pkg/share/hostsgen-ui/"
	cp "$CACHE/dropbear-$DROPBEAR/LICENSE" "$pkg/share/hostsgen-ui/LICENSE.dropbear"
	cp router/S99hostsgen-ui "$pkg/etc/init.d/"
	cp router/initrc "$pkg/etc/"
	chmod 755 "$pkg/etc/initrc" "$pkg/etc/init.d/S99hostsgen-ui" "$pkg"/share/hostsgen-ui/bin/*
	chmod 644 "$pkg/share/hostsgen-ui/addon.js" "$pkg/share/hostsgen-ui/vps-setup.sh" "$pkg/share/hostsgen-ui/LICENSE.dropbear"
	# не tar из macOS: его заголовки распаковщик прошивки отвергает (подробности в tools/pack.py)
	python3 -I tools/pack.py "$pkg" "dist/install/hostsgen-ui-$arch.tar.gz"
done

ls -l "$BIN" dist/install
